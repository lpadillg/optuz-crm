import "server-only";
import { toFile } from "openai";
import { openai } from "@/lib/agent/llm";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Attachment } from "@/lib/types";

export const MEDIA_BUCKET = "chat-media";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/webm": "webm",
  "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};
/** Extensión de archivo a partir del tipo MIME (sin parámetros como «; codecs=opus»). */
export const extFor = (mime: string | undefined, filename?: string) =>
  EXT[(mime ?? "").split(";")[0].trim()] ?? (filename?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ?? "bin");

/** Descarga un medio de la Graph API: primero su URL temporal (GET /{id}), luego los bytes (con el mismo token). */
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string }> {
  const auth = { Authorization: `Bearer ${env.whatsappAccessToken}` };
  const meta = await fetch(`${env.graphBaseUrl}/${env.graphVersion}/${mediaId}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; error?: { message?: string } };
  if (!meta.ok || !info.url) throw new Error(`Meta no dio la URL del medio ${mediaId}: ${meta.status} ${info.error?.message ?? ""}`.trim());
  const res = await fetch(info.url, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`No se pudo descargar el medio ${mediaId}: HTTP ${res.status}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: info.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream" };
}

/**
 * Descarga el adjunto `index` de un mensaje, lo guarda en el almacenamiento privado y, si es una nota de voz,
 * la transcribe: el texto pasa a ser el contenido del mensaje (así lo ven el inbox y el agente).
 */
export async function processAttachment(messageId: string, index: number): Promise<void> {
  const db = createAdminClient();
  const { data: msg, error } = await db.from("messages").select("conversation_id, content, attachments, wa_message_id").eq("id", messageId).maybeSingle();
  if (error) throw error;
  if (!msg) return;
  const list = (msg.attachments as Attachment[]) ?? [];
  const att = list[index];
  if (!att?.id || att.storage_path) return; // no hay medio o ya está procesado (reintento)

  const { bytes, mime } = await downloadWhatsAppMedia(att.id);
  const path = `${msg.conversation_id}/${msg.wa_message_id ?? messageId}-${index}.${extFor(mime, att.filename)}`;
  const { error: upErr } = await db.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
  if (upErr) throw new Error(`No se pudo guardar el medio: ${upErr.message}`);

  const next: Attachment = { ...att, storage_path: path, size: bytes.length, mime_type: mime };
  let content = msg.content as string;
  if (att.type === "audio") {
    const text = await transcribe(bytes, mime, extFor(mime));
    next.transcript = text;
    if (!content) content = text ? `🎤 ${text}` : "🎤 [Nota de voz sin palabras reconocibles]";
  }
  list[index] = next;
  const { error: upd } = await db.from("messages").update({ attachments: list, content }).eq("id", messageId);
  if (upd) throw upd;
  // La vista previa del inbox la mantiene el trigger de inserción; aquí la actualizamos si este es el último mensaje.
  if (content !== msg.content) {
    await db.from("conversations").update({ last_message_preview: content.slice(0, 120) }).eq("id", msg.conversation_id);
  }
}

async function transcribe(bytes: Buffer, mime: string, ext: string): Promise<string> {
  const file = await toFile(bytes, `audio.${ext}`, { type: mime.split(";")[0] });
  const res = await openai().audio.transcriptions.create({ file, model: env.openaiTranscribeModel, language: "es" });
  return (res.text ?? "").trim();
}
