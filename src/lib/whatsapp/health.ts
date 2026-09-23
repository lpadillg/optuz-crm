import "server-only";
import { env } from "@/lib/env";

export interface NumberHealth {
  display_phone_number?: string;
  verified_name?: string;
  /** GREEN | YELLOW | RED | UNKNOWN */
  quality_rating?: string;
  /** TIER_50 | TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED */
  messaging_limit_tier?: string;
  status?: string;
  name_status?: string;
}

/** Calidad y límite de mensajes del número, tal como los ve Meta (Graph API). Nunca lanza. */
export async function fetchNumberHealth(): Promise<{ ok: true; data: NumberHealth } | { ok: false; error: string }> {
  try {
    const fields = "display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status";
    const res = await fetch(`${env.graphBaseUrl}/${env.graphVersion}/${env.whatsappPhoneNumberId}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${env.whatsappAccessToken}` },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as NumberHealth & { error?: { message?: string; code?: number } };
    if (!res.ok) return { ok: false, error: `${data.error?.code ?? res.status} · ${data.error?.message ?? "Meta rechazó la consulta"}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Traduce los valores de Meta a algo entendible. */
export const QUALITY_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "err" | "" }> = {
  GREEN: { text: "Alta (verde)", tone: "ok" },
  YELLOW: { text: "Media (amarillo): cuidado con los bloqueos", tone: "warn" },
  RED: { text: "Baja (rojo): riesgo de restricción", tone: "err" },
  UNKNOWN: { text: "Sin calificar todavía", tone: "" },
};

export const TIER_LABEL: Record<string, string> = {
  TIER_50: "50 conversaciones nuevas por día",
  TIER_250: "250 conversaciones nuevas por día",
  TIER_1K: "1.000 conversaciones nuevas por día",
  TIER_10K: "10.000 conversaciones nuevas por día",
  TIER_100K: "100.000 conversaciones nuevas por día",
  TIER_UNLIMITED: "Sin límite diario",
};
