import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import { ConversationList, type ConversationItem } from "./conversation-list";

export default async function InboxLayout({ children }: { children: ReactNode }) {
  const { supabase, profile } = await requireUser();

  // RLS: un asesor con sucursal solo recibe las de la suya; sin sucursal (o administrador), todas.
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, bot_active, requires_human, assigned_to, escalated_at, last_message_at, last_message_preview, last_message_sender, last_read_at, leads(nombre, phone, branches(nombre)), assignee:users!assigned_to(nombre)",
    )
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  const items = (data ?? []) as unknown as ConversationItem[];

  return (
    <div className="inbox">
      <ConversationList items={items} userId={profile.id} />
      <section className="thread-pane">{children}</section>
    </div>
  );
}
