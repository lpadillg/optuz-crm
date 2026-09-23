import { limaDateString } from "@/lib/time";
import type { BusyInterval } from "./calendar";

/**
 * Horario de atención, hora de Lima (UTC-5 fijo, sin horario de verano):
 * lunes a sábado 8:00–20:00, refrigerio 13:00–14:00 (sin citas).
 * Es el mismo para las 5 sucursales; si llegara a variar, moverlo a columnas de `branches`.
 */
export const BUSINESS_HOURS = {
  openHour: 8,
  closeHour: 20,
  breakStartHour: 13,
  breakEndHour: 14,
  /** 0 = domingo … 6 = sábado */
  openDays: [1, 2, 3, 4, 5, 6],
  slotMinutes: 30,
} as const;

const LIMA_OFFSET = "-05:00";
const pad = (n: number) => String(n).padStart(2, "0");
const limaInstant = (date: string, hour: number) => new Date(`${date}T${pad(hour)}:00:00${LIMA_OFFSET}`);

/** Inicio y fin del horario de atención de una fecha `YYYY-MM-DD` (hora de Lima) como instantes UTC. */
export function businessDayBounds(date: string): { open: Date; close: Date; dayOfWeek: number } {
  const open = limaInstant(date, BUSINESS_HOURS.openHour);
  const close = limaInstant(date, BUSINESS_HOURS.closeHour);
  if (Number.isNaN(open.getTime())) throw new Error(`Fecha inválida: ${date}`);
  // getUTCDay sobre el mediodía de Lima evita saltos de día por el desfase.
  const dayOfWeek = new Date(`${date}T12:00:00${LIMA_OFFSET}`).getUTCDay();
  return { open, close, dayOfWeek };
}

/** ¿El intervalo cae dentro del horario de atención y fuera del refrigerio? */
export function isWithinBusinessHours(start: Date, durationMinutes: number): boolean {
  const date = limaDateString(start);
  const { open, close, dayOfWeek } = businessDayBounds(date);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  if (!(BUSINESS_HOURS.openDays as readonly number[]).includes(dayOfWeek)) return false;
  if (start < open || end > close) return false;
  const breakStart = limaInstant(date, BUSINESS_HOURS.breakStartHour);
  const breakEnd = limaInstant(date, BUSINESS_HOURS.breakEndHour);
  return !(start < breakEnd && end > breakStart);
}

/** Franja del día que pide el cliente: mañana (antes del refrigerio) o tarde (después). */
export type Franja = "mañana" | "tarde";

const horaLima = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", hour: "2-digit", hour12: false }).format(d));

export const enFranja = (d: Date, franja: Franja) => (franja === "mañana" ? horaLima(d) < BUSINESS_HOURS.breakStartHour : horaLima(d) >= BUSINESS_HOURS.breakEndHour);

/**
 * Qué horarios se OFRECEN cuando el cliente pregunta por disponibilidad — que no es lo mismo que cuáles se
 * pueden reservar. La agenda se llena primero en horas en punto (8:00, 9:00, 10:00…) y solo se pasa a las
 * medias cuando ya no queda ninguna hora en punto con cupo. Así las citas del día quedan agrupadas en vez de
 * partidas, y al cliente se le ofrecen pocas opciones claras en vez de veinte.
 *
 * Esto NO impide reservar una media hora: si el cliente pide él mismo las 2:30, se le da mientras quede cupo.
 */
export function prioridadEnPunto(slots: Date[]): Date[] {
  const enPunto = slots.filter((d) => d.getUTCMinutes() === 0);
  return enPunto.length > 0 ? enPunto : slots;
}

/** Cuántas citas ya hay en cada horario, por instante de inicio (clave: `Date.getTime()`). */
export type Ocupacion = ReadonlyMap<number, number>;

export interface FreeSlotsInput {
  /** Eventos que cierran el horario por completo: los que alguien puso a mano en el calendario. */
  bloqueos: readonly BusyInterval[];
  /** Citas ya agendadas por el CRM, que consumen cupo pero no cierran el horario. */
  ocupacion: Ocupacion;
  /** Cuántas citas caben a la misma hora. */
  capacidad: number;
  durationMinutes: number;
  now?: Date;
}

/**
 * Horarios del día con al menos un cupo libre: los que no chocan con un bloqueo, el refrigerio ni el pasado,
 * y que aún no llegaron al tope de citas simultáneas.
 */
export function computeFreeSlots(date: string, input: FreeSlotsInput): Date[] {
  const { bloqueos, ocupacion, capacidad, durationMinutes, now = new Date() } = input;
  const { open, close } = businessDayBounds(date);
  const stepMs = BUSINESS_HOURS.slotMinutes * 60_000;
  const slots: Date[] = [];

  for (let t = open.getTime(); t + durationMinutes * 60_000 <= close.getTime(); t += stepMs) {
    const start = new Date(t);
    if (start <= now) continue;
    if (!isWithinBusinessHours(start, durationMinutes)) continue;
    const end = new Date(t + durationMinutes * 60_000);
    if (bloqueos.some((b) => start < b.end && end > b.start)) continue;
    if ((ocupacion.get(t) ?? 0) >= capacidad) continue;
    slots.push(start);
  }
  return slots;
}
