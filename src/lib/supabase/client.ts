"use client";
import { createBrowserClient } from "@supabase/ssr";

// Cliente del navegador: sesión del usuario, RLS aplica. Las claves NEXT_PUBLIC_* se inlinean en el build.
export function createSupabaseBrowserClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
