import "server-only";
import { google, type calendar_v3 } from "googleapis";
import { env } from "@/lib/env";
import { explainGoogleError } from "@/lib/google/errors";

let cached: calendar_v3.Calendar | null = null;

/**
 * Cliente autenticado como service account. Cada uno de los 5 calendarios de sucursal debe estar
 * compartido con el email de la service account con permiso "Hacer cambios en eventos".
 */
function calendarClient(): calendar_v3.Calendar {
  if (!cached) {
    const auth = new google.auth.JWT({
      email: env.googleServiceAccountEmail,
      key: env.googleServiceAccountPrivateKey,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    cached = google.calendar({ version: "v3", auth });
  }
  return cached;
}

export interface BusyInterval { start: Date; end: Date }

/** Intervalos ocupados del calendario en [timeMin, timeMax] (API freebusy). */
export async function getBusyIntervals(calendarId: string, timeMin: Date, timeMax: Date): Promise<BusyInterval[]> {
  const res = await calendarClient().freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: env.googleCalendarTimezone,
      items: [{ id: calendarId }],
    },
  });
  const entry = res.data.calendars?.[calendarId];
  if (entry?.errors?.length) {
    throw new Error(`freebusy ${calendarId}: ${entry.errors.map((e) => e.reason).join(", ")}`);
  }
  return (entry?.busy ?? []).map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }));
}

export interface CalendarEvent extends BusyInterval { id: string }

/**
 * Los eventos del calendario en [timeMin, timeMax], con su id.
 *
 * Hace falta el id (y no basta freebusy) desde que un horario admite varias citas: los eventos que puso
 * el CRM no bloquean nada — son los que ya se cuentan como cupos en la base —, mientras que un evento
 * creado a mano en el calendario (el especialista no viene, una reunión) sí cierra el horario entero.
 * Sin id no hay forma de distinguirlos.
 */
export async function listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
  const res = await calendarClient().events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true, // expande las series repetidas en sus ocurrencias
    maxResults: 2500,
    timeZone: env.googleCalendarTimezone,
  });
  const eventos: CalendarEvent[] = [];
  for (const ev of res.data.items ?? []) {
    if (ev.status === "cancelled" || !ev.id) continue;
    // Un evento de día completo (`date` en vez de `dateTime`) tapa toda la jornada: p. ej. "feriado".
    const start = ev.start?.dateTime ?? ev.start?.date;
    const end = ev.end?.dateTime ?? ev.end?.date;
    if (!start || !end) continue;
    eventos.push({ id: ev.id, start: new Date(start), end: new Date(end) });
  }
  return eventos;
}

/** Mueve un evento ya creado a otra hora (reprogramación). */
export async function moveCalendarEvent(calendarId: string, eventId: string, start: Date, end: Date): Promise<void> {
  const tz = env.googleCalendarTimezone;
  await calendarClient().events.patch({
    calendarId,
    eventId,
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
    },
  });
}

export interface CreateEventInput {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
}

/** Crea el evento y devuelve su id (se guarda en appointments.google_event_id). */
export async function createCalendarEvent(input: CreateEventInput): Promise<string> {
  const tz = env.googleCalendarTimezone;
  const res = await calendarClient().events.insert({
    calendarId: input.calendarId,
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.start.toISOString(), timeZone: tz },
      end: { dateTime: input.end.toISOString(), timeZone: tz },
    },
  });
  if (!res.data.id) throw new Error("Google Calendar no devolvió id de evento");
  return res.data.id;
}

export async function deleteCalendarEvent(calendarId: string, eventId: string): Promise<void> {
  await calendarClient().events.delete({ calendarId, eventId });
}

export interface CalendarCheck {
  ok: boolean;
  message: string;
}

/**
 * Comprueba que el calendario se puede LEER (disponibilidad) y ESCRIBIR (crea y borra un evento de prueba).
 * Las dos cosas por separado: compartir un calendario con «solo ver disponibilidad» pasa la lectura pero falla al agendar.
 */
export async function checkCalendarAccess(calendarId: string): Promise<CalendarCheck> {
  const email = env.googleServiceAccountEmail;
  try {
    const now = new Date();
    await getBusyIntervals(calendarId, now, new Date(now.getTime() + 24 * 3600_000));
  } catch (err) {
    return { ok: false, message: `No se puede leer: ${explainGoogleError(err, email)}` };
  }

  let eventId: string;
  try {
    const start = new Date(Date.now() + 3 * 24 * 3600_000);
    start.setUTCMinutes(0, 0, 0);
    eventId = await createCalendarEvent({
      calendarId,
      summary: "Prueba de conexión de Optuz CRM (se borra sola)",
      start,
      end: new Date(start.getTime() + 15 * 60_000),
    });
  } catch (err) {
    return { ok: false, message: `Se puede leer pero no escribir: ${explainGoogleError(err, email)}` };
  }

  try {
    await deleteCalendarEvent(calendarId, eventId);
  } catch (err) {
    return { ok: false, message: `Se creó un evento de prueba pero no se pudo borrar (bórralo a mano: «Prueba de conexión de Optuz CRM»): ${explainGoogleError(err, email)}` };
  }
  return { ok: true, message: "Lectura y escritura correctas" };
}
