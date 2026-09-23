import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LEAD_ORIGINS, LEAD_STAGES, type LeadOrigin, type LeadStage } from "@/lib/types";

export interface LeadFilters {
  q?: string;
  stage?: LeadStage;
  origin?: LeadOrigin;
  branch?: string;
  tag?: string;
}

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Filtros desde los query params (validados: nada de lo que llega se interpola sin limpiar en el filtro `or`). */
export function parseLeadFilters(sp: Record<string, Param>): LeadFilters {
  const stage = first(sp.stage);
  const origin = first(sp.origin);
  return {
    q: first(sp.q)?.slice(0, 80),
    stage: LEAD_STAGES.find((s) => s === stage),
    origin: LEAD_ORIGINS.find((o) => o === origin),
    branch: first(sp.branch),
    tag: first(sp.tag)?.toLowerCase().slice(0, 30),
  };
}

export const LEAD_COLUMNS =
  "id, nombre, phone, email, stage, archived_at, archive_reason, source, origin, opt_out, promo_consent, tags, created_at, branches(nombre), conversations(id)";

export function queryLeads(supabase: SupabaseClient, f: LeadFilters, limit = 500) {
  let query = supabase.from("leads").select(LEAD_COLUMNS).order("created_at", { ascending: false }).limit(limit);
  if (f.stage) query = query.eq("stage", f.stage);
  if (f.origin) query = query.eq("origin", f.origin);
  if (f.branch) query = query.eq("branch_id", f.branch);
  if (f.tag) query = query.contains("tags", [f.tag]);
  if (f.q) {
    // Se quitan los caracteres con significado en la sintaxis de filtros de PostgREST (, ( ) * % \).
    const term = f.q.replace(/[,()*%\\]/g, " ").trim();
    if (term) query = query.or(`nombre.ilike.*${term}*,phone.ilike.*${term}*,email.ilike.*${term}*`);
  }
  return query;
}
