import "server-only";
import { deleteCalendarEvent } from "@/lib/google/calendar";
import { enqueue } from "@/lib/jobs";
import { syncStageFromAppointments } from "@/lib/lead-stage";
import { createAdminClient } from "@/lib/supabase/admin";

/** Claves de las tareas de una cita: permiten no duplicarlas y cancelarlas si la cita se cancela. */
export const reminderKey = (appointmentId: string, kind: "24h" | "2h") => `reminder${kind}:${appointmentId}`;
export const capiKey = (appointmentId: string, event: string) => `capi:${appointmentId}:${event}`;

/**
 * Al agendar una cita: recordatorio 24 h antes y 2 h antes (si aún falta tiempo) y el evento de conversión hacia Meta.
 * Nunca lanza: si no se pudieron programar, la cita ya está agendada y no debe fallar por eso.
 */
export async function scheduleAppointmentJobs(appointmentId: string, startsAt: Date): Promise<void> {
  try {
    const now = Date.now();
    for (const [kind, ms] of [["24h", 24 * 3600_000], ["2h", 2 * 3600_000]] as const) {
      const runAt = new Date(startsAt.getTime() - ms);
      if (runAt.getTime() > now + 60_000) {
        await enqueue({ kind: "reminder", payload: { appointmentId, kind }, runAt, dedupeKey: reminderKey(appointmentId, kind), maxAttempts: 3 });
      }
    }
    await enqueue({ kind: "capi", payload: { appointmentId, event: "schedule" }, dedupeKey: capiKey(appointmentId, "schedule"), maxAttempts: 3 });
  } catch (err) {
    console.error("[citas] no se pudieron programar los recordatorios", err);
  }
}

/** Quita los recordatorios pendientes de una cita (se canceló o cambió). */
export async function clearReminderJobs(appointmentId: string): Promise<void> {
  await createAdminClient()
    .from("jobs")
    .delete()
    .in("dedupe_key", [reminderKey(appointmentId, "24h"), reminderKey(appointmentId, "2h")])
    .eq("status", "pending");
}

export interface UpcomingAppointment {
  id: string;
  scheduled_at: string;
  status: string;
  branch: { nombre: string; direccion: string } | null;
}

/** Citas próximas (agendadas o confirmadas) de un cliente. */
export async function listUpcomingAppointments(leadId: string): Promise<UpcomingAppointment[]> {
  const { data, error } = await createAdminClient()
    .from("appointments")
    .select("id, scheduled_at, status, branches(nombre, direccion)")
    .eq("lead_id", leadId)
    .in("status", ["agendada", "confirmada"])
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((a) => ({ id: a.id as string, scheduled_at: a.scheduled_at as string, status: a.status as string, branch: a.branches as unknown as UpcomingAppointment["branch"] }));
}

/** Cancela una cita: libera el hueco (también en Google Calendar) y quita sus recordatorios. */
export async function cancelAppointment(appointmentId: string): Promise<void> {
  const db = createAdminClient();
  const { data: appt, error } = await db
    .from("appointments")
    .select("id, status, google_event_id, branches(google_calendar_id)")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appt) throw new Error("La cita no existe");
  if (appt.status === "cancelada") return;

  const calendarId = (appt.branches as unknown as { google_calendar_id: string | null } | null)?.google_calendar_id;
  if (appt.google_event_id && calendarId) {
    await deleteCalendarEvent(calendarId, appt.google_event_id as string).catch((err) => console.error("[citas] no se pudo borrar el evento de Calendar", err));
  }
  const { error: upErr } = await db.from("appointments").update({ status: "cancelada" }).eq("id", appointmentId);
  if (upErr) throw upErr;
  await clearReminderJobs(appointmentId);
  // Si le queda otra cita (reprogramó) sigue en «Cita agendada»; si no, vuelve al embudo.
  const { data: appt2 } = await db.from("appointments").select("lead_id").eq("id", appointmentId).maybeSingle();
  if (appt2?.lead_id) await syncStageFromAppointments(appt2.lead_id as string);
}

/** El cliente confirmó su asistencia. */
export async function confirmAppointment(appointmentId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("appointments")
    .update({ status: "confirmada", confirmed_at: new Date().toISOString() })
    .eq("id", appointmentId)
    .in("status", ["agendada", "confirmada"]);
  if (error) throw error;
}
