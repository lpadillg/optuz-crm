import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: {
    graphBaseUrl: "https://graph.test",
    graphVersion: "v25.0",
    whatsappPhoneNumberId: "PNID",
    whatsappAccessToken: "TOKEN",
  },
}));

import { sendTypingIndicator, showTyping } from "./client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** El formato lo fija Meta: mismo endpoint que los mensajes, con `status: "read"` y el wamid del mensaje entrante. */
describe("«escribiendo…» mientras el agente prepara la respuesta", () => {
  it("va al endpoint de mensajes con el cuerpo exacto que pide Meta", async () => {
    await sendTypingIndicator("wamid.ABC");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.test/v25.0/PNID/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
      typing_indicator: { type: "text" },
    });
  });

  it("el mismo aviso marca el mensaje del cliente como leído", async () => {
    await sendTypingIndicator("wamid.ABC");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe("read");
  });

  it("si Meta lo rechaza, se avisa con su código", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { code: 131009, message: "Parameter value is not valid" } }) });
    await expect(sendTypingIndicator("wamid.ABC")).rejects.toMatchObject({ status: 400, code: 131009 });
  });

  it("es un detalle de cortesía: un fallo NUNCA impide responder al cliente", async () => {
    fetchMock.mockRejectedValue(new Error("red caída"));
    await expect(showTyping("wamid.ABC")).resolves.toBeUndefined();
  });

  it("sin wamid no se llama a Meta", async () => {
    await showTyping(null);
    await showTyping(undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
