import { BUSINESS_HOURS } from "@/lib/google/slots";
import { addDays, limaDateString } from "@/lib/time";

const LIMA_OFFSET = "-05:00";
const pad = (n: number) => String(n).padStart(2, "0");
const at = (date: string, hour: number) => new Date(`${date}T${pad(hour)}:00:00${LIMA_OFFSET}`);
const dayOfWeek = (date: string) => new Date(`${date}T12:00:00${LIMA_OFFSET}`).getUTCDay();

export interface AttentionInfo {
  /** ¿Hay personas atendiendo ahora? (lun–sáb, dentro del horario y fuera del refrigerio) */
  open: boolean;
  /** Próximo momento en que atiende una persona (si `open`, ahora mismo). */
  nextOpen: Date;
  /** Frase para decirle al cliente cuándo lo atenderán, sin prometer más de lo real. */
  message: string;
}

/** Fragmento «desde el lunes a las 8:00 a. m.» / «hoy desde las 2:00 p. m.» / «mañana desde las 8:00 a. m.». */
function whenText(open: Date, now: Date): string {
  const day = limaDateString(open);
  const today = limaDateString(now);
  const time = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit", hour12: true }).format(open);
  if (day === today) return `hoy desde las ${time}`;
  if (day === addDays(today, 1)) return `mañana desde las ${time}`;
  const weekday = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long" }).format(open);
  return `el ${weekday} desde las ${time}`;
}

/** Solo para pruebas: ATTENTION_NOW fija el «ahora» (ISO) para que los resultados no dependan de la hora en que corra la prueba. */
function currentTime(): Date {
  const fixed = process.env.ATTENTION_NOW ? new Date(process.env.ATTENTION_NOW) : null;
  return fixed && !Number.isNaN(fixed.getTime()) ? fixed : new Date();
}

/** Estado de la atención humana en `now` y cuándo se retoma. Horario: BUSINESS_HOURS (misma regla que las citas). */
export function attentionInfo(now: Date = currentTime()): AttentionInfo {
  const { openHour, closeHour, breakStartHour, breakEndHour, openDays } = BUSINESS_HOURS;
  const today = limaDateString(now);

  // ¿Abierto ahora?
  const isOpenDay = (openDays as readonly number[]).includes(dayOfWeek(today));
  const inMorning = now >= at(today, openHour) && now < at(today, breakStartHour);
  const inAfternoon = now >= at(today, breakEndHour) && now < at(today, closeHour);
  if (isOpenDay && (inMorning || inAfternoon)) {
    return { open: true, nextOpen: now, message: "un asesor lo atenderá en breve" };
  }

  // Próxima apertura: hoy tras el refrigerio, o el siguiente día de atención.
  let next: Date | null = null;
  if (isOpenDay && now >= at(today, breakStartHour) && now < at(today, breakEndHour)) next = at(today, breakEndHour);
  else if (isOpenDay && now < at(today, openHour)) next = at(today, openHour);
  for (let i = 1; !next && i <= 8; i++) {
    const d = addDays(today, i);
    if ((openDays as readonly number[]).includes(dayOfWeek(d))) next = at(d, openHour);
  }
  const nextOpen = next!;
  return { open: false, nextOpen, message: `el equipo atiende ${whenText(nextOpen, now)} (hora de Lima)` };
}
