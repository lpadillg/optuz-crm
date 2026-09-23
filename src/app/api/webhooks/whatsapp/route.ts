import { after, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ingestInboundMessage, recordDeliveryStatus, recordSendFailure } from "@/lib/inbound";
import { enqueue, kickJobs } from "@/lib/jobs";
import { isPromoOptInMessage } from "@/lib/opt-in";
import { handleOptedOutInbound, handlePromoKeyword } from "@/lib/opted-out";
import { handleReminderReply } from "@/lib/reminders";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAgentEnabled } from "@/lib/settings";
import { showTyping } from "@/lib/whatsapp/client";
import { extractItems, whatsappEnvelopeSchema, type WebhookItem } from "@/lib/whatsapp/types";
import { verifyChallenge, verifyMetaSignature } from "@/lib/whatsapp/verify";

export const runtime = "nodejs";

/**
 * Encola la respuesta del agente. `debounce`: si el cliente sigue escribiendo, se espera a que termine y se responde UNA vez
 * a todo (menos llamadas al modelo y mejores respuestas). Si algo falla, la cola reintenta; no se pierde el mensaje.
 */
async function scheduleAgent(conversationId: string, leadId: string, waMessageId?: string | null) {
  // Interruptor general apagado: el mensaje queda guardado y visible en el inbox, pero nadie responde solo.
  if (!(await isAgentEnabled())) return;
  await enqueue({
    kind: "agent",
    payload: { conversationId, leadId, waMessageId: waMessageId ?? null },
    runAt: new Date(Date.now() + env.agentDebounceMs),
    dedupeKey: `agent:${conversationId}`,
    debounce: true,
  });
  // Mientras se agrupa el mensaje y el agente piensa, el cliente ve «escribiendo…» y sus ✓✓.
  after(async () => {
    await showTyping(waMessageId);
    await kickJobs(env.agentDebounceMs + 300);
  });
}
// El agente IA corre en after(), dentro del tiempo de esta función: margen para varias llamadas al LLM y a Calendar.
export const maxDuration = 60;

/** Verificación del webhook: Meta llama una vez al guardar la URL en el panel de la app (o por API). */
export async function GET(req: Request) {
  const challenge = verifyChallenge(new URL(req.url).searchParams, env.whatsappVerifyToken);
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Webhook de la WhatsApp Cloud API. Meta entrega "al menos una vez" y reintenta si no recibe 200 a tiempo, por eso:
 *  - se verifica X-Hub-Signature-256 sobre los bytes crudos del cuerpo,
 *  - cada mensaje/estado se deduplica por su propio id (Meta no manda id de evento) en `webhook_events`,
 *  - el agente IA corre en `after()`, fuera del plazo de respuesta.
 * Una entrega puede traer varios mensajes; los estados que no son fallos (sent/delivered/read) se ignoran.
 */
export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), env.metaAppSecret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const envelope = whatsappEnvelopeSchema.safeParse(json);
  if (!envelope.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const items = extractItems(envelope.data, env.whatsappPhoneNumberId);
  const db = createAdminClient();
  let processed = 0;
  let duplicates = 0;

  for (const item of items) {
    // Deduplicación: insertar la llave; si ya existe y fue procesada, saltar.
    const { error: dedupeErr } = await db
      .from("webhook_events")
      .insert({ event_id: item.key, event_type: item.kind, payload: item });
    if (dedupeErr) {
      if (dedupeErr.code !== "23505") throw dedupeErr;
      const { data: prev } = await db.from("webhook_events").select("processed_at").eq("event_id", item.key).maybeSingle();
      if (prev?.processed_at) {
        duplicates++;
        continue;
      }
      // Existía pero no terminó de procesarse (fallo previo): se reintenta.
    }

    try {
      const note = await handle(item);
      await db.from("webhook_events").update({ processed_at: new Date().toISOString(), error: note ?? null }).eq("event_id", item.key);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.from("webhook_events").update({ error: message }).eq("event_id", item.key);
      console.error("[whatsapp webhook] error procesando", item.key, err);
      // 500 → Meta reintenta toda la entrega; los ítems ya procesados se saltan por la deduplicación.
      return NextResponse.json({ error: "processing failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, processed, duplicates });
}

/** Devuelve una nota si el ítem se procesó con algo que revisar. */
async function handle(item: WebhookItem): Promise<string | null> {
  if (item.kind === "failure") {
    const found = await recordSendFailure(item.failure);
    return found ? `envío fallido: ${item.failure.reason}` : `envío fallido de una conversación desconocida: ${item.failure.reason}`;
  }

  if (item.kind === "status") {
    const found = await recordDeliveryStatus(item.status.waMessageId, item.status.status);
    return found ? null : "estado de un mensaje que no está guardado";
  }

  const result = await ingestInboundMessage(item.message);

  // Imágenes, notas de voz y documentos: se descargan y guardan aparte (y el audio se transcribe) antes de que responda el agente.
  if (result.isNewMessage && result.messageId) {
    const atts = item.message.attachments as { id?: string }[];
    let queued = false;
    for (let i = 0; i < atts.length; i++) {
      if (!atts[i]?.id) continue;
      await enqueue({ kind: "media", payload: { conversationId: result.conversationId, messageId: result.messageId, index: i } });
      queued = true;
    }
    if (queued) after(() => kickJobs(0));
  }
  // Dado de baja: el bot no responde, pero el mensaje no se ignora (ALTA reactiva; lo demás lo ve una persona).
  if (result.isNewMessage && result.optOut) {
    if (!(await isAgentEnabled())) return "cliente dado de baja escribió (agente apagado)";
    const outcome = await handleOptedOutInbound(result, item.message.text, item.message.waMessageId);
    if (outcome === "resume_agent") await scheduleAgent(result.conversationId, result.leadId, item.message.waMessageId); // aceptó volver: contesta lo que había pedido
    return outcome === "flagged" ? "cliente dado de baja escribió de nuevo" : null;
  }
  // «PROMO»: acepta recibir promociones (consentimiento aparte de la atención).
  if (result.isNewMessage && isPromoOptInMessage(item.message.text) && (await isAgentEnabled())) {
    await handlePromoKeyword(result, item.message.text, item.message.waMessageId);
    return null;
  }
  // «1» confirmar / «3» cancelar a un recordatorio de cita: se atiende directo, sin modelo.
  if (result.isNewMessage && !result.optOut && (await isAgentEnabled())) {
    if (await handleReminderReply(result, item.message.text)) return null;
  }
  // Bot pausado (toma de control humana): se guarda el mensaje y nada más.
  if (result.isNewMessage && result.messageId && result.botActive && !result.optOut) {
    await scheduleAgent(result.conversationId, result.leadId, item.message.waMessageId);
  }
  return null;
}
