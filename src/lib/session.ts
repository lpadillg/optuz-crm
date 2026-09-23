import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface Profile {
  id: string;
  nombre: string;
  email: string;
  role: "admin" | "vendedor";
  branch_id: string | null;
}

/** Administradores y asesores sin sucursal atienden TODAS las sucursales; un asesor con sucursal, solo la suya. */
export const seesAllBranches = (p: Pick<Profile, "role" | "branch_id">) => p.role === "admin" || p.branch_id === null;

/** Usuario logueado + su fila en `users` (rol y sucursal). Sin sesión → /login; sin perfil → /sin-acceso. */
export const requireUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("id, nombre, email, role, branch_id")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile) redirect("/sin-acceso");

  return { supabase, profile: profile as Profile };
});

export async function requireAdmin() {
  const session = await requireUser();
  if (session.profile.role !== "admin") redirect("/inbox");
  return session;
}
