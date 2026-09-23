import { requireUser } from "@/lib/session";
import { Board } from "./board";
import { CAMPOS_LEAD, COLUMNAS, HUMANO, ORDEN, POR_COLUMNA, toBoardLead, type BoardLead, type Columna, type LeadRow } from "./orden";

export default async function PipelinePage() {
  // «Tablero Leads»: la misma gente que Contactos, ordenada por etapa.
  const { supabase, profile } = await requireUser();

  // Quién espera a una persona manda sobre su etapa, así que esos leads no deben salir además en su columna.
  // Se piden solo los ids (son los chats pendientes de atender: una lista corta por definición).
  const { data: pendientes } = await supabase
    .from("conversations")
    .select("lead_id")
    .eq("requires_human", true)
    .limit(1000);
  const idsHumano = (pendientes ?? []).map((c) => c.lead_id as string);

  /** Una columna: sus primeras tarjetas y cuántas hay en total. */
  async function columna(status: Columna): Promise<{ leads: BoardLead[]; total: number }> {
    if (status === HUMANO) {
      // Se consulta desde `conversations` porque el orden lo marca su último mensaje, no nada del lead.
      let q = supabase
        .from("conversations")
        .select(`lead_id, leads!inner(${CAMPOS_LEAD})`, { count: "exact" })
        .eq("requires_human", true)
        .eq("leads.opt_out", false)
        .is("leads.archived_at", null);
      for (const o of ORDEN[status]) q = q.order(o.col, { ascending: o.ascending, nullsFirst: o.nullsFirst });
      const { data, count } = await q.limit(POR_COLUMNA);
      const leads = (data ?? []).map((r) => toBoardLead(r.leads as unknown as LeadRow));
      return { leads, total: count ?? leads.length };
    }

    let q = supabase
      .from("leads")
      .select(CAMPOS_LEAD, { count: "exact" })
      .eq("stage", status)
      .eq("opt_out", false)
      .is("archived_at", null);
    if (idsHumano.length) q = q.not("id", "in", `(${idsHumano.join(",")})`);
    for (const o of ORDEN[status]) q = q.order(o.col, { ascending: o.ascending, nullsFirst: o.nullsFirst });
    const { data, count } = await q.limit(POR_COLUMNA);
    const leads = (data ?? []).map((l) => toBoardLead(l as unknown as LeadRow));
    return { leads, total: count ?? leads.length };
  }

  const [columnas, { data: branches }] = await Promise.all([
    Promise.all(COLUMNAS.map(async (c) => [c, await columna(c)] as const)),
    supabase.from("branches").select("id, nombre").eq("activa", true).order("nombre"),
  ]);

  const inicial = Object.fromEntries(columnas.map(([c, v]) => [c, v.leads])) as Record<Columna, BoardLead[]>;
  const totales = Object.fromEntries(columnas.map(([c, v]) => [c, v.total])) as Record<Columna, number>;

  return (
    <div className="page page-wide">
      <h1>Tablero Leads</h1>
      <Board initial={inicial} totales={totales} branches={branches ?? []} userId={profile.id} />
    </div>
  );
}
