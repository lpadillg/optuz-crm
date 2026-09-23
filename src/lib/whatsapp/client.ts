import "server-only";
import { env } from "@/lib/env";
import type { Interactive } from "./interactive";

export interface Recipient {
  /** E.164 (con o sin "+"). */
  phone: string | null;
  /** BSUID: para clientes de los que no vemos el número. */
  bsuid: string | null;
}

/** Error de la Graph API con el código de Meta (p. ej. 131047 = ventana de 24 h cerrada, 190 = token vencido). */
export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}

/**
 * POST /{version}/{phone-number-id}/messages con el destinatario resuelto: con teléfono se manda `to`; sin teléfono
 * (usuario de WhatsApp), `recipient` con el BSUID. Si vienen ambos, Meta usa el teléfono.
 */
async function postMessage(to: Recipient, content: Record<string, unknown>): Promise<{ id: string | null }> {
  if (!to.phone && !to.bsuid) throw new WhatsAppApiError("El lead no tiene teléfono ni BSUID", 0);

  const body: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", ...content };
  if (to.phone) body.to = to.phone.replace(/^\+/, "");
  else body.recipient = to.bsuid;

  const res = await fetch(`${env.graphBaseUrl}/${env.graphVersion}/${env.whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.whatsappAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    messages?: { id?: string }[];
    error?: { message?: string; code?: number; error_data?: { details?: string } };
  };
  if (!res.ok) {
    const e = data.error;
    throw new WhatsAppApiError(
      `WhatsApp API ${res.status}: ${e?.code ?? "?"} ${e?.message ?? ""} ${e?.error_data?.details ?? ""}`.trim(),
      res.status,
      e?.code,
    );
  }
  return { id: data.messages?.[0]?.id ?? null };
}

/**
 * Marca el mensaje del cliente como leído y le muestra «escribiendo…», para que sepa que estamos con lo suyo
 * mientras el agente consulta el calendario o piensa la respuesta.
 *
 * Meta lo dice claro: solo hay que mostrarlo si se va a responder. Se apaga solo al enviar la respuesta o a los
 * 25 segundos, lo que ocurra antes; si el agente se demora más, se vuelve a enviar.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators
 */
export async function sendTypingIndicator(waMessageId: string): Promise<void> {
  const res = await fetch(`${env.graphBaseUrl}/${env.graphVersion}/${env.whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.whatsappAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: waMessageId, typing_indicator: { type: "text" } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    throw new WhatsAppApiError(`WhatsApp API ${res.status}: ${data.error?.code ?? "?"} ${data.error?.message ?? ""}`.trim(), res.status, data.error?.code);
  }
}

/**
 * Marca como leído el mensaje del cliente: en su teléfono aparecen las dos palomitas azules.
 *
 * Es lo mismo que hace `sendTypingIndicator` pero sin el «escribiendo…»: sirve para cuando un asesor abre el
 * chat y todavía no está redactando nada. Sin esto, el cliente ve su mensaje entregado pero no leído aunque
 * alguien lo esté mirando, que es justo la señal que hace que vuelva a escribir «hola?».
 */
export async function markWhatsAppRead(waMessageId: string): Promise<void> {
  const res = await fetch(`${env.graphBaseUrl}/${env.graphVersion}/${env.whatsappPhoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.whatsappAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: waMessageId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    throw new WhatsAppApiError(`WhatsApp API ${res.status}: ${data.error?.code ?? "?"} ${data.error?.message ?? ""}`.trim(), res.status, data.error?.code);
  }
}

/** Como el anterior, pero nunca lanza: el cliente no debe quedarse sin respuesta porque falle un acuse. */
export async function showRead(waMessageId: string | null | undefined): Promise<void> {
  if (!waMessageId) return;
  try {
    await markWhatsAppRead(waMessageId);
  } catch (err) {
    console.error("[whatsapp] no se pudo marcar como leído", err);
  }
}

/** Como el anterior, pero nunca lanza: es un detalle de cortesía y jamás debe impedir que se responda. */
export async function showTyping(waMessageId: string | null | undefined): Promise<void> {
  if (!waMessageId) return;
  try {
    await sendTypingIndicator(waMessageId);
  } catch (err) {
    console.error("[whatsapp] no se pudo mostrar «escribiendo…»", err);
  }
}

/**
 * Envía un texto por la Cloud API. Solo se acepta texto libre dentro de las 24 h posteriores al último mensaje del cliente;
 * después hace falta una plantilla aprobada y Meta responde con el código 131047.
 */
export async function sendWhatsAppText(to: Recipient, text: string): Promise<{ id: string | null }> {
  return postMessage(to, { type: "text", text: { body: text, preview_url: false } });
}

/** Botones de respuesta o lista (ver interactive.ts). Mismas reglas de ventana de 24 h que el texto. */
export async function sendWhatsAppInteractive(to: Recipient, interactive: Interactive): Promise<{ id: string | null }> {
  return postMessage(to, { type: "interactive", interactive });
}

/** Mensaje de plantilla aprobada (única forma de escribir fuera de la ventana de 24 h). `params` rellena {{1}}, {{2}}… del cuerpo. */
export async function sendWhatsAppTemplate(to: Recipient, name: string, language: string, params: string[]): Promise<{ id: string | null }> {
  return postMessage(to, {
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(params.length && { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }),
    },
  });
}
