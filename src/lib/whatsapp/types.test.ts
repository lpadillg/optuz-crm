import { describe, expect, it } from "vitest";
import { extractItems, normalizePhone, whatsappEnvelopeSchema } from "./types";

const PNID = "1092837465"; // phone_number_id del CRM

/** Cuerpo del webhook con una sola entrega (forma documentada por Meta). */
const body = (value: Record<string, unknown>, phoneNumberId = PNID) =>
  whatsappEnvelopeSchema.parse({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          { field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "51900000000", phone_number_id: phoneNumberId }, ...value } },
        ],
      },
    ],
  });

const contact = { profile: { name: "Ana" }, wa_id: "51999888777", user_id: "PE.13491208655302741918" };
const text = (over: Record<string, unknown> = {}) => ({
  from: "51999888777",
  from_user_id: "PE.13491208655302741918",
  id: "wamid.AAA",
  timestamp: "1789785399",
  type: "text",
  text: { body: "Hola" },
  ...over,
});

const messages = (value: Record<string, unknown>) => extractItems(body(value), PNID).flatMap((i) => (i.kind === "message" ? [i.message] : []));

describe("normalizePhone", () => {
  it("deja solo dígitos con prefijo +", () => {
    expect(normalizePhone("51 999-888-777")).toBe("+51999888777");
    expect(normalizePhone("+51999888777")).toBe("+51999888777");
  });
});

describe("extractItems: mensajes", () => {
  it("un texto de un cliente con teléfono y BSUID", () => {
    const items = extractItems(body({ contacts: [contact], messages: [text()] }), PNID);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "message",
      key: "msg:wamid.AAA",
      message: { waMessageId: "wamid.AAA", phone: "+51999888777", bsuid: "PE.13491208655302741918", name: "Ana", text: "Hola", referral: null },
    });
  });

  it("usuario de WhatsApp que oculta su número: sin `from`/`wa_id`, solo BSUID", () => {
    const [m] = messages({ contacts: [{ profile: { name: "Diego" }, user_id: "US.999" }], messages: [text({ from: undefined, from_user_id: "US.999" })] });
    expect(m.phone).toBeNull();
    expect(m.bsuid).toBe("US.999");
    expect(m.name).toBe("Diego");
  });

  it("un cliente sin BSUID en el payload (formato anterior) sigue funcionando por teléfono", () => {
    const [m] = messages({ contacts: [{ profile: { name: "Ana" }, wa_id: "51999888777" }], messages: [text({ from_user_id: undefined })] });
    expect(m.phone).toBe("+51999888777");
    expect(m.bsuid).toBeNull();
  });

  it("sin teléfono ni BSUID no se puede identificar al cliente: se descarta", () => {
    expect(messages({ contacts: [], messages: [text({ from: undefined, from_user_id: undefined })] })).toHaveLength(0);
  });

  it("varios mensajes en una misma entrega se procesan por separado, cada uno con su llave", () => {
    const items = extractItems(body({ contacts: [contact], messages: [text({ id: "wamid.1" }), text({ id: "wamid.2", text: { body: "¿Hay cita?" } })] }), PNID);
    expect(items.map((i) => i.key)).toEqual(["msg:wamid.1", "msg:wamid.2"]);
  });

  it("asocia cada mensaje con SU contacto cuando la entrega trae varios", () => {
    const other = { profile: { name: "Luis" }, wa_id: "51911111111", user_id: "PE.777" };
    const ms = messages({
      contacts: [contact, other],
      messages: [text({ id: "wamid.1" }), text({ id: "wamid.2", from: "51911111111", from_user_id: "PE.777" })],
    });
    expect(ms.map((m) => m.name)).toEqual(["Ana", "Luis"]);
  });

  it("referral de un anuncio Click-to-WhatsApp: source_id y ctwa_clid", () => {
    const [m] = messages({ contacts: [contact], messages: [text({ referral: { source_url: "https://fb.me/x", source_id: "AD-123", source_type: "ad", ctwa_clid: "clid-9", headline: "Examen gratis" } })] });
    expect(m.referral).toEqual({ adId: "AD-123", ctwaClid: "clid-9" });
  });

  it("botones e interactivos: se toma el título elegido", () => {
    const [b, i, l] = messages({
      contacts: [contact],
      messages: [
        text({ id: "1", type: "button", text: undefined, button: { text: "Agendar cita" } }),
        text({ id: "2", type: "interactive", text: undefined, interactive: { button_reply: { id: "b1", title: "Sí" } } }),
        text({ id: "3", type: "interactive", text: undefined, interactive: { list_reply: { id: "l1", title: "Huánuco" } } }),
      ],
    });
    expect([b.text, i.text, l.text]).toEqual(["Agendar cita", "Sí", "Huánuco"]);
  });

  it("imagen con pie de foto: texto = caption y el adjunto conserva el id de media", () => {
    const [m] = messages({ contacts: [contact], messages: [text({ type: "image", text: undefined, image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "Mi receta" } })] });
    expect(m.text).toBe("Mi receta");
    expect(m.attachments).toEqual([{ type: "image", id: "MEDIA1", mime_type: "image/jpeg", filename: undefined }]);
  });

  it("audio sin texto: queda solo el adjunto (el agente le pedirá que lo escriba)", () => {
    const [m] = messages({ contacts: [contact], messages: [text({ type: "audio", text: undefined, audio: { id: "A1", mime_type: "audio/ogg" } })] });
    expect(m.text).toBe("");
    expect(m.attachments).toHaveLength(1);
  });

  it("ubicación: se convierte en texto legible", () => {
    const [m] = messages({ contacts: [contact], messages: [text({ type: "location", text: undefined, location: { latitude: -9.93, longitude: -76.24, name: "Mi casa" } })] });
    expect(m.text).toContain("Mi casa");
    expect(m.text).toContain("-9.93");
  });

  it("tipo no soportado: texto marcador; reacciones y mensajes sin contenido: se ignoran", () => {
    expect(messages({ contacts: [contact], messages: [text({ type: "unsupported", text: undefined })] })[0].text).toContain("no podemos ver");
    expect(messages({ contacts: [contact], messages: [text({ type: "reaction", text: undefined, reaction: { emoji: "👍" } })] })).toHaveLength(0);
  });
});

describe("extractItems: filtros y estados", () => {
  it("ignora mensajes de otro número del mismo WABA", () => {
    expect(extractItems(body({ contacts: [contact], messages: [text()] }, "OTRO_NUMERO"), PNID)).toHaveLength(0);
  });

  it("ignora objetos que no son de WhatsApp y campos que no son `messages`", () => {
    expect(extractItems(whatsappEnvelopeSchema.parse({ object: "page", entry: [] }), PNID)).toHaveLength(0);
    const env = whatsappEnvelopeSchema.parse({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "message_template_status_update", value: {} }] }] });
    expect(extractItems(env, PNID)).toHaveLength(0);
  });

  it("un `change` con forma inválida no tumba el resto de la entrega", () => {
    const env = whatsappEnvelopeSchema.parse({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            { field: "messages", value: "esto no es un objeto" },
            { field: "messages", value: { metadata: { phone_number_id: PNID }, contacts: [contact], messages: [text()] } },
          ],
        },
      ],
    });
    expect(extractItems(env, PNID)).toHaveLength(1);
  });

  it("estado `failed`: motivo con código y título (131047 = ventana de 24 h cerrada)", () => {
    const [item] = extractItems(
      body({ statuses: [{ id: "wamid.OUT", status: "failed", recipient_id: "51999888777", errors: [{ code: 131047, title: "Re-engagement message" }] }] }),
      PNID,
    );
    expect(item).toEqual({
      kind: "failure",
      key: "status:wamid.OUT:failed",
      failure: { waMessageId: "wamid.OUT", phone: "+51999888777", bsuid: null, reason: "131047 · Re-engagement message" },
    });
  });

  it("estado fallido de un usuario sin número: el destinatario es un BSUID", () => {
    const [item] = extractItems(body({ statuses: [{ id: "wamid.OUT", status: "failed", recipient_user_id: "US.999", errors: [] }] }), PNID);
    expect(item).toMatchObject({ kind: "failure", failure: { phone: null, bsuid: "US.999", reason: "error desconocido" } });
  });

  it("estados sent / delivered / read se registran como estado de entrega (uno por estado, con su llave de deduplicación)", () => {
    const statuses = ["sent", "delivered", "read"].map((status) => ({ id: "wamid.OUT", status, recipient_id: "51999888777" }));
    const items = extractItems(body({ statuses }), PNID);
    expect(items.map((i) => i.key)).toEqual(["status:wamid.OUT:sent", "status:wamid.OUT:delivered", "status:wamid.OUT:read"]);
    expect(items[2]).toMatchObject({ kind: "status", status: { waMessageId: "wamid.OUT", status: "read" } });
  });

  it("otros estados (p. ej. deleted) se ignoran", () => {
    expect(extractItems(body({ statuses: [{ id: "wamid.OUT", status: "deleted" }] }), PNID)).toHaveLength(0);
  });
});
