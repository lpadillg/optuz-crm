import "server-only";
import { cancelAppointment, confirmAppointment } from "@/lib/appointment-ops";
import { env } from "@/lib/env";
import type { IngestResult } from "@/lib/inbound";
import { sendBotOptions, sendBotTemplate, sendBotText } from "@/lib/outbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatLimaTime } from "@/lib/time";
import { getApprovedTemplate, renderTemplate } from "@/lib/whatsapp/templates";

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Respuestas a un recordatorio que se entienden sin modelo (rápido, gratis y sin margen de error). Cubren
 * tanto los botones («Confirmar», «Cancelar») como lo que la gente escribe a mano. «Reagendar» no está aquí a
 * propósito: buscarle otro horario es una conversación, y esa la lleva el agente. */
export const isConfirmReply = (t: string) => /^(1|confirmo|confirmar|confirmada|si confirmo|si|ok|okay|de acuerdo|listo|alli estare|ahi estare|estare alli|asistire|voy)$/.test(norm(t));
export const isCancelReply = (t: string) => /^(3|cancelar|cancelo|cancela mi cita|no podre ir|no voy a poder ir|no asistire|no ire)$/.test(norm(t));

/**
 * Cancelar es lo único del recordatorio que no tiene vuelta atrás: borra el evento del calendario y suelta el
 * cupo, que otro cliente puede tomar en minutos. Y el botón está justo al lado de los otros dos, así que un
 * toque de más cuesta una cita. Por eso se pregunta antes, y solo a quien pulsa cancelar.
 */
export const CANCEL_CONFIRM_BUTTONS = ["Sí, cancelar", "Mantener la cita"];
export const isCancelYes = (t: string) => /^(si|si cancelar|si cancela|si cancelo|confirmo|correcto|asi es|dale|ok|eso|exacto)$/.test(norm(t));
export const isCancelNo = (t: string) =>
  /^(no|no cancelar|no cancele|mantener la cita|mantenerla|la mantengo|mejor no|no gracias|sigue|si voy|ahi estare)$/.test(norm(t));

export const CONFIRMED_REPLY = "¡Gracias! Tu cita queda confirmada. ¡Te esperamos! 😊";
export const CANCELLED_REPLY = "Listo, cancelé tu cita. Si quieres reprogramarla, escríbeme cuando gustes y buscamos un nuevo horario.";
export const KEPT_REPLY = "¡Perfecto! Tu cita sigue en pie. ¡Te esperamos! 😊";

const dateText = (d: Date) => new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(d);

/** Texto del recordatorio dentro de la ventana de 24 h. Las opciones van en botones, no escritas. */
export function reminderText(kind: "24h" | "2h", nombre: string | null, start: Date, branch: { nombre: string; direccion: string }): string {
  const first = nombre ? ` ${nombre.split(" ")[0]}` : "";
  if (kind === "2h") {
    return `Hola${first} 👋 Tu evaluación visual gratuita es hoy a las ${formatLimaTime(start)} en ${env.businessName} ${branch.nombre} (${branch.direccion}). ¡Te esperamos!`;
  }
  return `Hola${first} 👋 Te recordamos tu evaluación visual gratuita el ${dateText(start)} a las ${formatLimaTime(start)} en ${env.businessName} ${branch.nombre} (${branch.direccion}).`;
}

/**
 * Lo que puede hacer el cliente con su cita, en botones. Pedirle que escriba «1» pierde respuestas: hay que
 * leer la instrucción, volver al teclado y acertar con el número.
 */
export const REMINDER_BUTTONS = ["Confirmar", "Reagendar", "Cancelar"];

async function flagHuman(conversationId: string, reason: string) {
  await createAdminClient().from("conversations").update({ requires_human: true, handoff_reason: reason }).eq("id", conversationId).eq("requires_human", false);
}

export type ReminderOutcome = "sent" | "skipped" | "needs_human";

/**
 * Envía el recordatorio de una cita, con sus tres botones. Dentro de la ventana de 24 h va como mensaje
 * normal; fuera de ella solo se puede con una plantilla APROBADA (Plantillas → recordatorio). Si no hay,
 * queda «Requiere humano» para que alguien avise al cliente.
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
    await sendBotOptions(conversationId, reminderText(kind, lead.nombre, start, branch), REMINDER_BUTTONS, meta);
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
 * Respuestas a un recordatorio que se resuelven sin llamar al modelo: rápido, gratis y sin margen de error.
 * Confirmar se aplica en el acto; cancelar pregunta antes, porque no tiene vuelta atrás. «Reagendar» y
 * cualquier otra cosa pasan al agente. Devuelve true si ya quedó atendido.
 */
export async function handleReminderReply(result: IngestResult, text: string): Promise<boolean> {
  const db = createAdminClient();
  const { data: lastOut } = await db.from("messages").select("meta").eq("conversation_id", result.conversationId).eq("direction", "out").order("created_at", { ascending: false }).limit(1);
  const meta = lastOut?.[0]?.meta as { kind?: string; appointment_id?: string } | undefined;
  if (!meta?.appointment_id || (meta.kind !== "reminder" && meta.kind !== "cancel_confirm")) return false;

  const { data: appt } = await db.from("appointments").select("id, status, scheduled_at").eq("id", meta.appointment_id).maybeSingle();
  if (!appt || !["agendada", "confirmada"].includes(appt.status as string) || new Date(appt.scheduled_at as string).getTime() <= Date.now()) return false;
  const start = new Date(appt.scheduled_at as string);

  // Segundo paso: ya se le preguntó si de verdad quiere cancelar.
  if (meta.kind === "cancel_confirm") {
    if (isCancelNo(text)) {
      if (result.botActive) await sendBotText(result.conversationId, KEPT_REPLY, { kind: "kept", appointment_id: appt.id });
      return true;
    }
    if (!isCancelYes(text)) return false; // dijo otra cosa: que lo lea el agente
    await cancelAppointment(appt.id as string);
    if (result.botActive) await sendBotText(result.conversationId, CANCELLED_REPLY, { kind: "cancellation", appointment_id: appt.id });
    return true;
  }

  if (isConfirmReply(text)) {
    await confirmAppointment(appt.id as string);
    if (result.botActive) await sendBotText(result.conversationId, CONFIRMED_REPLY, { kind: "confirmation", appointment_id: appt.id });
    return true;
  }

  if (isCancelReply(text)) {
    // No se cancela todavía: se pregunta, diciendo qué cita es para que se note si fue un toque por error.
    if (result.botActive) {
      await sendBotOptions(
        result.conversationId,
        `¿Cancelo tu cita del ${dateText(start)} a las ${formatLimaTime(start)}?`,
        CANCEL_CONFIRM_BUTTONS,
        { kind: "cancel_confirm", appointment_id: appt.id },
      );
    }
    return true;
  }

  return false;
}
