// Corre la E2E sin perder los datos reales de la base LOCAL: guarda una copia, ejecuta la E2E (que vacía tablas y
// edita sucursales) y deja la base EXACTAMENTE como estaba (borra lo que la prueba dejó, repone lo que borró) y lo
// verifica fila a fila. Aunque la E2E se cuelgue o falle, la restauración corre igual.
// Uso: npm run test:e2e:safe   (antes: parar el `next dev` del puerto 3000 y tener Supabase local encendido)
//      node scripts/e2e-safe.mjs --restore <carpeta-de-la-copia>   (restaurar a mano una copia anterior)
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
);
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.NEXT_PUBLIC_SUPABASE_URL)) {
  console.error("Abortado: solo corre contra Supabase LOCAL. NEXT_PUBLIC_SUPABASE_URL =", env.NEXT_PUBLIC_SUPABASE_URL);
  process.exit(1);
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ok = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
const retry = async (fn, times = 5) => {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= times) throw e; await new Promise((r) => setTimeout(r, 2000 * i)); }
  }
};

// Orden de inserción (respeta las llaves foráneas). Todas las tablas que la E2E toca.
const TABLES = [
  ["branches", "id"], ["leads", "id"], ["conversations", "id"], ["messages", "id"], ["conversation_notes", "id"],
  ["appointments", "id"], ["promotions", "id"], ["webhook_events", "event_id"], ["quick_replies", "id"], ["knowledge_base", "id"],
  ["consent_log", "id"], ["deletion_log", "id"], ["agent_runs", "id"], ["jobs", "id"], ["message_templates", "name"], ["ad_spend", "ad_id"], ["app_settings", "id"],
];

async function restore(saved, file) {
  for (const [t, key] of [...TABLES].reverse()) {
    if (t === "branches") continue; // las sucursales tienen usuarios que dependen de ellas: se reconcilian abajo
    await retry(() => ok(db.from(t).delete().not(key, "is", null)));
  }
  const keep = saved.branches.map((b) => b.id);
  const extra = (await retry(() => ok(db.from("branches").select("id")))).filter((b) => !keep.includes(b.id));
  for (const b of extra) await retry(() => ok(db.from("branches").delete().eq("id", b.id)));
  for (const [t] of TABLES) if (saved[t].length) await retry(() => ok(db.from(t).upsert(saved[t])));
  if (saved.conversations.length) await retry(() => ok(db.from("conversations").upsert(saved.conversations))); // el trigger de mensajes toca last_message_*

  // Usuarios de prueba que una corrida interrumpida pudo dejar en Auth.
  for (const email of ["nueva@optuz.local", "global-ui@optuz.local", "asesor-todas@optuz.local"]) {
    const { data } = await db.from("users").select("id").eq("email", email).maybeSingle();
    if (data) await db.auth.admin.deleteUser(data.id);
  }

  let identical = true;
  const strip = (o) => { const c = { ...o }; delete c.updated_at; return JSON.stringify(Object.entries(c).sort()); };
  for (const [t, key] of TABLES) {
    const now = await retry(() => ok(db.from(t).select("*")));
    if (now.length !== saved[t].length) { identical = false; console.error(`  DIFERENTE: ${t} tiene ${now.length} filas y la copia ${saved[t].length}`); }
    for (const r of saved[t]) {
      const n = now.find((x) => x[key] === r[key]);
      if (!n || strip(n) !== strip(r)) { identical = false; console.error("  DIFERENTE:", t, r[key]); }
    }
  }
  console.log(identical ? "Restauración verificada: la base quedó exactamente como la copia." : `RESTAURACIÓN CON DIFERENCIAS — la copia está en ${file}`);
  return identical;
}

const restoreIdx = process.argv.indexOf("--restore");
if (restoreIdx !== -1) {
  const dir = process.argv[restoreIdx + 1];
  const saved = JSON.parse(readFileSync(join(dir, "backup.json"), "utf8"));
  process.exit((await restore(saved, dir)) ? 0 : 2);
}

/** Mata lo que esté escuchando en esos puertos (Next solo admite un `next dev` por proyecto). */
function freePorts(ports) {
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${ports.join(",")} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
    { stdio: "ignore" },
  );
}

// Primero se para el servidor de desarrollo: así no puede entrar un mensaje real de WhatsApp entre la copia y la
// restauración (que borraría ese mensaje al reponer la copia).
freePorts([3000, 3113, 4010]);
console.log("Servidor de desarrollo detenido (si estaba). Vuelve a levantarlo con `npm run dev` al terminar.");

const dir = mkdtempSync(join(tmpdir(), "optuz-e2e-"));
const file = join(dir, "backup.json");
const saved = {};
for (const [t] of TABLES) saved[t] = await ok(db.from(t).select("*"));
writeFileSync(file, JSON.stringify(saved));
console.log("Copia de seguridad:", Object.fromEntries(TABLES.map(([t]) => [t, saved[t].length])), "→", dir);

let code = 1;
try {
  // Con tope de tiempo: si la E2E se cuelga, se corta y se restaura igual.
  code = spawnSync("node", ["e2e/run.mjs"], { stdio: "inherit", env: { ...process.env, E2E_WIPE: "1" }, timeout: 15 * 60_000 }).status ?? 1;
} finally {
  freePorts([3113, 4010]); // una E2E interrumpida deja su `next dev` y su servidor falso vivos
  console.log("\nRestaurando datos reales…");
  if (!(await restore(saved, dir))) code = code || 2;
}
process.exit(code);
