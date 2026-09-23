/**
 * Normaliza un teléfono escrito a mano a E.164 (como llega de WhatsApp: "+51987654321").
 * - 9 dígitos que empiezan con 9 → celular de Perú (+51).
 * - Con prefijo de país ("51…", "+51…", "0051…") → se respeta.
 * Devuelve null si no parece un número válido (8–15 dígitos).
 */
export function normalizePhone(raw: string, defaultCountry = "51"): string | null {
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  const hadPlus = digits.startsWith("+");
  digits = digits.replace(/\D/g, "");
  if (!digits) return null;
  if (!hadPlus && digits.length === 9 && digits.startsWith("9")) digits = defaultCountry + digits;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Etiquetas separadas por coma/salto de línea: minúsculas, sin repetidas, máx. 20 de 30 caracteres. */
export function parseTags(raw: string): string[] {
  const tags = raw
    .split(/[,\n]+/)
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((t) => t.length > 0 && t.length <= 30);
  return [...new Set(tags)].slice(0, 20);
}

/** Escapa un valor para CSV (RFC 4180) y neutraliza fórmulas de Excel (=, +, -, @) para evitar inyección. */
export function csvCell(value: string | null | undefined): string {
  let s = value ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
