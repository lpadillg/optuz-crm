import { NextResponse } from "next/server";
import { MEDIA_BUCKET } from "@/lib/media";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Attachment } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Sirve un adjunto de un chat. Los archivos están en un almacenamiento PRIVADO: solo se entregan a quien puede ver ese
 * mensaje (RLS: su sucursal), con un enlace firmado que caduca a los 60 s.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ messageId: string; index: string }> }) {
  const { messageId, index } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { data } = await supabase.from("messages").select("attachments").eq("id", messageId).maybeSingle();
  const att = (data?.attachments as Attachment[] | undefined)?.[Number(index)];
  if (!att?.storage_path) return NextResponse.json({ error: "Archivo no disponible" }, { status: 404 });

  const { data: signed, error } = await createAdminClient().storage.from(MEDIA_BUCKET).createSignedUrl(att.storage_path, 60);
  if (error || !signed) return NextResponse.json({ error: "No se pudo generar el enlace" }, { status: 502 });
  return NextResponse.redirect(signed.signedUrl, 302);
}
