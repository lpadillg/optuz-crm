// Mantiene vivo el túnel que conecta WhatsApp con la app local.
//
//   npm run tunel
//
// Los túneles gratuitos de Cloudflare se reciclan solos cada pocas horas, y lo hacen de la peor manera: el
// proceso sigue vivo, así que nada falla a la vista, pero Meta ya no puede entregar nada. Los mensajes de los
// clientes se pierden hasta que alguien lo nota. En un solo día pasó cuatro veces.
//
// Esto lo levanta, registra su URL en Meta y luego comprueba cada dos minutos que el webhook sigue
// respondiendo. Cuando deja de hacerlo, rehace el túnel y vuelve a registrar la URL nueva, sin que nadie mire.
//
// Es un parche para trabajar en local: con la app desplegada la URL es fija y nada de esto hace falta.
import { spawn } from "node:child_process";

const BASE = (process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com").replace(/\/$/, "");
const VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const PUERTO = process.env.TUNEL_PUERTO ?? "3000";
const CADA_MS = 120_000;

const hora = () => new Date().toLocaleTimeString("es-PE", { hour12: false });
const log = (msg) => console.log(`[${hora()}] ${msg}`);

function faltan() {
  return ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"].filter((k) => !process.env[k]);
}

let proceso = null;

/** Levanta cloudflared y espera a que imprima su URL. */
function abrirTunel() {
  return new Promise((resolve, reject) => {
    const hijo = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PUERTO}`], { shell: true });
    proceso = hijo;
    let url = null;
    const corte = setTimeout(() => reject(new Error("cloudflared no dio una URL en 40 s")), 40_000);

    const mirar = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !url) {
        url = m[0];
        clearTimeout(corte);
        resolve(url);
      }
    };
    hijo.stdout.on("data", mirar);
    hijo.stderr.on("data", mirar); // cloudflared escribe su banner por stderr
    hijo.on("exit", (code) => {
      if (!url) { clearTimeout(corte); reject(new Error(`cloudflared terminó con código ${code}`)); }
    });
  });
}

/** Registra la URL en Meta. Devuelve el error si no se pudo. */
async function registrar(url) {
  const res = await fetch(`${BASE}/${VERSION}/${process.env.META_APP_ID}/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      object: "whatsapp_business_account",
      callback_url: `${url}/api/webhooks/whatsapp`,
      verify_token: process.env.WHATSAPP_VERIFY_TOKEN,
      fields: "messages",
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.success ? null : (data.error?.message ?? `HTTP ${res.status}`);
}

/** ¿El webhook contesta a través del túnel? Es la misma comprobación que hace Meta al entregar. */
async function responde(url) {
  try {
    const r = await fetch(
      `${url}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.WHATSAPP_VERIFY_TOKEN)}&hub.challenge=ping`,
      { signal: AbortSignal.timeout(12_000) },
    );
    return r.status === 200 && (await r.text()) === "ping";
  } catch {
    return false;
  }
}

/** Espera a que la URL nueva sea alcanzable desde fuera: tarda unos segundos en propagarse. */
async function esperarA(url, intentos = 12) {
  for (let i = 0; i < intentos; i++) {
    if (await responde(url)) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Túnel nuevo, esperado y registrado. Devuelve su URL y si Meta la aceptó. */
async function rehacer() {
  if (proceso) { proceso.kill(); proceso = null; }
  const url = await abrirTunel();
  log(`túnel arriba: ${url}`);

  // Sin esto, Meta intenta verificar una URL que su DNS todavía no resuelve y la rechaza con un 502. De paso
  // deja la ruta compilada, que es lo otro que hacía fallar la verificación por impaciencia de Meta.
  if (!(await esperarA(url))) {
    log("⚠ el túnel no respondió desde fuera; se reintenta en la próxima ronda");
    return { url, registrado: false };
  }

  const error = await registrar(url);
  if (error) {
    log(`⚠ Meta no aceptó la URL: ${error} — se reintenta en la próxima ronda`);
    return { url, registrado: false };
  }
  log("webhook registrado en Meta ✓");
  return { url, registrado: true };
}

async function main() {
  const sinDefinir = faltan();
  if (sinDefinir.length) {
    console.error(`Faltan en .env.local: ${sinDefinir.join(", ")}`);
    process.exit(1);
  }

  let { url, registrado } = await rehacer();
  let fallos = 0;

  setInterval(async () => {
    if (await responde(url)) {
      fallos = 0;
      // El túnel va, pero Meta pudo rechazar la URL al crearla: hasta que la acepte, no llega ningún mensaje.
      if (!registrado) {
        const error = await registrar(url);
        registrado = !error;
        log(registrado ? "webhook registrado en Meta ✓" : `⚠ Meta sigue sin aceptar la URL: ${error}`);
      }
      return;
    }
    // Un fallo suelto puede ser un pico de red; dos seguidos es que el túnel se recicló.
    if (++fallos < 2) {
      log("el webhook no respondió (1/2)");
      return;
    }
    log("el túnel dejó de responder: rehaciéndolo");
    fallos = 0;
    try {
      ({ url, registrado } = await rehacer());
    } catch (err) {
      log(`⚠ no se pudo rehacer: ${err.message}`);
    }
  }, CADA_MS);

  log(`vigilando cada ${CADA_MS / 1000} s. Ctrl+C para parar.`);
}

for (const señal of ["SIGINT", "SIGTERM"]) {
  process.on(señal, () => { proceso?.kill(); process.exit(0); });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
