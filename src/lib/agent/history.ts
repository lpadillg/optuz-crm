/** Turno de la conversación en el formato común a las APIs de chat: el cliente es `user`; el bot y los asesores, `assistant`. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

const KIND: Record<string, string> = { image: "una imagen", video: "un video", audio: "una nota de voz", document: "un documento", sticker: "un sticker" };

/** Lo que ve el modelo cuando el cliente manda un archivo sin texto (no puede verlo). */
function placeholderFor(attachments: { type?: string }[]): string {
  const kind = KIND[attachments[0]?.type ?? ""] ?? "un archivo adjunto";
  return `[El cliente envió ${kind}]`;
}

/**
 * Historial de la BD → turnos alternados user/assistant.
 * Los mensajes del bot y los de un asesor humano son ambos "assistant"; los consecutivos del mismo rol se unen;
 * y el primero siempre es del cliente.
 */
export function toTurns(rows: { direction: string; content: string; attachments: unknown }[]): Turn[] {
  const turns: Turn[] = [];
  for (const row of rows) {
    const hasAttachments = Array.isArray(row.attachments) && row.attachments.length > 0;
    const text = row.content || (hasAttachments ? placeholderFor(row.attachments as { type?: string }[]) : "");
    if (!text) continue;
    const role = row.direction === "in" ? "user" : "assistant";
    const last = turns.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}
