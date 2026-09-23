// Crea un usuario del panel (Auth + fila en `users`). Sirve igual para Supabase local y para la nube:
// usa las variables de .env.local (URL y service role key).
//
//   npm run create-user -- --email a@b.com --password 'secreto123' --nombre 'Ana' --role admin
//   npm run create-user -- --email v@b.com --password 'secreto123' --nombre 'Luis' --role vendedor --branch 'Huánuco'
import { adminClient, createUser } from "./lib/create-user.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const { email, password, nombre, role = "vendedor", branch } = args;

if (!email || !password || !nombre) {
  console.error("Uso: npm run create-user -- --email X --password Y --nombre Z --role admin|vendedor [--branch 'Huánuco']");
  console.error("--branch es opcional: sin él, el vendedor (asesor) atiende TODAS las sucursales.");
  process.exit(1);
}

try {
  await createUser(adminClient(), { email, password, nombre, role, branch });
  console.log(`Usuario creado: ${email} (${role}${branch ? `, ${branch}` : ""})`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
