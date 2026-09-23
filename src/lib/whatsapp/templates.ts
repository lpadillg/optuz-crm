import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Plantillas de mensaje de WhatsApp (única forma de escribir a un cliente fuera de la ventana de 24 h).
 * Se crean en Meta (POST /{waba}/message_templates), Meta las revisa (minutos u horas) y quedan APPROVED o REJECTED.
 * Aquí se mantiene un espejo en la tabla `message_templates` para poder mostrarlas y elegir una aprobada al enviar.
 */

export interface TemplateDef {
  name: string;
  category: "UTILITY" | "MARKETING";
  language: string;
  /** Texto con variables {{1}}, {{2}}… */
  body: string;
  /** Un ejemplo por variable (Meta lo exige para aprobarla). */
  examples: string[];
}

/** Recordatorio de cita: {{1}} nombre, {{2}} día, {{3}} hora, {{4}} sucursal, {{5}} dirección. */
export const REMINDER_TEMPLATE: TemplateDef = {
  name: "cita_recordatorio",
  category: "UTILITY",
  language: "es",
  body: "Hola {{1}} 👋 Te recordamos tu evaluación visual gratuita el {{2}} a las {{3}} en la sucursal {{4}} ({{5}}). Responde 1 para confirmar, 2 para reprogramar o 3 para cancelar.",
  examples: ["María", "sábado 19 de septiembre", "10:00 a. m.", "Huánuco", "Jr. 28 de Julio 1131"],
};

/** Rellena {{1}}, {{2}}… (lo que ve el inbox como texto del mensaje enviado). */
export function renderTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}

const base = () => `${env.graphBaseUrl}/${env.graphVersion}/${env.whatsappBusinessAccountId}/message_templates`;
const auth = () => ({ Authorization: `Bearer ${env.whatsappAccessToken}`, "Content-Type": "application/json" });

interface MetaTemplate {
  id?: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejected_reason?: string;
  components?: { type: string; text?: string }[];
}

/** Trae las plantillas de Meta y actualiza el espejo local. Devuelve cuántas hay. */
export async function syncTemplates(): Promise<number> {
  if (!env.whatsappBusinessAccountId) throw new Error("Falta WHATSAPP_BUSINESS_ACCOUNT_ID en .env.local");
  const res = await fetch(`${base()}?fields=id,name,language,category,status,components,rejected_reason&limit=100`, { headers: auth(), signal: AbortSignal.timeout(15_000), cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { data?: MetaTemplate[]; error?: { message?: string; code?: number } };
  if (!res.ok) throw new Error(`Meta respondió ${res.status}: ${data.error?.code ?? ""} ${data.error?.message ?? ""}`.trim());

  const rows = (data.data ?? []).map((t) => ({
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    body: t.components?.find((c) => c.type === "BODY")?.text ?? "",
    components: t.components ?? [],
    meta_id: t.id ?? null,
    reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
    synced_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await createAdminClient().from("message_templates").upsert(rows, { onConflict: "name" });
    if (error) throw error;
  }
  return rows.length;
}

/** Envía la definición de una plantilla a Meta para su revisión. */
export async function createTemplate(def: TemplateDef): Promise<{ id?: string; status: string }> {
  if (!env.whatsappBusinessAccountId) throw new Error("Falta WHATSAPP_BUSINESS_ACCOUNT_ID en .env.local");
  const res = await fetch(base(), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      name: def.name,
      language: def.language,
      category: def.category,
      components: [{ type: "BODY", text: def.body, example: { body_text: [def.examples] } }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string; error_user_msg?: string; code?: number } };
  if (!res.ok) throw new Error(`Meta rechazó la plantilla: ${data.error?.error_user_msg ?? data.error?.message ?? res.status}`);
  const status = data.status ?? "PENDING";
  await createAdminClient().from("message_templates").upsert(
    { name: def.name, language: def.language, category: def.category, status, body: def.body, components: [], meta_id: data.id ?? null, synced_at: new Date().toISOString() },
    { onConflict: "name" },
  );
  return { id: data.id, status };
}

/** La plantilla aprobada con ese nombre (según el espejo local), o null. */
export async function getApprovedTemplate(name: string): Promise<{ name: string; language: string; body: string } | null> {
  const { data, error } = await createAdminClient().from("message_templates").select("name, language, body, status").eq("name", name).maybeSingle();
  if (error) throw error;
  return data && data.status === "APPROVED" ? { name: data.name as string, language: data.language as string, body: data.body as string } : null;
}
