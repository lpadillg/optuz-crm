import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCalendarEvent, deleteCalendarEvent, listEvents, moveCalendarEvent, type BusyInterval } from "@/lib/google/calendar";
import { businessDayBounds, computeFreeSlots, enFranja, isWithinBusinessHours, prioridadEnPunto, type Franja, type Ocupacion } from "@/lib/google/slots";
import { clearReminderJobs, scheduleAppointmentJobs } from "@/lib/appointment-ops";
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
 * Cómo está la agenda de una sucursal en un rango: cuántas citas hay en cada horario y qué horarios están
 * cerrados del todo.
 *
 * Las citas del CRM se cuentan desde Postgres, que es donde manda el tope de cupos. En Google solo se mira
 * lo que el CRM no puso: un evento creado a mano (el especialista no viene, una reunión, un feriado de día
 * completo) cierra ese horario entero, porque quien lo escribió no sabía nada de cupos.
 */
async function cargarAgenda(
  branch: { id: string; google_calendar_id: string },
  from: Date,
  to: Date,
): Promise<{ bloqueos: BusyInterval[]; ocupacion: Ocupacion }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("appointments")
    .select("scheduled_at, google_event_id")
    .eq("branch_id", branch.id)
    .in("status", ["agendada", "confirmada"])
    .gte("scheduled_at", from.toISOString())
    .lt("scheduled_at", to.toISOString());
  if (error) throw error;

  const ocupacion = new Map<number, number>();
  const delCrm = new Set<string>();
  for (const row of data ?? []) {
    const t = new Date(row.scheduled_at as string).getTime();
    ocupacion.set(t, (ocupacion.get(t) ?? 0) + 1);
    if (row.google_event_id) delCrm.add(row.google_event_id as string);
  }

  const eventos = await listEvents(branch.google_calendar_id, from, to);
  const bloqueos = eventos.filter((ev) => !delCrm.has(ev.id)).map(({ start, end }) => ({ start, end }));
  return { bloqueos, ocupacion };
}

/** Cuántas citas más caben en un horario concreto. 0 = lleno (o cerrado por un evento del calendario). */
export async function cuposLibres(branchId: string, startsAt: Date, durationMinutes = 30): Promise<number> {
  if (!isWithinBusinessHours(startsAt, durationMinutes)) return 0;
  const branch = await loadBranch(branchId);
  const end = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const { bloqueos, ocupacion } = await cargarAgenda(branch, startsAt, end);
  if (bloqueos.some((b) => startsAt < b.end && end > b.start)) return 0;
  return Math.max(0, env.slotCapacity - (ocupacion.get(startsAt.getTime()) ?? 0));
}

/**
 * Horarios que se le OFRECEN al cliente para una fecha `YYYY-MM-DD`: los que tienen cupo, priorizando las
 * horas en punto para que la agenda se llene ordenada. `franja` acota a mañana o tarde.
 */
export async function getAvailableSlots(branchId: string, date: string, durationMinutes = 30, franja?: Franja): Promise<string[]> {
  const branch = await loadBranch(branchId);
  const { open, close } = businessDayBounds(date);
  const { bloqueos, ocupacion } = await cargarAgenda(branch, open, close);
  const conCupo = computeFreeSlots(date, { bloqueos, ocupacion, capacidad: env.slotCapacity, durationMinutes });
  // La franja se aplica ANTES de priorizar: si la tarde ya no tiene horas en punto, se ofrecen sus medias
  // en vez de mandar al cliente a la mañana, que no es lo que pidió.
  const deLaFranja = conCupo.filter((d) => !franja || enFranja(d, franja));
  return prioridadEnPunto(deLaFranja).map((d) => d.toISOString());
}

/**
 * Los primeros `count` horarios con cupo a partir de `fromDate` (incluida), mirando hasta `days` días.
 * Una sola consulta a la agenda para todo el rango; la prioridad de horas en punto se aplica por día.
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
  const { bloqueos, ocupacion } = await cargarAgenda(branch, open, close);

  const slots: string[] = [];
  for (let i = 0; i < days && slots.length < count; i++) {
    const date = addDays(fromDate, i);
    const conCupo = computeFreeSlots(date, { bloqueos, ocupacion, capacidad: env.slotCapacity, durationMinutes });
    const deLaFranja = conCupo.filter((d) => !franja || enFranja(d, franja));
    for (const s of prioridadEnPunto(deLaFranja)) {
      slots.push(s.toISOString());
      if (slots.length === count) break;
    }
  }
  return slots;
}

/**
 * Los horarios con cupo más cercanos a uno que el cliente pidió y está lleno: el anterior y el siguiente del
 * mismo día. Se devuelven tal cual, sin priorizar horas en punto: quien pidió las 3:00 pm quiere algo cerca
 * de esa hora, aunque sea 2:30.
 */
export async function slotsCercanos(branchId: string, startsAt: Date, durationMinutes = 30, count = 2): Promise<string[]> {
  const branch = await loadBranch(branchId);
  const date = limaDateString(startsAt);
  const { open, close } = businessDayBounds(date);
  const { bloqueos, ocupacion } = await cargarAgenda(branch, open, close);
  const conCupo = computeFreeSlots(date, { bloqueos, ocupacion, capacidad: env.slotCapacity, durationMinutes });
  return conCupo
    .map((d) => ({ d, lejos: Math.abs(d.getTime() - startsAt.getTime()) }))
    .sort((a, b) => a.lejos - b.lejos)
    .slice(0, count)
    .map(({ d }) => d.toISOString())
    .sort();
}

export interface BookInput {
  /** Quién viene a la cita, si no es el propio contacto (un hijo, un familiar). */
  pacienteNombre?: string | null;
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

  const end = new Date(input.startsAt.getTime() + duration * 60_000);
  const { bloqueos, ocupacion } = await cargarAgenda(branch, input.startsAt, end);
  // Un evento puesto a mano en el calendario cierra el horario entero, haya cupos o no.
  if (bloqueos.some((b) => input.startsAt < b.end && end > b.start)) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }

  // Se toma el primer cupo libre. Si dos conversaciones piden la misma hora a la vez, una de las dos choca
  // contra el índice único: se reintenta con el siguiente cupo hasta agotar el tope.
  if ((ocupacion.get(input.startsAt.getTime()) ?? 0) >= env.slotCapacity) {
    throw new BookingError("slot_taken", `Ese horario ya tiene las ${env.slotCapacity} citas que se pueden atender a la vez`);
  }

  // Se prueban los cupos desde el 0: una cancelación deja su número libre y conviene reusarlo.
  let appt: { id: string } | null = null;
  for (let cupo = 0; cupo < env.slotCapacity && !appt; cupo++) {
    const { data, error: insErr } = await db
      .from("appointments")
      .insert({
        lead_id: input.leadId,
        branch_id: input.branchId,
        tipo_servicio: tipo,
        promotion_id: promotion?.id ?? null,
        scheduled_at: input.startsAt.toISOString(),
        duration_minutes: duration,
        paciente: input.pacienteNombre?.trim() || null,
        cupo,
      })
      .select("id")
      .single();
    if (!insErr) { appt = data as { id: string }; break; }
    if (insErr.code !== "23505") throw insErr;
  }
  if (!appt) {
    throw new BookingError("slot_taken", `Ese horario ya tiene las ${env.slotCapacity} citas que se pueden atender a la vez`);
  }

  let eventId: string;
  try {
    eventId = await createCalendarEvent({
      calendarId: branch.google_calendar_id,
      summary: `${SERVICE_LABEL[tipo]} — ${input.pacienteNombre || lead.nombre || lead.phone || "Cliente de WhatsApp"}`,
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

export interface RescheduleResult {
  appointmentId: string;
  /** Cuándo estaba antes, para poder decírselo al cliente: «tu cita del martes pasa a…». */
  antes: Date;
  ahora: Date;
  leadId: string;
  branch: { id: string; nombre: string; direccion: string };
}

/**
 * Mueve una cita a otra hora (y, si se quiere, a otra sucursal) conservando la misma cita: no se cancela ni
 * se crea otra. Eso importa porque el cliente ya tiene un número de cita, y porque cancelar y recrear
 * dispararía el evento de conversión hacia Meta dos veces.
 *
 * No avisa al cliente: de eso se encarga quien la llama, que sabe si el aviso sale del panel o del agente.
 */
export async function rescheduleAppointment(appointmentId: string, startsAt: Date, branchId?: string): Promise<RescheduleResult> {
  const db = createAdminClient();
  const { data: appt, error } = await db
    .from("appointments")
    .select("id, lead_id, branch_id, status, scheduled_at, duration_minutes, google_event_id, paciente, branches(google_calendar_id)")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!appt) throw new BookingError("lead_not_found", "La cita no existe");
  if (appt.status === "cancelada" || appt.status === "atendida" || appt.status === "no_show") {
    throw new BookingError("slot_taken", "Esa cita ya está cerrada: agenda una nueva en vez de moverla");
  }

  const duration = (appt.duration_minutes as number) ?? 30;
  const antes = new Date(appt.scheduled_at as string);
  if (!isWithinBusinessHours(startsAt, duration)) {
    throw new BookingError("outside_hours", "Fuera del horario de atención (lun–sáb 8:00–20:00, sin 13:00–14:00)");
  }

  const destino = await loadBranch(branchId ?? (appt.branch_id as string));
  const cambiaDeSede = destino.id !== (appt.branch_id as string);
  const end = new Date(startsAt.getTime() + duration * 60_000);
  const { bloqueos, ocupacion } = await cargarAgenda(destino, startsAt, end);
  if (bloqueos.some((b) => startsAt < b.end && end > b.start)) {
    throw new BookingError("slot_taken", "Ese horario está cerrado en el calendario de la sucursal");
  }
  // La propia cita ya cuenta en `ocupacion` si no se mueve de sitio: no puede bloquearse a sí misma.
  const propia = !cambiaDeSede && startsAt.getTime() === antes.getTime() ? 1 : 0;
  if ((ocupacion.get(startsAt.getTime()) ?? 0) - propia >= env.slotCapacity) {
    throw new BookingError("slot_taken", `Ese horario ya tiene las ${env.slotCapacity} citas que se pueden atender a la vez`);
  }

  let movida = false;
  for (let cupo = 0; cupo < env.slotCapacity && !movida; cupo++) {
    const { error: upErr } = await db
      .from("appointments")
      .update({ scheduled_at: startsAt.toISOString(), branch_id: destino.id, cupo })
      .eq("id", appointmentId);
    if (!upErr) { movida = true; break; }
    if (upErr.code !== "23505") throw upErr;
  }
  if (!movida) throw new BookingError("slot_taken", "Ese horario se llenó mientras se movía la cita");

  // El evento de Google: si cambia de sucursal cambia de calendario, y un evento no se puede mudar de
  // calendario con un patch — se borra del viejo y se crea en el nuevo.
  const calendarioViejo = (appt.branches as unknown as { google_calendar_id: string | null } | null)?.google_calendar_id;
  const eventId = appt.google_event_id as string | null;
  try {
    if (eventId && calendarioViejo && !cambiaDeSede) {
      await moveCalendarEvent(calendarioViejo, eventId, startsAt, end);
    } else {
      const { data: lead } = await db.from("leads").select("nombre, phone").eq("id", appt.lead_id as string).maybeSingle();
      const nuevo = await createCalendarEvent({
        calendarId: destino.google_calendar_id,
        summary: `${SERVICE_LABEL.examen_visual} — ${(appt.paciente as string | null) || lead?.nombre || lead?.phone || "Cliente de WhatsApp"}`,
        description: `Reprogramada desde ${formatParaCalendario(antes)}\nAgendado por Optuz CRM`,
        location: `${destino.nombre} — ${destino.direccion}`,
        start: startsAt,
        end,
      });
      await db.from("appointments").update({ google_event_id: nuevo }).eq("id", appointmentId);
      if (eventId && calendarioViejo) {
        await deleteCalendarEvent(calendarioViejo, eventId).catch((err) => console.error("[citas] no se pudo borrar el evento anterior", err));
      }
    }
  } catch (err) {
    console.error("[citas] la cita se movió en la base pero no en Google Calendar", err);
  }

  await clearReminderJobs(appointmentId);
  await scheduleAppointmentJobs(appointmentId, startsAt);
  await syncStageFromAppointments(appt.lead_id as string);

  return {
    appointmentId,
    antes,
    ahora: startsAt,
    leadId: appt.lead_id as string,
    branch: { id: destino.id, nombre: destino.nombre, direccion: destino.direccion },
  };
}

const formatParaCalendario = (d: Date) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "full", timeStyle: "short" }).format(d);
