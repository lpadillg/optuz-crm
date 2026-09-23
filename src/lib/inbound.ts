import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InboundMessage, SendFailure } from "@/lib/whatsapp/types";

export interface IngestResult {
  leadId: string;
  conversationId: string;
  branchId: string | null;
  botActive: boolean;
  optOut: boolean;
  /** false si el mensaje ya estaba guardado (reintento del webhook). */
  isNewMessage: boolean;
  /** id del mensaje recién guardado (null si era un reintento). */
  messageId: string | null;
}

interface LeadRow {
  id: string;
  phone: string | null;
  bsuid: string | null;
  nombre: string | null;
  branch_id: string | null;
  opt_out: boolean;
  ad_id: string | null;
  ctwa_clid: string | null;
  origin: string;
}

const LEAD_COLUMNS = "id, phone, bsuid, nombre, branch_id, opt_out, ad_id, ctwa_clid, origin";

/** Sucursal cuya lista de campañas/anuncios de Meta contiene el anuncio del referral. */
async function detectBranchByAd(adId: string | null): Promise<string | null> {
  if (!adId) return null;
  const db = createAdminClient();
  const { data, error } = await db
    .from("branches")
    .select("id")
    .eq("activa", true)
    .contains("meta_campaign_ids", [adId])
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

/** Busca al lead por BSUID y, si no, por teléfono. */
async function findLead(ids: { bsuid: string | null; phone: string | null }): Promise<LeadRow | null> {
  const db = createAdminClient();
  if (ids.bsuid) {
    const { data, error } = await db.from("leads").select(LEAD_COLUMNS).eq("bsuid", ids.bsuid).maybeSingle();
    if (error) throw error;
    if (data) return data as LeadRow;
  }
  if (ids.phone) {
    const { data, error } = await db.from("leads").select(LEAD_COLUMNS).eq("phone", ids.phone).maybeSingle();
    if (error) throw error;
    if (data) return data as LeadRow;
  }
  return null;
}

/**
 * Persiste un mensaje entrante: lead (por BSUID o teléfono) → conversación (una por lead) → mensaje.
 * Idempotente: repetir la misma entrega no duplica nada.
 */
export async function ingestInboundMessage(msg: InboundMessage): Promise<IngestResult> {
  const db = createAdminClient();
  const branchFromAd = await detectBranchByAd(msg.referral?.adId ?? null);

  // 1. Lead
  let lead = await findLead(msg);
  if (!lead) {
    const { data, error } = await db
      .from("leads")
      .insert({
        phone: msg.phone,
        bsuid: msg.bsuid,
        nombre: msg.name,
        branch_id: branchFromAd,
        source: msg.referral ? "ctwa" : "otro",
        origin: msg.referral ? "anuncio" : "otro",
        ad_id: msg.referral?.adId ?? null,
        ctwa_clid: msg.referral?.ctwaClid ?? null,
        last_ad_id: msg.referral?.adId ?? null,
        last_ad_at: msg.referral ? new Date().toISOString() : null,
      })
      .select(LEAD_COLUMNS)
      .single();
    if (error) {
      // Carrera: otra entrega creó el lead entre la búsqueda y el insert.
      if (error.code !== "23505") throw error;
      lead = await findLead(msg);
      if (!lead) throw error;
    } else {
      lead = data as LeadRow;
    }
  } else {
    // Completar lo que ahora sabemos y antes no: teléfono/BSUID, nombre, y el anuncio si es la primera vez que viene de uno.
    const patch: Record<string, unknown> = {};
    if (!lead.phone && msg.phone) patch.phone = msg.phone;
    if (!lead.bsuid && msg.bsuid) patch.bsuid = msg.bsuid;
    if (!lead.nombre && msg.name) patch.nombre = msg.name;
    if (!lead.ad_id && msg.referral?.adId) patch.ad_id = msg.referral.adId;
    if (!lead.ctwa_clid && msg.referral?.ctwaClid) patch.ctwa_clid = msg.referral.ctwaClid;
    if (msg.referral && !lead.ad_id && !lead.ctwa_clid) patch.source = "ctwa";
    // El primer anuncio (`ad_id`) dice de dónde salió este cliente; este otro, qué campaña lo trajo esta vez.
    // Sin esto, una campaña que reactiva clientes viejos no se llevaría ningún crédito.
    if (msg.referral?.adId) {
      patch.last_ad_id = msg.referral.adId;
      patch.last_ad_at = new Date().toISOString();
      if (lead.origin === "otro") patch.origin = "anuncio";
    }
    if (!lead.branch_id && branchFromAd) patch.branch_id = branchFromAd;

    if (Object.keys(patch).length > 0) {
      const { error } = await db.from("leads").update(patch).eq("id", lead.id);
      // 23505: ese teléfono/BSUID ya pertenece a otro lead (mismo cliente con dos identidades). No se fusionan solos.
      if (error && error.code !== "23505") throw error;
      if (!error) lead = { ...lead, ...patch } as LeadRow;
    }
  }

  // 2. Conversación (única por lead)
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .upsert({ lead_id: lead.id }, { onConflict: "lead_id", ignoreDuplicates: false })
    .select("id, bot_active")
    .single();
  if (convErr) throw convErr;

  // 3. Mensaje (wa_message_id único → idempotente)
  const { data: inserted, error: msgErr } = await db
    .from("messages")
    .upsert(
      {
        conversation_id: conv.id,
        direction: "in",
        sender: "lead",
        content: msg.text,
        attachments: msg.attachments,
        wa_message_id: msg.waMessageId,
      },
      { onConflict: "wa_message_id", ignoreDuplicates: true },
    )
    .select("id");
  if (msgErr) throw msgErr;
  const isNewMessage = (inserted?.length ?? 0) > 0;

  return {
    leadId: lead.id,
    conversationId: conv.id,
    branchId: lead.branch_id,
    botActive: conv.bot_active,
    optOut: lead.opt_out,
    isNewMessage,
    messageId: (inserted?.[0]?.id as string | undefined) ?? null,
  };
}

/**
 * El motivo que ve el equipo en el chat. Los códigos de Meta no dicen nada a quien atiende: lo que necesita saber
 * es qué puede hacer.
 */
function motivoLegible(razon: string): string {
  if (razon.includes("131047")) {
    return "No se le pudo escribir: pasaron más de 24 h desde su último mensaje. WhatsApp solo deja retomar con una plantilla aprobada, o esperar a que él escriba. Si es urgente, llámalo.";
  }
  if (razon.includes("131026")) return "No se le pudo entregar el mensaje: ese número no tiene WhatsApp o no puede recibir mensajes.";
  if (razon.includes("131051")) return "No se le pudo entregar: WhatsApp no admite ese tipo de mensaje.";
  return `No se pudo entregar un mensaje: ${razon}`;
}

/**
 * Un envío nuestro falló (p. ej. ventana de 24 h cerrada, código 131047): que un vendedor lo vea en el inbox.
 * La conversación se ubica por el wamid del mensaje fallido y, si no está guardado, por el destinatario.
 */
export async function recordSendFailure(failure: SendFailure): Promise<boolean> {
  const db = createAdminClient();

  let conversationId: string | null = null;
  const { data: msg, error } = await db
    .from("messages")
    .select("conversation_id")
    .eq("wa_message_id", failure.waMessageId)
    .maybeSingle();
  if (error) throw error;
  conversationId = msg?.conversation_id ?? null;

  if (!conversationId) {
    const lead = await findLead({ bsuid: failure.bsuid, phone: failure.phone });
    if (lead) {
      const { data: conv, error: convErr } = await db.from("conversations").select("id").eq("lead_id", lead.id).maybeSingle();
      if (convErr) throw convErr;
      conversationId = conv?.id ?? null;
    }
  }
  if (!conversationId) return false;

  await db.from("messages").update({ delivery_status: "failed", delivery_updated_at: new Date().toISOString() }).eq("wa_message_id", failure.waMessageId);
  const { error: upErr } = await db
    .from("conversations")
    .update({ requires_human: true, handoff_reason: motivoLegible(failure.reason).slice(0, 300) })
    .eq("id", conversationId);
  if (upErr) throw upErr;
  return true;
}

const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 } as const;

/**
 * Actualiza el estado de entrega (enviado → entregado → leído) de un mensaje nuestro. Los estados llegan fuera de orden y
 * repetidos: solo se avanza, nunca se retrocede. Devuelve false si el mensaje no está guardado (aún o nunca).
 */
export async function recordDeliveryStatus(waMessageId: string, status: "sent" | "delivered" | "read"): Promise<boolean> {
  const db = createAdminClient();
  const { data, error } = await db.from("messages").select("id, delivery_status").eq("wa_message_id", waMessageId).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const current = DELIVERY_RANK[(data.delivery_status as keyof typeof DELIVERY_RANK | null) ?? "sent"] ?? 0;
  if (current >= DELIVERY_RANK[status]) return true;
  const { error: upErr } = await db.from("messages").update({ delivery_status: status, delivery_updated_at: new Date().toISOString() }).eq("id", data.id);
  if (upErr) throw upErr;
  return true;
}
