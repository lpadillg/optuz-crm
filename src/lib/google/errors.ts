/**
 * Traduce los errores de Google Calendar a algo que un humano pueda corregir. Los mensajes de la API son crípticos
 * ("Not Found", "Forbidden") y casi siempre significan lo mismo: el calendario no está compartido bien.
 * Sin dependencias: se usa desde el panel y desde las pruebas.
 */
export function explainGoogleError(err: unknown, serviceAccountEmail?: string): string {
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number; data?: { error?: string | { message?: string; errors?: { reason?: string }[] }; error_description?: string } };
    errors?: { reason?: string }[];
  };
  const message = String(e?.message ?? err ?? "");
  const data = e?.response?.data;
  const dataError = typeof data?.error === "string" ? data.error : data?.error?.message;
  const status = Number(e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : NaN));
  const reasons = [...(e?.errors ?? []), ...(typeof data?.error === "object" ? (data.error.errors ?? []) : [])].map((r) => r.reason);
  const all = `${message} ${dataError ?? ""} ${data?.error_description ?? ""} ${reasons.join(" ")}`.toLowerCase();
  const who = serviceAccountEmail ? ` (${serviceAccountEmail})` : "";

  if (/enotfound|etimedout|econnreset|econnrefused|eai_again|fetch failed|network/.test(all)) {
    return "No se pudo conectar con Google (¿sin internet o bloqueado por un firewall?). Reintenta en un momento.";
  }
  if (/invalid_grant|invalid_client|unauthorized_client|invalid_rsa|private key|pem routines|asn1|decoder/.test(all) || status === 401) {
    return "Google rechazó las credenciales: la clave es inválida, fue eliminada o está mal copiada. Genera una clave JSON nueva en Google Cloud y vuelve a instalarla con «npm run google -- key».";
  }
  if (/accessnotconfigured|has not been used|is disabled|service_disabled/.test(all)) {
    return "Falta habilitar la API de Google Calendar en tu proyecto de Google Cloud (Biblioteca de APIs → Google Calendar API → Habilitar).";
  }
  if (/write.?access.?required|insufficient.?permission|forbidden.?for.?non.?organizer|cannot write|read.?only/.test(all) || status === 403) {
    return `El calendario se ve pero NO se puede editar: en Google Calendar → Configuración del calendario → «Compartir con personas concretas», el permiso de la cuenta${who} debe ser «Hacer cambios en eventos».`;
  }
  if (status === 404 || /(^|[^a-z])not.?found/.test(all)) {
    return `No encuentro ese calendario. Revisa que el ID esté bien copiado (Configuración del calendario → «Integrar el calendario») y que esté compartido con la cuenta${who || " de servicio"}.`;
  }
  return `Google respondió con un error: ${message || "desconocido"}`;
}
