import { requireUser } from "@/lib/session";
import { firstOf, type LeadOrigin, type LeadStage } from "@/lib/types";
import { Board, type BoardLead } from "./board";

type ConvEmbed = {
  id: string;
  last_message_at: string;
  last_message_sender: "bot" | "humano" | "lead" | null;
  requires_human: boolean;
  assigned_to: string | null;
  assignee: { nombre: string } | { nombre: string }[] | null;
};

export default async function PipelinePage() {
  // «Tablero de leads»: la misma gente que Contactos, ordenada por etapa.
  const { supabase, profile } = await requireUser();
  const [{ data, error }, { data: branches }] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, nombre, phone, stage, tags, branch_id, returned_at, origin, branches(nombre), conversations(id, last_message_at, last_message_sender, requires_human, assigned_to, assignee:users!assigned_to(nombre))",
      )
      .eq("opt_out", false)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase.from("branches").select("id, nombre").eq("activa", true).order("nombre"),
  ]);
  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    id: string;
    nombre: string | null;
    phone: string | null;
    stage: LeadStage;
    tags: string[];
    branch_id: string | null;
    returned_at: string | null;
    origin: LeadOrigin;
    branches: { nombre: string } | null;
    conversations: ConvEmbed | ConvEmbed[] | null;
  }[];

  // Quién llegó a ver horarios concretos: estuvo a un paso de agendar. Es un hecho registrado, no un juicio.
  const { data: runs } = await supabase
    .from("agent_runs")
    .select("lead_id, tool_calls")
    .not("lead_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(3000);
  const sawSlots = new Set(
    (runs ?? [])
      .filter((r) => ((r.tool_calls ?? []) as { name: string }[]).some((t) => t.name === "get_availability" || t.name === "next_available_slots"))
      .map((r) => r.lead_id as string),
  );

  const leads: BoardLead[] = rows.map((l) => {
    const conv = firstOf(l.conversations);
    return {
      id: l.id,
      nombre: l.nombre,
      phone: l.phone,
      stage: l.stage,
      tags: l.tags,
      branchId: l.branch_id,
      branch: l.branches?.nombre ?? null,
      conversationId: conv?.id ?? null,
      lastMessageAt: conv?.last_message_at ?? null,
      waitingOnClient: conv?.last_message_sender !== "lead",
      sawSlots: sawSlots.has(l.id),
      returnedAt: l.returned_at,
      origin: l.origin,
      requiresHuman: conv?.requires_human ?? false,
      assignedTo: conv?.assigned_to ?? null,
      assigneeName: firstOf(conv?.assignee)?.nombre ?? null,
    };
  });

  return (
    <div className="page page-wide">
      <h1>Tablero de leads</h1>
      <Board initial={leads} branches={branches ?? []} userId={profile.id} />
    </div>
  );
}
