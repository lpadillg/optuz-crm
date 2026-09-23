import { z } from "zod";

/**
 * Webhook de la WhatsApp Cloud API (campo `messages`):
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 * Identidad de usuarios (BSUID): https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
 *
 * Meta no manda un id de evento: una misma entrega puede traer varios mensajes y estados. Cada uno se procesa y se
 * deduplica por su propio id (`msg:<wamid>` / `status:<wamid>:failed`). Los esquemas son permisivos (looseObject).
 */
const contactSchema = z.looseObject({
  wa_id: z.string().optional(), // teléfono; ausente si el cliente lo oculta (usuarios de WhatsApp)
  user_id: z.string().optional(), // BSUID
  profile: z.looseObject({ name: z.string().optional() }).optional(),
});

const mediaSchema = z.looseObject({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const messageSchema = z.looseObject({
  id: z.string(),
  from: z.string().optional(), // teléfono; ausente si el cliente lo oculta
  from_user_id: z.string().optional(), // BSUID
  type: z.string(),
  text: z.looseObject({ body: z.string().optional() }).optional(),
  button: z.looseObject({ text: z.string().optional() }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ title: z.string().optional() }).optional(),
      list_reply: z.looseObject({ title: z.string().optional() }).optional(),
    })
    .optional(),
  location: z.looseObject({ latitude: z.number().optional(), longitude: z.number().optional(), name: z.string().optional(), address: z.string().optional() }).optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  // Anuncio Click-to-WhatsApp (solo en el primer mensaje, y solo con "Ads attribution" activado en la cuenta).
  referral: z.looseObject({ source_id: z.string().optional(), source_type: z.string().optional(), ctwa_clid: z.string().optional() }).optional(),
});

const statusSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  recipient_id: z.string().optional(),
  recipient_user_id: z.string().optional(),
  errors: z.array(z.looseObject({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() })).optional(),
});

const valueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string().optional() }).optional(),
  contacts: z.array(contactSchema).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
});

/** Envoltorio mínimo: cada `change` se valida aparte para que uno raro no tumbe el resto de la entrega. */
export const whatsappEnvelopeSchema = z.looseObject({
  object: z.string(),
  entry: z.array(z.looseObject({ changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).optional() })).optional(),
});

export interface InboundMessage {
  waMessageId: string;
  /** E.164, o null si el cliente usa un usuario de WhatsApp sin número visible. */
  phone: string | null;
  /** Business-scoped user id (`user_id`): ancla de identidad; Meta lo manda siempre desde abril de 2026. */
  bsuid: string | null;
  name: string | null;
  text: string;
  attachments: unknown[];
  /** Datos del anuncio Click-to-WhatsApp, si el mensaje viene de uno. */
  referral: { adId: string | null; ctwaClid: string | null } | null;
}

export interface SendFailure {
  /** id (wamid) del mensaje nuestro que falló: sirve para ubicar la conversación. */
  waMessageId: string;
  phone: string | null;
  bsuid: string | null;
  /** p. ej. "131047 · Re-engagement message" (ventana de 24 h cerrada). */
  reason: string;
}

export type WebhookItem =
  | { kind: "message"; key: string; message: InboundMessage }
  | { kind: "failure"; key: string; failure: SendFailure }
  | { kind: "status"; key: string; status: { waMessageId: string; status: "sent" | "delivered" | "read" } };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Normaliza a E.164 (+51999999999). */
export function normalizePhone(raw: string): string {
  return `+${raw.replace(/\D/g, "")}`;
}

type Message = z.infer<typeof messageSchema>;

/** Texto y adjuntos según el tipo de mensaje. */
function contentOf(m: Message): { text: string; attachments: unknown[] } {
  const media = (["image", "video", "audio", "document", "sticker"] as const).find((t) => m.type === t);
  if (media) {
    const x = m[media];
    return { text: x?.caption ?? "", attachments: [{ type: media, id: x?.id, mime_type: x?.mime_type, filename: x?.filename }] };
  }
  switch (m.type) {
    case "text":
      return { text: m.text?.body ?? "", attachments: [] };
    case "button":
      return { text: m.button?.text ?? "", attachments: [] };
    case "interactive":
      return { text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "", attachments: [] };
    case "location": {
      const l = m.location;
      const label = [l?.name, l?.address].filter(Boolean).join(" · ");
      return { text: `📍 ${label ? `${label} ` : ""}(${l?.latitude}, ${l?.longitude})`, attachments: [] };
    }
    case "contacts":
      return { text: "[Contacto compartido]", attachments: [] };
    case "unsupported":
      return { text: "[Mensaje de un tipo que no podemos ver]", attachments: [] };
    default:
      return { text: "", attachments: [] }; // reaction, request_welcome, system…: sin contenido para el chat
  }
}

/**
 * Cuerpo del webhook → mensajes de clientes y envíos fallidos de nuestro número.
 * `phoneNumberId` filtra: si el WABA tiene más números, solo interesan los de este CRM.
 */
export function extractItems(body: z.infer<typeof whatsappEnvelopeSchema>, phoneNumberId: string): WebhookItem[] {
  if (body.object !== "whatsapp_business_account") return [];
  const items: WebhookItem[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const parsed = valueSchema.safeParse(change.value);
      if (!parsed.success) continue;
      const value = parsed.data;
      if (value.metadata?.phone_number_id !== phoneNumberId) continue;
      const contacts = value.contacts ?? [];

      for (const m of value.messages ?? []) {
        const contact =
          contacts.find((c) => (c.wa_id && c.wa_id === m.from) || (c.user_id && c.user_id === m.from_user_id)) ?? contacts[0];
        const bsuid = str(m.from_user_id) ?? str(contact?.user_id);
        const rawPhone = str(m.from) ?? str(contact?.wa_id);
        const phone = rawPhone ? normalizePhone(rawPhone) : null;
        if (!phone && !bsuid) continue;

        const { text, attachments } = contentOf(m);
        if (!text && attachments.length === 0) continue;

        const ref = m.referral;
        const adId = str(ref?.source_id);
        const ctwaClid = str(ref?.ctwa_clid);
        items.push({
          kind: "message",
          key: `msg:${m.id}`,
          message: {
            waMessageId: m.id,
            phone,
            bsuid,
            name: str(contact?.profile?.name),
            text,
            attachments,
            referral: adId || ctwaClid ? { adId, ctwaClid } : null,
          },
        });
      }

      for (const s of value.statuses ?? []) {
        if (s.status === "sent" || s.status === "delivered" || s.status === "read") {
          // Estado de entrega de un mensaje nuestro: se refleja en el chat (✓ ✓✓ leído).
          items.push({ kind: "status", key: `status:${s.id}:${s.status}`, status: { waMessageId: s.id, status: s.status } });
          continue;
        }
        if (s.status !== "failed") continue;
        const e = s.errors?.[0];
        const reason = [e?.code, e?.title ?? e?.message].filter(Boolean).join(" · ") || "error desconocido";
        const rawPhone = str(s.recipient_id);
        items.push({
          kind: "failure",
          key: `status:${s.id}:failed`,
          failure: {
            waMessageId: s.id,
            phone: rawPhone && /^\d{7,15}$/.test(rawPhone) ? normalizePhone(rawPhone) : null,
            bsuid: str(s.recipient_user_id) ?? (rawPhone && !/^\d{7,15}$/.test(rawPhone) ? rawPhone : null),
            reason,
          },
        });
      }
    }
  }
  return items;
}
