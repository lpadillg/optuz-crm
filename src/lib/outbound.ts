import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppInteractive, sendWhatsAppTemplate, sendWhatsAppText } from "@/lib/whatsapp/client";
import { buildInteractive , type Option } from "@/lib/whatsapp/interactive";

/**
 * Envía un texto a un cliente de una conversación y lo guarda en el hilo como mensaje del bot.
 * `meta` etiqueta su origen (p. ej. {kind:"reminder", appointment_id}) para poder reconocer la respuesta del cliente.
 * Devuelve el id del mensaje guardado.
 */
export async function sendBotText(
  conversationId: string,
  text: string,
  meta: Record<string, unknown> = {},
): Promise<string | null> {
  const db = createAdminClient();
  const { data: conv, error } = await db.from("conversations").select("leads(phone, bsuid)").eq("id", conversationId).single();
  if (error) throw error;
  const lead = conv.leads as unknown as { phone: string | null; bsuid: string | null };
  const sent = await sendWhatsAppText({ phone: lead.phone ?? null, bsuid: lead.bsuid ?? null }, text);
  const { data: inserted, error: insErr } = await db
    .from("messages")
    .insert({ conversation_id: conversationId, direction: "out", sender: "bot", content: text, wa_message_id: sent.id, meta })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return (inserted?.id as string | undefined) ?? null;
}

/**
 * Envía un mensaje con botones (hasta 3 opciones) o lista (hasta 10) y lo guarda en el hilo como mensaje del bot.
 * El texto guardado es el cuerpo seguido de las opciones, para que el inbox muestre lo mismo que ve el cliente.
 */
export async function sendBotOptions(
  conversationId: string,
  body: string,
  options: Option[],
  meta: Record<string, unknown> = {},
): Promise<string | null> {
  const db = createAdminClient();
  const built = buildInteractive(body, options);
  const { data: conv, error } = await db.from("conversations").select("leads(phone, bsuid)").eq("id", conversationId).single();
  if (error) throw error;
  const lead = conv.leads as unknown as { phone: string | null; bsuid: string | null };
  const sent = await sendWhatsAppInteractive({ phone: lead.phone ?? null, bsuid: lead.bsuid ?? null }, built.interactive);
  const { data: inserted, error: insErr } = await db
    .from("messages")
    .insert({ conversation_id: conversationId, direction: "out", sender: "bot", content: built.preview, wa_message_id: sent.id, meta: { ...meta, options: built.options } })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return (inserted?.id as string | undefined) ?? null;
}

/** Envía una plantilla aprobada (fuera de la ventana de 24 h) y guarda en el hilo el texto ya rellenado. */
export async function sendBotTemplate(
  conversationId: string,
  name: string,
  language: string,
  params: string[],
  renderedText: string,
  meta: Record<string, unknown> = {},
): Promise<string | null> {
  const db = createAdminClient();
  const { data: conv, error } = await db.from("conversations").select("leads(phone, bsuid)").eq("id", conversationId).single();
  if (error) throw error;
  const lead = conv.leads as unknown as { phone: string | null; bsuid: string | null };
  const sent = await sendWhatsAppTemplate({ phone: lead.phone ?? null, bsuid: lead.bsuid ?? null }, name, language, params);
  const { data: inserted, error: insErr } = await db
    .from("messages")
    .insert({ conversation_id: conversationId, direction: "out", sender: "bot", content: renderedText, wa_message_id: sent.id, meta })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return (inserted?.id as string | undefined) ?? null;
}
