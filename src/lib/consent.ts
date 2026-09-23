import "server-only";
import { createHash } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";

type Db = ReturnType<typeof createAdminClient>;
export type ConsentKind = "atencion" | "promociones";
export type ConsentChannel = "whatsapp" | "panel" | "sistema";

/** Versión de los textos que se le muestran al cliente (aviso del primer mensaje, pregunta de re-alta, confirmaciones). */
export const CONSENT_TEXT_VERSION = "v2";

interface Entry {
  leadId: string;
  channel: ConsentChannel;
  /** Lo que escribió el cliente, o el motivo del equipo. */
  evidence?: string | null;
  waMessageId?: string | null;
  actorId?: string | null;
}

async function log(db: Db, kind: ConsentKind, action: "otorgado" | "revocado", e: Entry) {
  const { error } = await db.from("consent_log").insert({
    lead_id: e.leadId,
    kind,
    action,
    channel: e.channel,
    evidence: e.evidence?.slice(0, 500) ?? null,
    wa_message_id: e.waMessageId ?? null,
    actor_id: e.actorId ?? null,
    text_version: CONSENT_TEXT_VERSION,
  });
  if (error) throw error;
}

/** BAJA: no más mensajes automáticos. Revoca la atención y las promociones. */
export async function revokeAll(db: Db, e: Entry) {
  const { error } = await db.from("leads").update({ opt_out: true, promo_consent: false }).eq("id", e.leadId);
  if (error) throw error;
  await log(db, "atencion", "revocado", e);
  await log(db, "promociones", "revocado", e);
}

/** ALTA / re-consentimiento: vuelve a poder atenderse. NO otorga promociones (eso es un consentimiento aparte). */
export async function grantAttention(db: Db, e: Entry) {
  const { error } = await db.from("leads").update({ opt_out: false }).eq("id", e.leadId);
  if (error) throw error;
  await log(db, "atencion", "otorgado", e);
}

/** El cliente aceptó, de forma explícita, recibir promociones. */
export async function grantPromotions(db: Db, e: Entry) {
  const { error } = await db.from("leads").update({ promo_consent: true }).eq("id", e.leadId);
  if (error) throw error;
  await log(db, "promociones", "otorgado", e);
}

/** Cuándo se dio de baja por última vez (null si no consta). */
export async function lastRevocationAt(db: Db, leadId: string): Promise<Date | null> {
  const { data, error } = await db
    .from("consent_log")
    .select("created_at")
    .eq("lead_id", leadId)
    .eq("kind", "atencion")
    .eq("action", "revocado")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] ? new Date(data[0].created_at as string) : null;
}

/** Identificador irreversible para dejar constancia de una eliminación sin conservar el dato. */
export function subjectHash(phone: string | null, bsuid: string | null): string {
  return createHash("sha256").update(`${phone ?? ""}|${bsuid ?? ""}`).digest("hex");
}
