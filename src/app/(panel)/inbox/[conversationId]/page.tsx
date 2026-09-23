import { after } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { MESSAGE_PAGE, type AppointmentStatus, type LeadOrigin, type LeadStage, type MessageRow, type NoteRow } from "@/lib/types";
import { showRead } from "@/lib/whatsapp/client";
import { Thread } from "./thread";

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const { supabase, profile } = await requireUser();

  const { data: conv } = await supabase
    .from("conversations")
    .select(
      "id, bot_active, requires_human, handoff_reason, handoff_summary, escalated_at, assigned_to, leads(id, nombre, phone, stage, origin, tags, opt_out, archived_at, archive_reason, created_at, branches(nombre))",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) notFound(); // no existe, o RLS no lo deja ver (otra sucursal)

  // Abrirlo es leerlo. Se marca aquí, y no al responder, porque lo que hay que distinguir en la bandeja es
  // lo que nadie ha visto todavía: un chat que alguien ya miró no debe seguir gritando.
  await supabase.from("conversations").update({ last_read_at: new Date().toISOString() }).eq("id", conversationId);

  // Y el cliente también tiene que verlo: sus dos palomitas se ponen azules. Sin esto ve su mensaje entregado
  // pero nunca leído aunque alguien lo esté mirando, que es lo que le hace volver a escribir «hola?».
  // Va en `after()` para que el acuse a Meta no retrase la carga del chat.
  after(async () => {
    const { data: ultimo } = await supabase
      .from("messages")
      .select("wa_message_id")
      .eq("conversation_id", conversationId)
      .eq("direction", "in")
      .not("wa_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    await showRead(ultimo?.wa_message_id as string | null);
  });

  const lead = conv.leads as unknown as {
    id: string;
    nombre: string | null;
    phone: string | null;
    stage: LeadStage;
    origin: LeadOrigin;
    tags: string[];
    opt_out: boolean;
    archived_at: string | null;
    archive_reason: string | null;
    created_at: string;
    branches: { nombre: string } | null;
  };

  const [{ data: messages }, { data: notes }, { data: team }, { data: quick }, { data: appts }] = await Promise.all([
    supabase
      .from("messages")
      .select("id, direction, sender, content, attachments, created_at, author_id, delivery_status, feedback")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MESSAGE_PAGE),
    supabase
      .from("conversation_notes")
      .select("id, body, created_at, users(nombre)")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }),
    // A quién se puede asignar: RLS deja ver al equipo de la misma sucursal (al admin, a todos).
    supabase.from("users").select("id, nombre").order("nombre"),
    supabase.from("quick_replies").select("atajo, titulo, cuerpo").order("atajo"),
    // Sus citas: lo primero que se pregunta al abrir un chat es si ya tiene una y si suele venir.
    supabase.from("appointments").select("id, scheduled_at, status, branches(nombre)").eq("lead_id", lead.id).order("scheduled_at", { ascending: true }),
  ]);

  return (
    <Thread
      key={conv.id}
      conversationId={conv.id}
      userId={profile.id}
      userName={profile.nombre}
      lead={lead}
      appointments={(appts ?? []) as unknown as { id: string; scheduled_at: string; status: AppointmentStatus; branches: { nombre: string } | null }[]}
      team={(team ?? []) as { id: string; nombre: string }[]}
      quickReplies={(quick ?? []) as { atajo: string; titulo: string; cuerpo: string }[]}
      initialAssignedTo={conv.assigned_to}
      initialBotActive={conv.bot_active}
      initialRequiresHuman={conv.requires_human}
      handoffReason={conv.handoff_reason}
      handoffSummary={conv.handoff_summary}
      initialEscalated={!!conv.escalated_at}
      initialMessages={[...((messages ?? []) as MessageRow[])].reverse()}
      initialNotes={((notes ?? []) as unknown as { id: string; body: string; created_at: string; users: { nombre: string } | null }[]).map(
        (n): NoteRow => ({ id: n.id, body: n.body, created_at: n.created_at, author_name: n.users?.nombre ?? "—" }),
      )}
    />
  );
}
