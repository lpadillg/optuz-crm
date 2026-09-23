import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Cada POST de Meta trae `X-Hub-Signature-256: sha256=<hex>`: HMAC-SHA256 del cuerpo CRUDO con el App Secret de la app.
 * Se calcula sobre los bytes tal como llegaron (Meta escapa los no-ASCII; re-serializar el JSON cambia el resultado).
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(expected, header.slice("sha256=".length).trim().toLowerCase());
}

/**
 * Verificación del webhook (GET): Meta llama con hub.mode=subscribe, hub.verify_token y hub.challenge.
 * Si el token coincide, hay que responder con el challenge tal cual; si no, 403.
 */
export function verifyChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (!token || !challenge || !safeEqual(token, verifyToken)) return null;
  return challenge;
}
