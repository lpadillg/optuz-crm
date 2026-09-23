import { createClient } from "@supabase/supabase-js";

/** Cliente con service role desde las variables de entorno (.env.local). */
export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (¿existe .env.local?)");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Crea un usuario en Auth y su perfil en `users`. Si el perfil falla, deshace el usuario de Auth. */
export async function createUser(db, { email, password, nombre, role = "vendedor", branch }) {
  if (!["admin", "vendedor"].includes(role)) throw new Error(`Rol inválido: ${role}`);

  let branchId = null;
  if (branch) {
    const { data, error } = await db.from("branches").select("id").eq("nombre", branch).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`No existe la sucursal "${branch}". ¿Corriste el seed?`);
    branchId = data.id;
  }

  const { data: created, error: authErr } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (authErr) throw new Error(`No se pudo crear el usuario en Auth: ${authErr.message}`);

  const { error: profileErr } = await db.from("users").insert({ id: created.user.id, nombre, email, role, branch_id: branchId });
  if (profileErr) {
    await db.auth.admin.deleteUser(created.user.id); // sin perfil no podría entrar al panel
    throw new Error(`No se pudo crear el perfil: ${profileErr.message}`);
  }
  return created.user.id;
}
