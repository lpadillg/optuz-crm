import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { showTyping } from "@/lib/whatsapp/client";

export const runtime = "nodejs";

/**
 * «Escribiendo…» en el teléfono del cliente mientras un asesor le contesta.
 *
 * El bot ya lo hacía y una persona no, así que con el bot apagado el cliente veía silencio hasta que llegaba
 * la respuesta —y en ese rato suele volver a escribir o irse—. WhatsApp lo muestra unos 25 segundos y lo
 * quita solo en cuanto llega el mensaje, así que no hay que avisar de que se dejó de escribir.
 *
 * Es cortesía: si falla, se responde 204 igual. Nada de esto puede estorbar al envío de verdad.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;

  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  // Con la sesión del usuario: RLS decide si esta conversación es de su sucursal.
  const { data: ultimo } = await supabase
    .from("messages")
    .select("wa_message_id")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .not("wa_message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // El aviso se cuelga del último mensaje del cliente: sin uno, WhatsApp no tiene a qué chat asociarlo.
  await showTyping(ultimo?.wa_message_id as string | null);
  return new NextResponse(null, { status: 204 });
}
