import "server-only";
import { grantAttention, grantPromotions, lastRevocationAt } from "@/lib/consent";
import type { IngestResult } from "@/lib/inbound";
import {
  isAcknowledgement,
  isAffirmative,
  isNegative,
  isOptInMessage,
  isPromoOptInMessage,
  OPT_IN_REPLY,
  OPTED_OUT_WROTE_REASON,
  PROMO_REPLY,
  REASK_COOLDOWN_MS,
  REOPT_QUESTION,
} from "@/lib/opt-in";
import { sendBotOptions } from "@/lib/outbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";

export type OptedOutOutcome =
  | "reactivated" // se le quitó la baja y se le confirmó
  | "resume_agent" // aceptó: que el agente conteste lo que había pedido
  | "asked" // se le hizo la pregunta de re-consentimiento
  | "declined" // dijo que no: sigue de baja, sin más mensajes
  | "ignored" // un simple «gracias»
  | "flagged"; // queda «Requiere humano»

type Db = ReturnType<typeof createAdminClient>;

/** Envía un texto fijo al cliente y lo guarda en el hilo como mensaje del bot. */
async function sendAndSave(db: Db, result: IngestResult, text: string) {
  const { data: lead, error } = await db.from("leads").select("phone, bsuid").eq("id", result.leadId).single();
  if (error) throw error;
  const sent = await sendWhatsAppText({ phone: lead.phone ?? null, bsuid: lead.bsuid ?? null }, text);
  const { error: insErr } = await db.from("messages").insert({
    conversation_id: result.conversationId,
    direction: "out",
    sender: "bot",
    content: text,
    wa_message_id: sent.id,
  });
  if (insErr) throw insErr;
}

/** Marca la conversación como pendiente de una persona, sin pisar un motivo anterior que siga vigente. */
async function flag(db: Db, conversationId: string, reason: string) {
  const { error } = await db
    .from("conversations")
    .update({ requires_human: true, handoff_reason: reason })
    .eq("id", conversationId)
    .eq("requires_human", false);
  if (error) throw error;
}

async function clearFlag(db: Db, conversationId: string) {
  await db.from("conversations").update({ requires_human: false, handoff_reason: null }).eq("id", conversationId);
}

/**
 * Escribe alguien que se dio de baja. El bot NO le manda mensajes por su cuenta (respeta la baja), pero tampoco se
 * ignora a quien escribe:
 *  - «ALTA» o «PROMO» → autorización expresa: se reactiva y se le confirma con un texto fijo.
 *  - Si escribe otra cosa → el bot responde UNA vez pidiendo su autorización (REOPT_QUESTION). Un «sí» inmediatamente
 *    después reactiva y el agente contesta lo que había pedido; «no» lo deja de baja.
 *  - Un simple «gracias», o cualquier mensaje dentro de las 24 h posteriores a la baja, no se contesta: si hace
 *    falta, queda «Requiere humano».
 */
export async function handleOptedOutInbound(result: IngestResult, text: string, waMessageId: string): Promise<OptedOutOutcome> {
  const db = createAdminClient();
  const evidence = { leadId: result.leadId, channel: "whatsapp" as const, evidence: text, waMessageId };

  // 1. Autorización expresa por palabra clave
  if (isPromoOptInMessage(text)) {
    await grantAttention(db, evidence);
    await grantPromotions(db, evidence);
    return confirm(db, result, PROMO_REPLY, "El cliente pidió recibir promociones (PROMO). Ya no está dado de baja; respóndele tú.");
  }
  if (isOptInMessage(text)) {
    await grantAttention(db, evidence);
    return confirm(db, result, OPT_IN_REPLY, "El cliente pidió volver a recibir mensajes (ALTA). Ya no está dado de baja; respóndele tú.");
  }

  // 2. ¿Está contestando a nuestra pregunta de re-consentimiento?
  const { data: lastOut } = await db
    .from("messages")
    .select("content")
    .eq("conversation_id", result.conversationId)
    .eq("direction", "out")
    .order("created_at", { ascending: false })
    .limit(1);
  // El mensaje guardado es la pregunta seguida de las opciones («▫ Sí, acepto…»): se compara el comienzo.
  if (String(lastOut?.[0]?.content ?? "").startsWith(REOPT_QUESTION)) {
    if (isAffirmative(text)) {
      await grantAttention(db, evidence);
      await clearFlag(db, result.conversationId);
      if (result.botActive) return "resume_agent";
      await flag(db, result.conversationId, "El cliente aceptó volver a recibir mensajes. Ya no está dado de baja; respóndele tú.");
      return "reactivated";
    }
    if (isNegative(text)) return "declined";
    if (isAcknowledgement(text)) return "ignored"; // «gracias» suelto: ni acepta ni rechaza
    await flag(db, result.conversationId, OPTED_OUT_WROTE_REASON);
    return "flagged";
  }

  // 3. Acuses simples no merecen atención
  if (isAcknowledgement(text)) return "ignored";

  // 4. Recién se dio de baja, o una persona ya tiene el chat: no se le vuelve a preguntar
  const revoked = await lastRevocationAt(db, result.leadId);
  if ((revoked && Date.now() - revoked.getTime() < REASK_COOLDOWN_MS) || !result.botActive) {
    await flag(db, result.conversationId, OPTED_OUT_WROTE_REASON);
    return "flagged";
  }

  // 5. Se le pregunta UNA vez si autoriza
  try {
    await sendBotOptions(result.conversationId, REOPT_QUESTION, ["Sí, acepto", "No, gracias"], { kind: "consent" });
    return "asked";
  } catch (err) {
    console.error("[baja] no se pudo enviar la pregunta de re-consentimiento", err);
    await flag(db, result.conversationId, OPTED_OUT_WROTE_REASON);
    return "flagged";
  }
}

/** Confirma con un texto fijo si el bot está a cargo; si una persona tiene el chat, se lo deja marcado a ella. */
async function confirm(db: Db, result: IngestResult, reply: string, humanReason: string): Promise<OptedOutOutcome> {
  if (result.botActive) {
    try {
      await sendAndSave(db, result, reply);
      await clearFlag(db, result.conversationId);
      return "reactivated";
    } catch (err) {
      console.error("[baja] no se pudo enviar la confirmación", err);
    }
  }
  await flag(db, result.conversationId, humanReason);
  return "reactivated";
}

/** «PROMO» de un cliente que NO está dado de baja: acepta recibir promociones. */
export async function handlePromoKeyword(result: IngestResult, text: string, waMessageId: string): Promise<void> {
  const db = createAdminClient();
  await grantPromotions(db, { leadId: result.leadId, channel: "whatsapp", evidence: text, waMessageId });
  if (result.botActive) {
    try {
      await sendAndSave(db, result, PROMO_REPLY);
    } catch (err) {
      console.error("[promo] no se pudo enviar la confirmación", err);
    }
  }
}
