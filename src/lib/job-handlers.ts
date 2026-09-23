import "server-only";
import { flagAgentFailure, runAgentJob } from "@/lib/agent";
import { completeText } from "@/lib/agent/llm";
import { notifyAdmins } from "@/lib/alerts";
import { attentionInfo } from "@/lib/attention";
import { hasLiveJob, registerJob } from "@/lib/jobs";
import { processAttachment } from "@/lib/media";
import { sendBotText } from "@/lib/outbound";
import { sendConversionEvent } from "@/lib/capi";
import { env } from "@/lib/env";
import { sendReminder } from "@/lib/reminders";
import { refreshLeadStages } from "@/lib/lead-stage";
import { isAgentEnabled } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { showTyping } from "@/lib/whatsapp/client";

/** Manejadores de la cola de trabajos (ver src/lib/jobs.ts). Se registran al importar este módulo. */

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ── Agente: responde al cliente (con agrupamiento de mensajes y reintentos) ──
registerJob(
  "agent",
  async (payload) => {
    const conversationId = str(payload.conversationId);
    const leadId = str(payload.leadId);
    const db = createAdminClient();

    // Interruptor general: pudo apagarse entre que se encoló la respuesta y ahora.
    if (!(await isAgentEnabled())) return;

    // Si aún se están descargando/transcribiendo medios de este chat, se espera (un audio sin transcribir no tiene texto).
    if (await hasLiveJob("media", conversationId)) return { rescheduleMs: 2500 };

    const { data } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("direction", "in")
      .order("created_at", { ascending: false })
      .limit(1);
    const messageId = data?.[0]?.id as string | undefined;
    if (!messageId) return;
    // El aviso de «escribiendo…» dura 25 s; se renueva ahora, que es cuando empieza lo que puede tardar
    // (consultar el calendario, pensar la respuesta).
    await showTyping(payload.waMessageId ? String(payload.waMessageId) : null);
    await runAgentJob({ conversationId, leadId, messageId });
  },
  async (payload, err) => flagAgentFailure(str(payload.conversationId), err),
);

// ── El tablero al día: quien lleva horas sin contestar pasa a «Sin respuesta»; lo muy viejo se archiva ──
registerJob("lead_stages", async () => {
  const { sinRespuesta, archivados } = await refreshLeadStages();
  if (sinRespuesta || archivados) console.log(`[tablero] ${sinRespuesta} sin respuesta, ${archivados} archivados`);
});

// ── Resumen para la persona que recibe una conversación derivada ──
const SUMMARY_PROMPT = `Preparas el relevo para un asesor de una óptica que va a retomar una conversación de WhatsApp que el asistente virtual derivó.
Escribe en español, como máximo 4 viñetas cortas (empieza cada una con "• "):
• Qué quiere el cliente.
• Datos ya obtenidos (nombre, sucursal, teléfono, horario preferido, promoción de interés) — solo los que consten.
• Por qué se derivó.
• Siguiente paso sugerido.
No inventes datos, no incluyas precios ni diagnósticos. Sin saludo ni cierre.`;

registerJob("handoff_summary", async (payload) => {
  const conversationId = str(payload.conversationId);
  const db = createAdminClient();
  const { data: conv } = await db
    .from("conversations")
    .select("requires_human, handoff_reason, leads(nombre, phone, tags, branches(nombre))")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv?.requires_human) return; // ya lo atendieron

  const { data: rows } = await db
    .from("messages")
    .select("direction, sender, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(20);
  const who = { lead: "Cliente", bot: "Asistente", humano: "Asesor" } as const;
  const transcript = (rows ?? [])
    .reverse()
    .filter((m) => m.content)
    .map((m) => `${who[m.sender as keyof typeof who] ?? m.sender}: ${m.content}`)
    .join("\n");
  if (!transcript) return;

  const lead = conv.leads as unknown as { nombre: string | null; phone: string | null; tags: string[]; branches: { nombre: string } | null } | null;
  const header = `Motivo de la derivación: ${conv.handoff_reason ?? "(sin motivo)"}\nCliente: ${lead?.nombre ?? "sin nombre"} · Sucursal: ${lead?.branches?.nombre ?? "sin definir"} · Teléfono: ${lead?.phone ?? "no visible"}`;
  const summary = await completeText(SUMMARY_PROMPT, `${header}\n\nConversación:\n${transcript}`);
  if (summary) await db.from("conversations").update({ handoff_summary: summary.slice(0, 1200) }).eq("id", conversationId);
});

// ── Escalamiento: nadie atendió una derivación a tiempo ──
registerJob("escalation", async (payload) => {
  const conversationId = str(payload.conversationId);
  const db = createAdminClient();
  const { data: conv } = await db
    .from("conversations")
    .select("requires_human, escalated_at, handoff_reason, leads(nombre, phone, branches(nombre))")
    .eq("id", conversationId)
    .maybeSingle();
  // Si ya no está pendiente (alguien contestó o reactivó el bot) o ya se escaló, no hay nada que hacer.
  if (!conv?.requires_human || conv.escalated_at) return;

  await db.from("conversations").update({ escalated_at: new Date().toISOString() }).eq("id", conversationId);
  const lead = conv.leads as unknown as { nombre: string | null; phone: string | null; branches: { nombre: string } | null } | null;
  await notifyAdmins(
    "Un chat lleva más de 15 minutos sin atender",
    `${lead?.nombre ?? lead?.phone ?? "Un cliente"} (${lead?.branches?.nombre ?? "sin sucursal"}) espera a una persona.\nMotivo: ${conv.handoff_reason ?? "sin motivo"}\n\nAbre el inbox del CRM para atenderlo.`,
  );
});

// ── Seguimiento: UN mensaje a quien dejó de responder, solo dentro de la ventana de 24 h ──
export const followupText = (nombre: string | null) =>
  `Hola${nombre ? ` ${nombre.split(" ")[0]}` : ""} 👋 ¿Sigues interesado en tu evaluación visual gratuita? Cuando quieras, te ayudo a agendar tu cita.`;

registerJob("followup", async (payload) => {
  if (!(await isAgentEnabled())) return;
  const conversationId = str(payload.conversationId);
  const db = createAdminClient();
  const { data: conv } = await db
    .from("conversations")
    .select("bot_active, requires_human, followup_sent_at, leads(nombre, opt_out, stage, archived_at)")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv || !conv.bot_active || conv.requires_human || conv.followup_sent_at) return;
  const lead = conv.leads as unknown as { nombre: string | null; opt_out: boolean; stage: string; archived_at: string | null };
  // Ya cumplió el objetivo (tiene cita) o salió del embudo: no se le insiste.
  if (lead.opt_out || lead.stage === "cita_agendada" || lead.archived_at) return;

  // El último mensaje debe ser del bot (el cliente no contestó) y la ventana de 24 h debe seguir abierta.
  const { data: last } = await db.from("messages").select("direction, sender").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(1);
  if (last?.[0]?.direction !== "out" || last[0].sender !== "bot") return;
  const { data: lastIn } = await db.from("messages").select("created_at").eq("conversation_id", conversationId).eq("direction", "in").order("created_at", { ascending: false }).limit(1);
  const inboundAt = lastIn?.[0] ? new Date(lastIn[0].created_at as string).getTime() : 0;
  if (Date.now() - inboundAt > 23 * 3600_000) return; // ventana cerrada: solo se podría con plantilla aprobada

  // No de noche ni en domingo: se reprograma a la próxima apertura (si aún cabe en la ventana, la revisión de arriba lo decide).
  const att = attentionInfo();
  if (!att.open) return { rescheduleMs: Math.max(60_000, att.nextOpen.getTime() - Date.now()) };

  await sendBotText(conversationId, followupText(lead.nombre), { kind: "followup" });
  await db.from("conversations").update({ followup_sent_at: new Date().toISOString() }).eq("id", conversationId);
});

// ── Medios: descargar, guardar y (notas de voz) transcribir ──
registerJob(
  "media",
  async (payload) => processAttachment(str(payload.messageId), Number(payload.index ?? 0)),
  async (payload) => {
    // Agotados los reintentos: que una persona lo vea (el cliente mandó algo que el sistema no pudo procesar).
    const db = createAdminClient();
    const conversationId = str(payload.conversationId);
    await db.from("messages").update({ content: "[No se pudo procesar un archivo del cliente]" }).eq("id", str(payload.messageId)).eq("content", "");
    await db
      .from("conversations")
      .update({ requires_human: true, handoff_reason: "No se pudo descargar o transcribir un archivo que envió el cliente" })
      .eq("id", conversationId)
      .eq("requires_human", false);
  },
);

// ── Recordatorios de cita (24 h y 2 h antes) ──
registerJob("reminder", async (payload) => {
  // Con el agente apagado no sale NADA automático hacia el cliente, tampoco los recordatorios.
  if (!(await isAgentEnabled())) return;
  const kind = payload.kind === "2h" ? "2h" : "24h";
  await sendReminder(str(payload.appointmentId), kind);
});

// ── Conversión hacia Meta: «este anuncio terminó en una cita» ──
registerJob("capi", async (payload) => {
  if (!env.metaDatasetId) return; // sin conjunto de datos configurado no hay a dónde enviar
  const db = createAdminClient();
  const { data: appt } = await db.from("appointments").select("id, capi_sent_at, leads(ctwa_clid)").eq("id", str(payload.appointmentId)).maybeSingle();
  const clid = (appt?.leads as unknown as { ctwa_clid: string | null } | null)?.ctwa_clid;
  if (!appt || appt.capi_sent_at || !clid) return; // ya enviado, o el lead no vino de un anuncio
  await sendConversionEvent({ eventName: env.capiEventSchedule, ctwaClid: clid });
  await db.from("appointments").update({ capi_sent_at: new Date().toISOString() }).eq("id", appt.id);
});
