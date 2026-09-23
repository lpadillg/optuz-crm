import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyChallenge, verifyMetaSignature } from "./verify";

const secret = "app-secret";
const body = '{"object":"whatsapp_business_account","entry":[]}';
const sig = (b: Buffer | string, s = secret) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

describe("verifyMetaSignature (X-Hub-Signature-256)", () => {
  it("acepta una firma válida", () => {
    expect(verifyMetaSignature(body, sig(body), secret)).toBe(true);
  });

  it("firma sobre los bytes crudos: un cuerpo con no-ASCII escapado (\\u00e9) verifica", () => {
    const raw = Buffer.from('{"text":"caf\\u00e9 \\ud83d\\ude00"}', "utf8");
    expect(verifyMetaSignature(raw, sig(raw), secret)).toBe(true);
  });

  it("acepta hex en mayúsculas", () => {
    expect(verifyMetaSignature(body, `sha256=${sig(body).slice(7).toUpperCase()}`, secret)).toBe(true);
  });

  it("rechaza cuerpo alterado, otro secret, sin prefijo, sin header o de largo distinto", () => {
    expect(verifyMetaSignature(body + " ", sig(body), secret)).toBe(false);
    expect(verifyMetaSignature(body, sig(body, "otro"), secret)).toBe(false);
    expect(verifyMetaSignature(body, sig(body).slice(7), secret)).toBe(false);
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=abc", secret)).toBe(false);
  });
});

describe("verifyChallenge (GET de verificación del webhook)", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  it("devuelve el challenge si el token coincide", () => {
    expect(verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "12345" }), "tok")).toBe("12345");
  });

  it("null si el modo, el token o el challenge no corresponden", () => {
    expect(verifyChallenge(q({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1" }), "tok")).toBeNull();
    expect(verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "mal", "hub.challenge": "1" }), "tok")).toBeNull();
    expect(verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "tok" }), "tok")).toBeNull();
    expect(verifyChallenge(q({}), "tok")).toBeNull();
  });
});
