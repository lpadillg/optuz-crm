import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sendWhatsAppText, WhatsAppApiError } from "@/lib/whatsapp/client";

export const runtime = "nodejs";

const bodySchema = z.object({ text: z.string().trim().min(1).max(4000) });

// POST: un asesor escribe en una conversación con el bot pausado. Sale por la API de WhatsApp como `sender: humano`.
export async function POST(req: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;

  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Mensaje vacío o demasiado largo" }, { status: 400 });

  // Con la sesión del usuario: RLS decide si esta conversación es de su sucursal.
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, bot_active, requires_human, handoff_reason, leads(phone, bsuid)")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
  const lead = conv.leads as unknown as { phone: string | null; bsuid: string | null } | null;

  // Escribir con el bot activo es tomar el control. Se pausa ANTES de enviar (y solo si seguía activo) para que el bot
  // no conteste al mismo tiempo; el agente vuelve a mirar `bot_active` antes de enviar y descarta su respuesta.
  const db = createAdminClient();
  const antes = { requires_human: conv.requires_human, handoff_reason: conv.handoff_reason };
  let pausedByUs = false;
  if (conv.bot_active) {
    const { data: claimed } = await db.from("conversations").update({ bot_active: false }).eq("id", conversationId).eq("bot_active", true).select("id");
    pausedByUs = (claimed?.length ?? 0) > 0;
  }

  // El asesor toma el caso: deja de figurar como pendiente (se revierte si el envío falla).
  await db.from("conversations").update({ requires_human: false, handoff_reason: null }).eq("id", conversationId);

  try {
    const sent = await sendWhatsAppText({ phone: lead?.phone ?? null, bsuid: lead?.bsuid ?? null }, parsed.data.text);

    const { data: message, error } = await db
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "out",
        sender: "humano",
        content: parsed.data.text,
        wa_message_id: sent.id,
        author_id: auth.user.id,
      })
      .select("id, direction, sender, content, attachments, created_at, author_id")
      .single();
    if (error) throw error;

    // Si nadie lo tenía asignado, queda a cargo de quien respondió.
    await db.from("conversations").update({ assigned_to: auth.user.id }).eq("id", conversationId).is("assigned_to", null);
    return NextResponse.json({ message, botPaused: pausedByUs }, { status: 201 });
  } catch (err) {
    // No salió el mensaje: el bot sigue a cargo y el chat vuelve a figurar como estaba (pendiente, si lo estaba).
    if (pausedByUs) await db.from("conversations").update({ bot_active: true }).eq("id", conversationId);
    if (antes.requires_human) await db.from("conversations").update(antes).eq("id", conversationId);
    // 131047: pasaron más de 24 h desde el último mensaje del cliente; WhatsApp solo admite plantillas aprobadas.
    if (err instanceof WhatsAppApiError && err.code === 131047) {
      return NextResponse.json(
        { error: "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite enviar una plantilla aprobada." },
        { status: 422 },
      );
    }
    console.error("[inbox send]", err);
    return NextResponse.json({ error: "No se pudo enviar por WhatsApp" }, { status: 502 });
  }
}
