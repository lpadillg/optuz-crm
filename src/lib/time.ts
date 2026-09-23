// Todo el negocio opera en hora de Lima (UTC-5 fijo, sin horario de verano).
const LIMA_OFFSET = "-05:00";
const TZ = "America/Lima";

/** "2026-09-21T09:00" (hora de Lima) → instante UTC. Devuelve null si el formato es inválido. */
export function parseLimaLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(`${value}:00${LIMA_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Fecha `YYYY-MM-DD` de un instante, en hora de Lima. */
export function limaDateString(instant: Date): string {
  return new Date(instant.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

/** Suma días a una fecha `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00${LIMA_OFFSET}`);
  d.setUTCDate(d.getUTCDate() + days);
  return limaDateString(d);
}

/**
 * Así se escribe la hora en todos los mensajes al cliente: «8:00 am», «3:30 pm».
 * Intl en es-PE devuelve «8:00 a. m.» con espacios finos; se normaliza a la forma corta que pidió el negocio.
 */
export function horaCorta(texto: string): string {
  return texto.replace(/[\s\u202f\u00a0]*a\.\s*m\./giu, " am").replace(/[\s\u202f\u00a0]*p\.\s*m\./giu, " pm");
}

/** "lunes 21 de septiembre, 9:00 am" */
export function formatLima(instant: Date): string {
  return horaCorta(
    new Intl.DateTimeFormat("es-PE", {
      timeZone: TZ,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(instant),
  );
}

/** "8:00 am" / "3:30 pm" en hora de Lima: así se le escribe la hora al cliente. */
export function formatLimaTime(instant: Date): string {
  return horaCorta(new Intl.DateTimeFormat("es-PE", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(instant));
}

/** "viernes 18 de septiembre de 2026, 15:40" — para que el agente sepa qué día es hoy. */
export function describeNowLima(now: Date = new Date()): string {
  return horaCorta(
    new Intl.DateTimeFormat("es-PE", {
      timeZone: TZ,
      dateStyle: "full",
      timeStyle: "short",
      hour12: true,
    }).format(now),
  );
}

/**
 * Pasa a 12 h las horas que el agente escriba en 24 h. El horario correcto ya está en sus instrucciones, pero
 * dentro de una conversación copia lo que dijo antes, así que un «20:00» se arrastra. Esto lo corrige al salir.
 * Solo toca lo inequívoco: 13:00 o más (y 00:xx). Un «8:00» suelto se deja, salvo que el rango lo aclare.
 */
export function textoEn12h(texto: string): string {
  const doce = (h: number, m: string) => `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "am" : "pm"}`;
  let out = texto.replace(/\b(\d{1,2}):([0-5]\d)\b(?!\s*(?:am|pm|a\.\s*m\.|p\.\s*m\.))/gi, (todo, hh, mm) => {
    const h = Number(hh);
    return h >= 13 || h === 0 ? doce(h, mm) : todo;
  });
  // «de 8:00 a 8:00 pm»: la primera hora se queda sin sufijo y queda coja; el rango dice que es de la mañana.
  out = out.replace(/\b(\d{1,2}):([0-5]\d)\s+(a|hasta)\s+(\d{1,2}):([0-5]\d)\s*pm\b/gi, (todo, hh, mm, nexo, hh2, mm2) => {
    const h = Number(hh);
    return h >= 1 && h <= 11 ? `${h}:${mm} am ${nexo} ${hh2}:${mm2} pm` : todo;
  });
  return out;
}

/** WhatsApp usa *un* asterisco para negrita: el «**texto**» del modelo se vería literal. También sobran los ### de los títulos. */
export function limpiaMarkdown(texto: string): string {
  return texto
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-–]\s+/gm, "• ");
}

/**
 * "mar 23, 3:00 pm": día y hora en el espacio de un botón de WhatsApp, que solo admite 20 caracteres.
 * `formatLima` es más claro pero no cabe, y un botón cortado no se entiende.
 */
export function etiquetaBoton(instant: Date): string {
  const dia = new Intl.DateTimeFormat("es-PE", { timeZone: TZ, weekday: "short", day: "numeric" }).format(instant).replace(".", "");
  return `${dia}, ${formatLimaTime(instant)}`;
}

/** "sábado 26 de septiembre": el día, sin hora, para encabezar una lista de horarios. */
export function diaLargo(instant: Date): string {
  return new Intl.DateTimeFormat("es-PE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(instant);
}
