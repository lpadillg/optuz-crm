// Usuarios de desarrollo para el Supabase LOCAL (los usa `npm run test:e2e`). Contraseña: optuz-dev-123.
// Es seguro repetirlo: los que ya existen se omiten. Se niega a correr contra una base que no sea local.
import { adminClient, createUser } from "./lib/create-user.mjs";

if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
  console.error("Abortado: solo para Supabase local. NEXT_PUBLIC_SUPABASE_URL =", process.env.NEXT_PUBLIC_SUPABASE_URL);
  process.exit(1);
}

const PASSWORD = "optuz-dev-123";
const users = [
  { email: "admin@optuz.local", nombre: "Admin Dev", role: "admin" },
  { email: "huanuco@optuz.local", nombre: "Vendedor Huánuco", role: "vendedor", branch: "Huánuco" },
  { email: "tocache@optuz.local", nombre: "Vendedor Tocache", role: "vendedor", branch: "Tocache" },
];

const db = adminClient();
for (const u of users) {
  const { data: exists } = await db.from("users").select("id").eq("email", u.email).maybeSingle();
  if (exists) {
    console.log(`= ${u.email} ya existe`);
    continue;
  }
  await createUser(db, { ...u, password: PASSWORD });
  console.log(`+ ${u.email} (${u.role}${u.branch ? `, ${u.branch}` : ""})`);
}
