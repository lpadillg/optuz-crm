import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCalendarEvent, deleteCalendarEvent, getBusyIntervals } from "@/lib/google/calendar";
import { businessDayBounds, computeFreeSlots, enFranja, isWithinBusinessHours, soloEnPuntoSalvoOcupado, type Franja } from "@/lib/google/slots";
import { scheduleAppointmentJobs } from "@/lib/appointment-ops";
import { syncStageFromAppointments } from "@/lib/lead-stage";
import { addDays, limaDateString } from "@/lib/time";
import { env } from "@/lib/env";

// Las citas son solo para examen visual. Al añadir tipos: `alter type service_type add value` + aquí.
export const SERVICE_TYPES = ["examen_visual"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

const SERVICE_LABEL: Record<ServiceType, string> = {
  examen_visual: "Examen visual",
};

export type BookingErrorCode =
  | "branch_not_found"
  | "no_calendar"
  | "slot_taken"
  | "lead_not_found"
  | "outside_hours"
  | "invalid_promotion"
  | "too_many_active"
  | "daily_limit";

export class BookingError extends Error {
  constructor(public code: BookingErrorCode, message: string) {
    super(message);
  }
}

/**
 * Un cliente no puede llenar la agenda: se le permiten unas pocas citas próximas a la vez (para él y su familia)
 * y unas pocas creadas por día (freno a quien agenda y cancela en bucle). Se comprueba aquí, en el punto donde
 * se agenda, para que valga también si se agenda desde el panel o por otro camino.
 */
async function assertWithinLimits(leadId: string): Promise<void> {
  const db = createAdminClient();

  const { count: active, error } = await db
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .in("status", ["agendada", "confirmada"])
    .gte("scheduled_at", new Date().toISOString());
  if (error) throw error;
  if ((active ?? 0) >= env.maxActiveAppointments) {
    throw new BookingError(
      "too_many_active",
      `Este cliente ya tiene ${active} cita(s) próxima(s), el máximo permitido. Para agendar otra hay que cancelar o mover una de las que ya tiene.`,
    );
  }

  if (env.maxAppointmentsPerDay > 0) {
    // Desde el inicio del día en Lima: cuenta TODAS las creadas hoy, incluidas las que luego canceló.
    const startOfDay = new Date(`${limaDateString(new Date())}T00:00:00-05:00`).toISOString();
    const { count: today, error: dayErr } = await db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .gte("created_at", startOfDay);
    if (dayErr) throw dayErr;
    if ((today ?? 0) >= env.maxAppointmentsPerDay) {
      throw new BookingError(
        "daily_limit",
        `Este cliente ya creó ${today} citas hoy: se alcanzó el tope diario. Que lo vea una persona antes de agendarle otra.`,
      );
    }
  }
}

/** La promoción debe estar activa, dentro de su vigencia y aplicar a la sucursal (o a todas). */
async function loadValidPromotion(promotionId: string, branchId: string) {
  const db = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("promotions")
    .select("id, titulo, branch_id")
    .eq("id", promotionId)
    .eq("active", true)
    .lte("valid_from", now)
    .gte("valid_to", now)
    .maybeSingle();
  if (error) throw error;
  if (!data || (data.branch_id && data.branch_id !== branchId)) {
    throw new BookingError("invalid_promotion", "La promoción no está vigente para esta sucursal");
  }
  return data as { id: string; titulo: string };
}

async function loadBranch(branchId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("branches")
    .select("id, nombre, direccion, google_calendar_id")
    .eq("id", branchId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BookingError("branch_not_found", "Sucursal no encontrada");
  if (!data.google_calendar_id) throw new BookingError("no_calendar", `La sucursal ${data.nombre} no tiene calendario configurado`);
  return data as { id: string; nombre: string; direccion: string; google_calendar_id: string };
}

/**
 * Horarios libres reales (según Google Calendar de la sucursal) para una fecha `YYYY-MM-DD`.
 * Lo que se OFRECE va en punto salvo que esa hora esté ocupada; `franja` acota a mañana o tarde.
 */
export async function getAvailableSlots(branchId: string, date: string, durationMinutes = 30, franja?: Franja): Promise<string[]> {
  const branch = await loadBranch(branchId);
  const { open, close } = businessDayBounds(date);
  const busy = await getBusyIntervals(branch.google_calendar_id, open, close);
  const libres = soloEnPuntoSalvoOcupado(computeFreeSlots(date, busy, durationMinutes));
  return libres.filter((d) => !franja || enFranja(d, franja)).map((d) => d.toISOString());
}

/**
 * Los primeros `count` horarios libres a partir de `fromDate` (incluida), mirando hasta `days` días.
 * Una sola consulta freebusy para todo el rango.
 */
export async function findNextSlots(
  branchId: string,
  fromDate: string,
  count = 3,
  days = 7,
  durationMinutes = 30,
  franja?: Franja,
): Promise<string[]> {
  const branch = await loadBranch(branchId);
  const { open } = businessDayBounds(fromDate);
  const { close } = businessDayBounds(addDays(fromDate, days - 1));
  const busy = await getBusyIntervals(branch.google_calendar_id, open, close);

  const slots: string[] = [];
  for (let i = 0; i < days && slots.length < count; i++) {
    const date = addDays(fromDate, i);
    for (const s of soloEnPuntoSalvoOcupado(computeFreeSlots(date, busy, durationMinutes))) {
      if (franja && !enFranja(s, franja)) continue;
      slots.push(s.toISOString());
      if (slots.length === count) break;
    }
  }
  return slots;
}

export interface BookInput {
  leadId: string;
  branchId: string;
  tipoServicio?: ServiceType;
  startsAt: Date;
  durationMinutes?: number;
  /** Promoción vigente a la que se acoge la cita (opcional). */
  promotionId?: string;
}

/**
 * Agenda una cita: reserva primero en Postgres (el índice único evita dobles reservas entre
 * conversaciones concurrentes), luego crea el evento en Google Calendar y enlaza ambos.
 * Si Google falla, se libera la reserva.
 */
export async function bookAppointment(input: BookInput) {
  const db = createAdminClient();
  const duration = input.durationMinutes ?? 30;
  const tipo = input.tipoServicio ?? "examen_visual";
  if (!isWithinBusinessHours(input.startsAt, duration)) {
    throw new BookingError("outside_hours", "Fuera del horario de atención (lun–sáb 8:00–20:00, sin 13:00–14:00)");
  }
  const branch = await loadBranch(input.branchId);
  await assertWithinLimits(input.leadId);
  const promotion = input.promotionId ? await loadValidPromotion(input.promotionId, input.branchId) : null;

  const { data: lead, error: leadErr } = await db
    .from("leads")
    .select("id, nombre, phone")
    .eq("id", input.leadId)
    .maybeSingle();
  if (leadErr) throw leadErr;
  if (!lead) throw new BookingError("lead_not_found", "Lead no encontrado");

  // El hueco debe seguir libre en Google (alguien pudo agendar a mano en el calendario).
  const end = new Date(input.startsAt.getTime() + duration * 60_000);
  const busy = await getBusyIntervals(branch.google_calendar_id, input.startsAt, end);
  if (busy.some((b) => input.startsAt < b.end && end > b.start)) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }

  const { data: appt, error: insErr } = await db
    .from("appointments")
    .insert({
      lead_id: input.leadId,
      branch_id: input.branchId,
      tipo_servicio: tipo,
      promotion_id: promotion?.id ?? null,
      scheduled_at: input.startsAt.toISOString(),
      duration_minutes: duration,
    })
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") throw new BookingError("slot_taken", "Ese horario ya no está disponible");
    throw insErr;
  }

  let eventId: string;
  try {
    eventId = await createCalendarEvent({
      calendarId: branch.google_calendar_id,
      summary: `${SERVICE_LABEL[tipo]} — ${lead.nombre ?? lead.phone ?? "Cliente de WhatsApp"}`,
      description:
        `Lead: ${lead.nombre ?? "(sin nombre)"}\nTeléfono: ${lead.phone ?? "no disponible (usuario de WhatsApp sin número visible)"}` +
        (promotion ? `\nPromoción: ${promotion.titulo}` : "") +
        `\nAgendado por Optuz CRM`,
      location: `${branch.nombre} — ${branch.direccion}`,
      start: input.startsAt,
      end,
    });
  } catch (err) {
    await db.from("appointments").delete().eq("id", appt.id);
    throw err;
  }

  const { error: linkErr } = await db.from("appointments").update({ google_event_id: eventId }).eq("id", appt.id);
  if (linkErr) {
    // No dejar un evento huérfano en el calendario.
    await Promise.allSettled([
      deleteCalendarEvent(branch.google_calendar_id, eventId),
      db.from("appointments").delete().eq("id", appt.id),
    ]);
    throw linkErr;
  }

  await syncStageFromAppointments(input.leadId); // el tablero: objetivo cumplido
  await scheduleAppointmentJobs(appt.id as string, input.startsAt); // recordatorios 24 h y 2 h antes + evento hacia Meta

  return { appointmentId: appt.id as string, googleEventId: eventId, branch };
}
