// Configuración de Google Calendar (cuenta de servicio). Guía completa: README → «Conectar Google Calendar».
//
//   npm run google -- key "C:\ruta\clave-descargada.json"
//        Instala la clave JSON que descargaste de Google Cloud en .env.local (correo + clave privada, ya con el formato
//        correcto). Nunca imprime la clave. Al terminar te dice con qué correo debes compartir cada calendario.
//   npm run google -- check [--no-write] [--only "Huánuco"]
//        Verifica las credenciales y, sucursal por sucursal, que el calendario se pueda LEER y ESCRIBIR (crea y borra un
//        evento de prueba). Con --no-write solo lee.
//
// Opción --env <archivo>: usar otro archivo distinto de .env.local (útil para pruebas).
//
// Nota: este script lee el .env por su cuenta y NO con `node --env-file`, porque Node interpreta las secuencias de salto de
// línea escapadas de la clave privada y la corta; la app (Next) las conserva literales y las restituye en src/lib/env.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { explainGoogleError } from "../src/lib/google/errors.ts"; // una sola fuente de mensajes: la misma del panel

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));

// Se lanza (no process.exit) para que Node cierre limpio en Windows.
class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};

/** Lee un archivo .env sin expandir nada: `NOMBRE=valor` (quita comillas envolventes si las hay). */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Escribe/actualiza variables en un archivo .env conservando el resto (y sus saltos de línea). */
function setEnvVars(file, vars) {
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  for (const [name, value] of Object.entries(vars)) {
    const i = lines.findIndex((l) => l.startsWith(`${name}=`));
    if (i >= 0) lines[i] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  writeFileSync(file, lines.join(eol) + eol, "utf8"); // UTF-8 sin BOM
}

function keyCommand() {
  const path = positional[0];
  if (!path) fail('Uso: npm run google -- key "C:\\ruta\\al\\archivo-descargado.json"');
  if (!existsSync(path)) fail(`No encuentro el archivo: ${path}`);

  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Ese archivo no es un JSON válido. ¿Es la clave que descargaste de Google Cloud (IAM → Cuentas de servicio → Claves)?");
  }
  if (json.type !== "service_account" || !json.client_email || !json.private_key) {
    fail("Ese JSON no parece la clave de una cuenta de servicio (faltan type, client_email o private_key). Descarga una nueva: Cuentas de servicio → tu cuenta → Claves → Agregar clave → JSON.");
  }
  if (!/BEGIN (RSA )?PRIVATE KEY/.test(json.private_key)) fail("La clave privada del archivo no tiene el formato esperado (PEM).");

  const target = option("env") ?? ".env.local";
  setEnvVars(target, {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: json.client_email,
    // Los saltos de línea de la clave van como "\n" literales (la app los restituye); así cabe en una línea y en Vercel.
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: json.private_key.replace(/\r?\n/g, "\\n"),
  });

  console.log(`✓ Clave instalada en ${target}`);
  console.log(`  Cuenta de servicio: ${json.client_email}`);
  if (json.project_id) console.log(`  Proyecto de Google Cloud: ${json.project_id}`);
  console.log("");
  console.log("Siguientes pasos:");
  console.log(`  1. En Google Calendar, comparte CADA calendario de sucursal con  ${json.client_email}`);
  console.log("     con el permiso «Hacer cambios en eventos» (Configuración del calendario → Compartir con personas concretas).");
  console.log("  2. Copia el «ID del calendario» de cada uno (Configuración → Integrar el calendario) y pégalo en el panel: Sucursales → Editar.");
  console.log("  3. Comprueba todo con:  npm run google -- check");
  console.log("  4. Por seguridad, BORRA el archivo JSON descargado (la clave ya está en .env.local).");
  console.log("  Si el servidor de desarrollo estaba corriendo, reinícialo para que lea la clave nueva.");
}

async function checkCommand() {
  const E = { ...readEnvFile(option("env") ?? ".env.local") };
  const email = E.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = E.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (!email || !rawKey) {
    fail('Faltan las credenciales de Google en .env.local. Instálalas con:  npm run google -- key "C:\\ruta\\clave.json"');
  }
  const auth = new google.auth.JWT({ email, key: rawKey.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/calendar"] });
  try {
    await auth.authorize();
  } catch (err) {
    fail(explainGoogleError(err, email));
  }
  console.log(`✓ Credenciales válidas: ${email}\n`);

  const url = E.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = E.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) fail("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local.");
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: all, error } = await db.from("branches").select("nombre, google_calendar_id, activa").order("nombre");
  if (error) fail(`No pude leer las sucursales: ${error.message}`);

  const only = option("only")?.trim().toLowerCase();
  const branches = (all ?? []).filter((b) => b.activa && (!only || b.nombre.toLowerCase() === only));
  if (branches.length === 0) fail(only ? `No hay una sucursal activa llamada «${option("only")}».` : "No hay sucursales activas.");

  const calendar = google.calendar({ version: "v3", auth });
  const write = !flag("no-write");
  let problems = 0;

  for (const b of branches) {
    if (!b.google_calendar_id) {
      console.log(`– ${b.nombre}: sin ID de calendario (asígnalo en el panel: Sucursales → Editar).`);
      problems++;
      continue;
    }
    // Lectura: disponibilidad de las próximas 24 h
    try {
      const now = new Date();
      const res = await calendar.freebusy.query({
        requestBody: { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 24 * 3600_000).toISOString(), items: [{ id: b.google_calendar_id }] },
      });
      const entry = res.data.calendars?.[b.google_calendar_id];
      if (entry?.errors?.length) throw new Error(`freebusy ${b.google_calendar_id}: ${entry.errors.map((e) => e.reason).join(", ")}`);
    } catch (err) {
      console.log(`✗ ${b.nombre}: No se puede leer. ${explainGoogleError(err, email)}`);
      problems++;
      continue;
    }
    if (!write) {
      console.log(`✓ ${b.nombre}: se puede leer (no se probó la escritura).`);
      continue;
    }
    // Escritura: crea y borra un evento de prueba
    let eventId;
    try {
      const start = new Date(Date.now() + 3 * 24 * 3600_000);
      start.setUTCMinutes(0, 0, 0);
      const res = await calendar.events.insert({
        calendarId: b.google_calendar_id,
        requestBody: {
          summary: "Prueba de conexión de Optuz CRM (se borra sola)",
          start: { dateTime: start.toISOString() },
          end: { dateTime: new Date(start.getTime() + 15 * 60_000).toISOString() },
        },
      });
      eventId = res.data.id;
    } catch (err) {
      console.log(`✗ ${b.nombre}: Se puede leer pero no escribir. ${explainGoogleError(err, email)}`);
      problems++;
      continue;
    }
    try {
      await calendar.events.delete({ calendarId: b.google_calendar_id, eventId });
      console.log(`✓ ${b.nombre}: lectura y escritura correctas.`);
    } catch (err) {
      console.log(`✗ ${b.nombre}: se creó el evento de prueba pero no se pudo borrar (bórralo a mano). ${explainGoogleError(err, email)}`);
      problems++;
    }
  }

  console.log("");
  if (problems) fail(`${problems} sucursal(es) con problemas. Corrígelas y repite:  npm run google -- check`);
  console.log("Todo listo: el agente ya puede agendar citas en las sucursales revisadas.");
}

try {
  if (command === "key") keyCommand();
  else if (command === "check") await checkCommand();
  else {
    console.log(
      [
        "Uso:",
        '  npm run google -- key "C:\\ruta\\clave.json"        instala la clave de la cuenta de servicio en .env.local',
        '  npm run google -- check [--no-write] [--only "Huánuco"]   verifica credenciales y cada calendario',
      ].join("\n"),
    );
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  if (err instanceof Fail) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
