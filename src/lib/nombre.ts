/**
 * WhatsApp manda el nombre del perfil, que muchas veces no sirve para una cita: apodos («Luchito»), emojis,
 * negocios («Mototaxi Express»), números o una sola palabra. Antes de usarlo para agendar hay que mirarlo.
 */

/** ¿Este nombre sirve para llamar a alguien en la tienda? Nombre y apellido, sin emojis ni números. */
export function pareceNombreReal(nombre: string | null | undefined): boolean {
  const limpio = (nombre ?? "").trim();
  if (limpio.length < 5 || limpio.length > 60) return false;
  // Emojis, números o símbolos: es un alias, no un nombre.
  if (/[\d@#*_~|]/.test(limpio)) return false;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(limpio)) return false;
  const palabras = limpio.split(/\s+/).filter((p) => p.length >= 2);
  if (palabras.length < 2) return false; // solo el nombre de pila no basta para buscarlo en la tienda
  return palabras.every((p) => /^[a-záéíóúüñ'.-]+$/i.test(p));
}
