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
 * Qué horarios se OFRECEN (no cuáles se pueden reservar): las horas en punto, y la media hora solo cuando su
 * hora en punto ya está ocupada. Con la agenda vacía, ofrecer 8:00, 8:30, 9:00… son veinte opciones que agobian
 * y dejan la agenda partida; así se ofrece la mitad y las citas quedan ordenadas.
 */
export function soloEnPuntoSalvoOcupado(slots: Date[]): Date[] {
  const enPunto = new Set(slots.filter((d) => d.getUTCMinutes() === 0).map((d) => d.getTime()));
  return slots.filter((d) => d.getUTCMinutes() === 0 || !enPunto.has(d.getTime() - 30 * 60_000));
}

/** Huecos libres del día que no se cruzan con `busy`, el refrigerio ni el pasado. */
export function computeFreeSlots(
  date: string,
  busy: BusyInterval[],
  durationMinutes: number,
  now: Date = new Date(),
): Date[] {
  const { open, close } = businessDayBounds(date);
  const stepMs = BUSINESS_HOURS.slotMinutes * 60_000;
  const slots: Date[] = [];

  for (let t = open.getTime(); t + durationMinutes * 60_000 <= close.getTime(); t += stepMs) {
    const start = new Date(t);
    if (start <= now) continue;
    if (!isWithinBusinessHours(start, durationMinutes)) continue;
    const end = new Date(t + durationMinutes * 60_000);
    if (busy.some((b) => start < b.end && end > b.start)) continue;
    slots.push(start);
  }
  return slots;
}
