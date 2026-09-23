import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Las rutas /api/calendar/* las llaman el propio servidor (Bearer INTERNAL_API_SECRET)
 * o un usuario logueado del panel (cookie de sesión de Supabase).
 * Las rutas usan la service role, así que la autorización se decide aquí, no por RLS.
 */
export async function isAuthorized(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    return safeEqual(header.slice(7), env.internalApiSecret);
  }
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return !!data.user;
}
