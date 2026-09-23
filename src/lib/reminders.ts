import "server-only";
import { cancelAppointment, confirmAppointment } from "@/lib/appointment-ops";
import { env } from "@/lib/env";
import type { IngestResult } from "@/lib/inbound";
import { sendBotTemplate, sendBotText } from "@/lib/outbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatLimaTime } from "@/lib/time";
import { getApprovedTemplate, renderTemplate } from "@/lib/whatsapp/templates";

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Respuestas a un recordatorio que se entienden sin modelo (rápido, gratis y sin margen de error). «2» (reprogramar) lo lleva el agente. */
export const isConfirmReply = (t: string) => /^(1|confirmo|confirmar|confirmada|si confirmo|si|ok|okay|de acuerdo|listo|alli estare|ahi estare|estare alli|asistire|voy)$/.test(norm(t));
export const isCancelReply = (t: string) => /^(3|cancelar|cancelo|cancela mi cita|no podre ir|no voy a poder ir|no asistire|no ire)$/.test(norm(t));

export const CONFIRMED_REPLY = "¡Gracias! Tu cita queda confirmada. ¡Te esperamos! 😊";
export const CANCELLED_REPLY = "Listo, cancelé tu cita. Si quieres reprogramarla, escríbeme cuando gustes y buscamos un nuevo horario.";

const dateText = (d: Date) => new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(d);

/** Texto del recordatorio dentro de la ventana de 24 h. */
export function reminderText(kind: "24h" | "2h", nombre: string | null, start: Date, branch: { nombre: string; direccion: string }): string {
  const first = nombre ? ` ${nombre.split(" ")[0]}` : "";
  if (kind === "2h") {
    return `Hola${first} 👋 Tu evaluación visual gratuita es hoy a las ${formatLimaTime(start)} en ${env.businessName} ${branch.nombre} (${branch.direccion}). ¡Te esperamos! Si no puedes venir, responde *3* para cancelar.`;
  }
  return `Hola${first} 👋 Te recordamos tu evaluación visual gratuita el ${dateText(start)} a las ${formatLimaTime(start)} en ${env.businessName} ${branch.nombre} (${branch.direccion}).\n\nResponde *1* para confirmar, *2* para reprogramar o *3* para cancelar.`;
}

async function flagHuman(conversationId: string, reason: string) {
  await createAdminClient().from("conversations").update({ requires_human: true, handoff_reason: reason }).eq("id", conversationId).eq("requires_human", false);
}

export type ReminderOutcome = "sent" | "skipped" | "needs_human";

/**
 * Envía el recordatorio de una cita. Dentro de la ventana de 24 h va como texto normal; fuera de ella solo se puede con una
 * plantilla APROBADA (Plantillas → recordatorio). Si no hay, queda «Requiere humano» para que alguien avise al cliente.
 */
export async function sendReminder(appointmentId: string, kind: "24h" | "2h"): Promise<ReminderOutcome> {
  const db = createAdminClient();
  const { data: appt, error } = await db
    .from("appointments")
    .select("id, status, scheduled_at, reminder_24h_sent_at, reminder_2h_sent_at, lead_id, leads(nombre, opt_out), branches(nombre, direccion)")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appt || !["agendada", "confirmada"].includes(appt.status as string)) return "skipped";
  const start = new Date(appt.scheduled_at as string);
  if (start.getTime() <= Date.now()) return "skipped";
  if ((kind === "24h" ? appt.reminder_24h_sent_at : appt.reminder_2h_sent_at) != null) return "skipped";
  const lead = appt.leads as unknown as { nombre: string | null; opt_out: boolean };
  const branch = appt.branches as unknown as { nombre: string; direccion: string };
  if (lead.opt_out) return "skipped";

  // Conversación del cliente (las creadas a mano pueden no tenerla aún)
  let { data: conv } = await db.from("conversations").select("id").eq("lead_id", appt.lead_id as string).maybeSingle();
  if (!conv) {
    const { data: created, error: cErr } = await db.from("conversations").insert({ lead_id: appt.lead_id as string }).select("id").single();
    if (cErr) throw cErr;
    conv = created;
  }
  const conversationId = conv!.id as string;

  const { data: lastIn } = await db.from("messages").select("created_at").eq("conversation_id", conversationId).eq("direction", "in").order("created_at", { ascending: false }).limit(1);
  const inWindow = lastIn?.[0] != null && Date.now() - new Date(lastIn[0].created_at as string).getTime() < 23 * 3600_000;
  const meta = { kind: "reminder", appointment_id: appointmentId, reminder: kind };

  if (inWindow) {
    await sendBotText(conversationId, reminderText(kind, lead.nombre, start, branch), meta);
  } else {
    const tpl = await getApprovedTemplate(env.reminderTemplate);
    if (!tpl) {
      await flagHuman(
        conversationId,
        `No se pudo enviar el recordatorio de la cita del ${dateText(start)}: pasaron más de 24 h desde el último mensaje del cliente y no hay una plantilla aprobada. Avísale tú o crea la plantilla en «Plantillas».`,
      );
      return "needs_human";
    }
    const params = [lead.nombre?.split(" ")[0] ?? "", dateText(start), formatLimaTime(start), branch.nombre, branch.direccion];
    await sendBotTemplate(conversationId, tpl.name, tpl.language, params, renderTemplate(tpl.body, params), { ...meta, template: tpl.name });
  }

  await db.from("appointments").update(kind === "24h" ? { reminder_24h_sent_at: new Date().toISOString() } : { reminder_2h_sent_at: new Date().toISOString() }).eq("id", appointmentId);
  return "sent";
}

/**
 * Si el último mensaje nuestro fue un recordatorio y el cliente responde «1» (confirmar) o «3» (cancelar), se atiende aquí,
 * sin llamar al modelo. «2» (reprogramar) y cualquier otra cosa pasan al agente. Devuelve true si ya quedó atendido.
 */
export async function handleReminderReply(result: IngestResult, text: string): Promise<boolean> {
  const confirm = isConfirmReply(text);
  const cancel = !confirm && isCancelReply(text);
  if (!confirm && !cancel) return false;

  const db = createAdminClient();
  const { data: lastOut } = await db.from("messages").select("meta").eq("conversation_id", result.conversationId).eq("direction", "out").order("created_at", { ascending: false }).limit(1);
  const meta = lastOut?.[0]?.meta as { kind?: string; appointment_id?: string } | undefined;
  if (meta?.kind !== "reminder" || !meta.appointment_id) return false;

  const { data: appt } = await db.from("appointments").select("id, status, scheduled_at").eq("id", meta.appointment_id).maybeSingle();
  if (!appt || !["agendada", "confirmada"].includes(appt.status as string) || new Date(appt.scheduled_at as string).getTime() <= Date.now()) return false;

  if (confirm) {
    await confirmAppointment(appt.id as string);
    if (result.botActive) await sendBotText(result.conversationId, CONFIRMED_REPLY, { kind: "confirmation", appointment_id: appt.id });
  } else {
    await cancelAppointment(appt.id as string);
    if (result.botActive) await sendBotText(result.conversationId, CANCELLED_REPLY, { kind: "cancellation", appointment_id: appt.id });
  }
  return true;
}
