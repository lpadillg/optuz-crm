// E2E: app real (next dev) + Supabase LOCAL real + navegador real; la API de WhatsApp (Graph) y la de OpenAI simuladas por un servidor falso.
// Requisitos: `npm run db:start` (Docker), `npm run dev:users` (usuarios de prueba) y Edge/Chrome instalado.
// Uso: npm run test:e2e   (borra los datos de conversaciones/leads/promociones de la base LOCAL antes de correr)
// Variable opcional: E2E_BROWSER_CHANNEL=msedge|chrome (por defecto msedge).
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROJECT = process.cwd().replace(/\\/g, "/");
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:3113";
const MOCK = "http://127.0.0.1:4010";
const PASSWORD = "optuz-dev-123";
// Valores de prueba que la app recibe por entorno (no toca los de .env.local).
const APP_SECRET = "e2e-app-secret";
const VERIFY_TOKEN = "e2e-verify-token";
const PNID = "1092837465";
const WA_TOKEN = "wa_e2e_token";

const env = Object.fromEntries(
  readFileSync(`${PROJECT}/.env.local`, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.NEXT_PUBLIC_SUPABASE_URL)) {
  console.error("Abortado: el E2E borra datos y solo corre contra Supabase LOCAL. NEXT_PUBLIC_SUPABASE_URL =", env.NEXT_PUBLIC_SUPABASE_URL);
  process.exit(1);
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* reintenta */ } await sleep(step); }
  return null;
}
/** Espera a que no quede trabajo en curso ni por vencer en los próximos segundos (respuestas tardías del agente, agrupación…). */
async function idle() {
  const soon = () => new Date(Date.now() + 15_000).toISOString();
  await waitFor(async () => (await q(db.from("jobs").select("id").in("status", ["pending", "running"]).lte("run_at", soon()))).length === 0, 45000);
  await sleep(1500);
}
/** Adelanta y ejecuta una tarea que falla, intento por intento: espera el estado «pending con n intentos» y repite hasta que avance. */
async function driveRetries(getJob, from, to) {
  for (let n = from; n <= to; n++) {
    for (let tries = 0; tries < 5; tries++) {
      const j = await waitFor(async () => { const x = await getJob(); return x?.status === "pending" && x.attempts === n ? x : null; }, 8000);
      if (!j) break;
      await q(db.from("jobs").update({ run_at: new Date().toISOString() }).eq("id", j.id));
      await fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { "x-cron-secret": "e2e-cron" } });
      if (await waitFor(async () => { const x = await getJob(); return x && (x.attempts > n || x.status !== "pending") ? x : null; }, 5000)) break;
    }
  }
}
let pass = 0, fail = 0;
let logDumps = 0;
const check = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "   → " + extra}`);
  // Diagnóstico: en los primeros fallos, lo último que escribió la app (errores del servidor)
  if (!cond && logDumps < 4) {
    try {
      logDumps++;
      const useful = appLog.split("\n").filter((l) => /^\s*(POST|GET|PATCH|DELETE) |\[jobs\]|\[agente|\[webhook|⨯|Error:/.test(l)).slice(-25);
      console.log("  ┌ log de la app (líneas útiles):\n" + useful.map((l) => "  │ " + l.slice(0, 200)).join("\n"));
    } catch { /* la app aún no arrancó */ }
  }
};

// ── Servidor falso: API Responses de OpenAI (POST /v1/responses) y Graph API de Meta (POST /v25.0/{phone-number-id}/messages) ──
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const mediaCalls = [], transcribeCalls = [], templateCalls = [], capiCalls = [];
const llmCalls = [], summaryCalls = [], waCalls = [], waRejected = [], typingCalls = [];
const tagOf = new Map(); // id de respuesta → ¿es el flujo «etiquetas e2e»?
const flowOf = new Map(); // id de respuesta → ¿es el flujo «opciones e2e»?
const stepOf = new Map(); // id de respuesta → paso del guion (para encadenar con previous_response_id)
let llmFail = 0; // cuántas llamadas seguidas al modelo devuelven 400 (para probar los reintentos)
let graphFail = null; // { code, message } → el próximo envío falla como lo haría Meta
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && req.url === "/v1/responses") {
      const j = JSON.parse(body);
      if (llmFail > 0) { llmFail--; return json({ error: { message: "fallo simulado del modelo (e2e)", type: "invalid_request_error" } }, 400); }
      if (!j.tools) { // resumen de derivación: llamada sin herramientas
        summaryCalls.push(j);
        return json({ id: `resp_sum${summaryCalls.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: j.model, output: [{ type: "message", id: "msg_sum", role: "assistant", status: "completed", content: [{ type: "output_text", text: "• Quiere agendar una cita\n• Sucursal: Huánuco\n• Se derivó: reclamo\n• Siguiente paso: llamarle", annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } });
      }
      llmCalls.push({ headers: req.headers, body: j });
      // Guion: 1.ª vuelta set_branch → 2.ª get_active_promotions → 3.ª respuesta final con lo que devolvió la herramienta
      const step = j.previous_response_id ? (stepOf.get(j.previous_response_id) ?? 0) + 1 : 0;
      const id = `resp_${llmCalls.length}`;
      stepOf.set(id, step);
      const call = (name, args, n) => [
        { type: "reasoning", id: `rs_${id}`, summary: [] },
        { type: "function_call", id: `fc_${id}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args), status: "completed" },
      ];
      let output;
      // La sucursal que "elige" el modelo depende de lo que escribió el cliente (a propósito sin tilde ni mayúsculas: prueba la normalización).
      const firstUserText = String((j.input ?? []).find((i) => i.role === "user")?.content ?? "");
      const lastUserText = String([...(j.input ?? [])].reverse().find((i) => i.role === "user")?.content ?? "");
      const optionsFlow = step === 0 ? /opciones e2e/i.test(lastUserText) : (flowOf.get(j.previous_response_id) ?? false);
      flowOf.set(id, optionsFlow);
      const tagFlow = step === 0 ? /etiquetas e2e/i.test(lastUserText) : (tagOf.get(j.previous_response_id) ?? false);
      tagOf.set(id, tagFlow);
      if (step === 0 && tagFlow) output = call("tag_lead", { tags: ["quiere lentes de contacto", "diabetes"] }, 1);
      else if (step === 0 && optionsFlow) output = call("send_options", { text: "¿Cuál sucursal te queda más cerca?", options: ["Huánuco", "Tingo María", "Aucayacu", "Tocache", "Uchiza"] }, 1);
      else if (step === 0) output = call("set_branch", { branch: /sucursal e2e/i.test(firstUserText) ? "sucursal e2e" : "Huánuco" }, 1);
      else if (step === 1 && !optionsFlow && !tagFlow) output = call("get_active_promotions", {}, 2);
      else {
        const lastResult = (j.input ?? []).find((i) => i.type === "function_call_output")?.output ?? "";
        output = [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `¡Hola! Bienvenida a Huánuco. Promociones: ${lastResult}`, annotations: [] }] }];
      }
      return json({ id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: j.model, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    }
    // Plantillas de la cuenta (WABA) y API de Conversiones (conjunto de datos)
    if (req.url.startsWith("/v25.0/WABA-E2E/message_templates")) {
      if (req.method === "POST") { templateCalls.push(JSON.parse(body)); return json({ id: "tpl1", status: "PENDING", category: "UTILITY" }); }
      return json({ data: [{ id: "tpl1", name: "cita_recordatorio", language: "es", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hola {{1}} 👋 Te recordamos tu evaluación visual gratuita el {{2}} a las {{3}} en la sucursal {{4}} ({{5}}). Responde 1 para confirmar, 2 para reprogramar o 3 para cancelar." }] }] });
    }
    if (req.method === "POST" && req.url === "/v25.0/DS-E2E/events") { capiCalls.push({ auth: req.headers.authorization, body: JSON.parse(body) }); return json({ events_received: 1 }); }
    // Medios: 1) GET /v25.0/{id} → URL temporal; 2) GET /media/{id} → bytes (ambos exigen el token)
    if (req.method === "GET" && /^\/v25\.0\/MEDIA-/.test(req.url)) {
      const id = req.url.split("/").pop();
      mediaCalls.push({ step: "meta", id, auth: req.headers.authorization });
      if (id.includes("FAIL")) return json({ error: { message: "Unsupported get request", code: 100 } }, 404);
      return json({ url: `${MOCK}/media/${id}`, mime_type: id.includes("AUD") ? "audio/ogg; codecs=opus" : id.includes("DOC") ? "application/pdf" : "image/png", file_size: 100, id });
    }
    if (req.method === "GET" && req.url.startsWith("/media/")) {
      const id = req.url.split("/").pop();
      mediaCalls.push({ step: "bytes", id, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${WA_TOKEN}`) { res.statusCode = 401; return res.end("sin token"); }
      res.statusCode = 200; res.setHeader("content-type", id.includes("AUD") ? "audio/ogg" : id.includes("DOC") ? "application/pdf" : "image/png");
      return res.end(id.includes("AUD") ? Buffer.from("OggS-e2e-audio") : id.includes("DOC") ? Buffer.from("%PDF-1.4 e2e") : PNG);
    }
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      transcribeCalls.push({ bytes: body.length, contentType: req.headers["content-type"] });
      return json({ text: "Hola, quiero agendar una cita en Huánuco" });
    }
    if (req.method === "GET" && req.url.startsWith(`/v25.0/${PNID}?fields=`)) {
      return json({ display_phone_number: "+51 900 000 000", verified_name: "Caddyf E2E", quality_rating: "GREEN", messaging_limit_tier: "TIER_250", status: "CONNECTED", id: PNID });
    }
    if (req.method === "POST" && req.url === `/v25.0/${PNID}/messages`) {
      const call = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      // El aviso de «escribiendo…» usa el mismo endpoint, pero NO es un mensaje: se guarda aparte para no descuadrar las cuentas de envíos.
      if (call.body.typing_indicator) {
        typingCalls.push(call);
        return json({ success: true });
      }
      if (graphFail) {
        waRejected.push(call);
        const e = graphFail;
        graphFail = null;
        return json({ error: { message: e.message, type: "OAuthException", code: e.code, fbtrace_id: "x" } }, 400);
      }
      waCalls.push(call);
      const to = call.body.to ?? call.body.recipient;
      return json({ messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: `wamid.OUT${waCalls.length}` }] });
    }
    res.statusCode = 404; res.end("not found");
  });
});
await new Promise((r) => mock.listen(4010, "127.0.0.1", r));

// ── Protección de datos reales ──
// Esta prueba VACÍA conversaciones, leads y promociones. Si en la base local hay algo que no sea de la propia prueba
// (p. ej. una conversación real de WhatsApp o una promoción que creaste en el panel), se niega a correr.
const E2E_BSUIDS = new Set(["PE.111", "US.13491208655302741918", "PE.222", "PE.333", "PE.444", "PE.555", "PE.666", "PE.777", "PE.888", "PE.1010", "PE.1212", "PE.1313"]);
const E2E_PROMOS = new Set(["Examen + descuento en monturas", "Solo Tocache", "Vencida", "Promo desde el panel"]);
const realLeads = (await q(db.from("leads").select("nombre, phone, bsuid"))).filter((l) => !E2E_BSUIDS.has(l.bsuid));
const realPromos = (await q(db.from("promotions").select("titulo"))).filter((p) => !E2E_PROMOS.has(p.titulo));
if ((realLeads.length || realPromos.length) && !process.env.E2E_WIPE) {
  console.error("Abortado: la base local tiene datos que NO son de esta prueba y ella los borraría:");
  if (realLeads.length) console.error(`  · ${realLeads.length} lead(s) real(es): ${realLeads.map((l) => l.nombre ?? l.phone ?? l.bsuid).join(", ")}`);
  if (realPromos.length) console.error(`  · ${realPromos.length} promoción(es): ${realPromos.map((p) => p.titulo).join(", ")}`);
  console.error("Si de verdad quieres borrarlos: E2E_WIPE=1 npm run test:e2e");
  process.exit(1);
}
// Estado de las sucursales antes de tocarlo (la prueba edita calendario y campañas): se restaura al terminar.
const branchesBefore = await q(db.from("branches").select("id, nombre, direccion, google_calendar_id, meta_campaign_ids, activa"));

// ── Datos limpios ──
for (const t of ["messages", "conversation_notes", "appointments", "conversations", "leads", "promotions", "webhook_events", "jobs"]) {
  await q(db.from(t).delete().not(t === "webhook_events" ? "event_id" : "id", "is", null));
}
await q(db.from("branches").delete().eq("nombre", "Sucursal E2E")); // resto de una corrida anterior interrumpida
const branches = Object.fromEntries((await q(db.from("branches").select("id, nombre"))).map((b) => [b.nombre, b.id]));
// Tus calendarios reales de Google se quitan durante la prueba (y se restauran al terminar): la E2E jamás debe depender de ellos.
await q(db.from("branches").update({ google_calendar_id: null }).not("id", "is", null));
await q(db.from("branches").update({ meta_campaign_ids: ["AD-HCO-1"], google_calendar_id: null }).eq("id", branches["Huánuco"]));
const now = Date.now();
await q(db.from("promotions").insert([
  { branch_id: branches["Huánuco"], titulo: "Examen + descuento en monturas", descripcion: "Solo Huánuco", valid_from: new Date(now - 864e5).toISOString(), valid_to: new Date(now + 864e5).toISOString() },
  { branch_id: branches["Tocache"], titulo: "Solo Tocache", descripcion: "No debe salir en Huánuco", valid_from: new Date(now - 864e5).toISOString(), valid_to: new Date(now + 864e5).toISOString() },
  { branch_id: branches["Huánuco"], titulo: "Vencida", descripcion: "Ya terminó", valid_from: new Date(now - 9e8).toISOString(), valid_to: new Date(now - 864e5).toISOString() },
]));
const users = Object.fromEntries((await q(db.from("users").select("id, email"))).map((u) => [u.email, u.id]));

// ── App real ──
const app = spawn("npx.cmd", ["next", "dev", "-p", "3113"], {
  cwd: PROJECT, shell: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    META_GRAPH_BASE_URL: MOCK, META_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: PNID, WHATSAPP_ACCESS_TOKEN: WA_TOKEN,
    // Fijados aquí para que la prueba no dependa de lo que tengas en .env.local (el entorno del proceso tiene prioridad).
    OPENAI_BASE_URL: `${MOCK}/v1`, OPENAI_API_KEY: "sk-e2e-test", OPENAI_MODEL: "gpt-5.6-terra", OPENAI_REASONING_EFFORT: "medium",
    BUSINESS_NAME: "Caddyf Centro Óptico", INTERNAL_API_SECRET: "x",
    // Cola determinista: agrupa 300 ms, sin ticker (la prueba dispara las tareas a mano) y con un «ahora» fijo dentro del horario de atención.
    AGENT_DEBOUNCE_MS: "300", JOBS_TICKER: "off", TYPING_CHARS_PER_SECOND: "0", CRON_SECRET: "e2e-cron", WHATSAPP_BUSINESS_ACCOUNT_ID: "WABA-E2E", META_DATASET_ID: "DS-E2E", FOLLOWUP_AFTER_MINUTES: "180", ATTENTION_NOW: "2026-09-17T10:00:00-05:00",
    // Sin credenciales de Google a propósito: la prueba jamás debe tocar un calendario real, aunque tú ya los tengas en .env.local.
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "",
  },
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));
const ready = await waitFor(async () => (await fetch(`${BASE}/login`)).status === 200, 120000, 1000);
if (!ready) { console.log("La app no arrancó:\n" + appLog.slice(-1500)); process.exit(1); }
console.log("app lista\n");
// Se piden las rutas que la prueba usa a ritmo apretado, para que la compilación no cuente contra sus esperas.
for (const [method, path] of [["POST", "/api/jobs/run"], ["GET", "/api/webhooks/whatsapp"], ["GET", "/inbox"], ["GET", "/sistema"], ["GET", "/equipo"], ["GET", "/leads"]]) {
  await fetch(`${BASE}${path}`, { method, headers: { "x-cron-secret": "e2e-cron" }, redirect: "manual", signal: AbortSignal.timeout(90000) }).catch(() => {});
}

// ── Payloads en el formato de la Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components) ──
const sign = (body) => "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
const carla = { wa_id: "51987654321", user_id: "PE.111", name: "Carla" };
const wrap = (value, pnid = PNID) => JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "51900000000", phone_number_id: pnid }, ...value } }] }],
});
const waMessage = (who, id, text, extra = {}) => ({
  ...(who.wa_id && { from: who.wa_id }), from_user_id: who.user_id, id,
  timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text }, ...extra,
});
const contactOf = (who) => ({ profile: { name: who.name }, ...(who.wa_id && { wa_id: who.wa_id }), user_id: who.user_id });
const inbound = (who, id, text, { extra, pnid } = {}) => wrap({ contacts: [contactOf(who)], messages: [waMessage(who, id, text, extra)] }, pnid);
const payload = (id, text) => inbound(carla, id, text, { extra: { referral: { source_url: "https://fb.me/x", source_id: "AD-HCO-1", source_type: "ad", ctwa_clid: "clid-1", headline: "Examen visual gratis" } } });
const post = (body, sig = sign(body)) => fetch(`${BASE}/api/webhooks/whatsapp`, { method: "POST", body, headers: { "content-type": "application/json", ...(sig && { "x-hub-signature-256": sig }) } });

// ═════ 1. Webhook → ingesta → agente → OpenAI → WhatsApp ═════
console.log("── Webhook y agente");
const vUrl = (token, challenge = "CHALLENGE_123") => `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`;
const vOk = await fetch(vUrl(VERIFY_TOKEN));
check("verificación de Meta (GET): con el token correcto devuelve el challenge", vOk.status === 200 && (await vOk.text()) === "CHALLENGE_123");
check("verificación de Meta (GET): con un token incorrecto → 403", (await fetch(vUrl("mal"))).status === 403);

const b1 = payload("wamid.1", "Hola, vi su anuncio");
const r1 = await post(b1);
check("webhook responde 200", r1.status === 200, String(r1.status));
const botMsg = await waitFor(async () => (await q(db.from("messages").select("*").eq("sender", "bot")))[0], 60000);
check("el agente respondió (mensaje sender=bot en la base)", !!botMsg, appLog.slice(-1200));

const lead = (await q(db.from("leads").select("*").eq("phone", "+51987654321")))[0];
check("lead creado con teléfono E.164 y BSUID", lead?.bsuid === "PE.111", JSON.stringify(lead));
check("sucursal detectada por el anuncio (meta_campaign_ids)", lead?.branch_id === branches["Huánuco"]);
check("origen ctwa + ad_id + ctwa_clid guardados", lead?.source === "ctwa" && lead?.ad_id === "AD-HCO-1" && lead?.ctwa_clid === "clid-1");
check("nombre tomado del contacto", lead?.nombre === "Carla");
check("origen: llegó con identificador de anuncio → «Anuncio», y se guarda como último anuncio", lead?.origin === "anuncio" && lead?.last_ad_id === "AD-HCO-1", JSON.stringify({ o: lead?.origin, l: lead?.last_ad_id }));
check("tablero: tras la primera respuesta del bot sale de «Nuevo» y pasa a «En seguimiento»", lead?.stage === "seguimiento", lead?.stage);
const conv = (await q(db.from("conversations").select("*")))[0];
check("una conversación por lead, con el bot activo", conv?.lead_id === lead?.id && conv?.bot_active === true);
const msgs = await q(db.from("messages").select("direction, sender, content, wa_message_id").order("created_at"));
check("historial: 1 entrante (lead) + 1 saliente (bot)", msgs.length === 2 && msgs[0].sender === "lead" && msgs[1].sender === "bot", JSON.stringify(msgs));
check("los mensajes guardan su wamid (entrante y saliente)", msgs[0]?.wa_message_id === "wamid.1" && msgs[1]?.wa_message_id === "wamid.OUT1", JSON.stringify(msgs));
check("trigger: vista previa = último mensaje", conv?.last_message_preview === botMsg?.content.slice(0, 120));
const ev1 = (await q(db.from("webhook_events").select("*").eq("event_id", "msg:wamid.1")))[0];
check("webhook_events: el mensaje quedó procesado y sin error", !!ev1?.processed_at && !ev1?.error);

// Mientras el agente piensa, el cliente ve «escribiendo…» (y sus ✓✓): Meta lo pide en el mismo endpoint, con status «read».
const typ = typingCalls.find((c) => c.body.message_id === "wamid.1");
check("el cliente ve «escribiendo…» mientras el agente prepara la respuesta", !!typ && typ.body.typing_indicator?.type === "text" && typ.body.status === "read" && typ.body.messaging_product === "whatsapp", JSON.stringify(typingCalls.map((c) => c.body)));
check("...y ese mismo aviso marca su mensaje como leído (no es un mensaje: no cuenta como envío)", waCalls.every((c) => !c.body.typing_indicator) && typ?.auth === `Bearer ${WA_TOKEN}`);

const wa1 = waCalls[0];
check("Graph API: 1 envío a /v25.0/{phone-number-id}/messages con Bearer del usuario del sistema", waCalls.length === 1 && wa1.auth === `Bearer ${WA_TOKEN}` && wa1.path === `/v25.0/${PNID}/messages`, JSON.stringify(waCalls));
check("Graph API: cuerpo correcto (messaging_product, to sin '+', type text)", wa1?.body.messaging_product === "whatsapp" && wa1.body.to === "51987654321" && wa1.body.type === "text" && wa1.body.recipient_type === "individual", JSON.stringify(wa1?.body));
check("texto enviado a WhatsApp = texto guardado", wa1?.body.text?.body === botMsg?.content);
check("OpenAI: 3 llamadas (set_branch → promociones → respuesta)", llmCalls.length === 3, String(llmCalls.length));
const c1 = llmCalls[0];
check("OpenAI: gpt-5.6-terra, razonamiento medio, una herramienta por vez, autenticado con la API key", c1?.body.model === "gpt-5.6-terra" && c1.body.reasoning?.effort === "medium" && c1.body.parallel_tool_calls === false && c1.headers.authorization === "Bearer sk-e2e-test", JSON.stringify({ m: c1?.body.model, r: c1?.body.reasoning, p: c1?.body.parallel_tool_calls, a: c1?.headers.authorization }));
check("OpenAI: 12 herramientas declaradas (formato function)", c1?.body.tools?.length === 12 && c1.body.tools.every((t) => t.type === "function" && t.parameters?.type === "object"), String(c1?.body.tools?.length));
check("OpenAI: las instrucciones traen el nombre del negocio, la sucursal detectada y el aviso de primer mensaje", c1?.body.instructions.includes("Caddyf Centro Óptico") && c1.body.instructions.includes("Huánuco") && c1.body.instructions.includes("primer mensaje"));
check("OpenAI: el historial que ve es solo el mensaje del cliente", c1?.body.input.length === 1 && c1.body.input[0].role === "user" && String(c1.body.input[0].content).includes("vi su anuncio"));
check("OpenAI: las vueltas se encadenan con previous_response_id y solo mandan lo nuevo", !("previous_response_id" in c1.body) && llmCalls[1]?.body.previous_response_id === "resp_1" && llmCalls[2]?.body.previous_response_id === "resp_2" && llmCalls[1].body.input.length === 1 && llmCalls[1].body.input[0].type === "function_call_output", JSON.stringify(llmCalls[1]?.body.input));
check("OpenAI: las instrucciones se reenvían en cada vuelta (no se heredan)", llmCalls[1]?.body.instructions === c1?.body.instructions && llmCalls[2]?.body.instructions === c1?.body.instructions);
const promoResult = llmCalls[2]?.body.input.find((i) => i.type === "function_call_output")?.output ?? "";
check("herramienta de promociones: devuelve la vigente de Huánuco", promoResult.includes("Examen + descuento en monturas"), promoResult);
check("herramienta de promociones: NO devuelve la de otra sucursal ni la vencida", !promoResult.includes("Solo Tocache") && !promoResult.includes("Vencida"), promoResult);

const dup = await (await post(b1)).json();
await sleep(2500);
check("reenvío de la misma entrega: se deduplica por wamid (no procesa ni responde de nuevo)", dup.duplicates === 1 && dup.processed === 0 && waCalls.length === 1 && llmCalls.length === 3 && (await q(db.from("messages").select("id"))).length === 2, JSON.stringify(dup));
check("firma inválida → 401", (await post(b1, "sha256=" + "0".repeat(64))).status === 401);
check("sin cabecera de firma → 401", (await post(b1, null)).status === 401);
check("firma sin el prefijo 'sha256=' → 401", (await post(b1, sign(b1).slice(7))).status === 401);

// ═════ 2. Panel (Edge) ═════
console.log("\n── Panel");
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge", headless: true });
{
  const proto = Object.getPrototypeOf((await (await browser.newContext()).newPage()).locator("body"));
  const orig = proto.isVisible;
  proto.isVisible = async function (opts) {
    if (!opts?.timeout) return orig.call(this);
    const end = Date.now() + opts.timeout;
    while (Date.now() < end) { if (await orig.call(this)) return true; await sleep(250); }
    return false;
  };
}
const login = async (ctx, email) => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/inbox", { timeout: 90000 });
  return page;
};

// Abre el diálogo de alta de la pantalla: tras una redirección la página puede seguir cargando y el clic se pierde.
const openCard = async (pg) => {
  await pg.waitForLoadState("networkidle");
  for (let i = 0; i < 4; i++) {
    if ((await pg.locator("dialog[open]").count()) > 0) return;
    await pg.locator(".row-head .btn.primary, .page-head .btn.primary").first().click().catch(() => {});
    await sleep(400);
  }
};
const bad_login = await (await browser.newContext()).newPage();
await bad_login.goto(`${BASE}/login`);
await bad_login.fill("input[name=email]", "huanuco@optuz.local");
await bad_login.fill("input[name=password]", "mala");
await bad_login.click("button[type=submit]");
check("login con contraseña incorrecta muestra error", await bad_login.getByText("Correo o contraseña incorrectos").isVisible({ timeout: 15000 }).catch(() => false));

const anon = await (await browser.newContext()).newPage();
await anon.goto(`${BASE}/citas`);
check("sin sesión, /citas redirige a /login", anon.url().includes("/login"), anon.url());

// Vendedor de Huánuco
const hco = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await login(hco, "huanuco@optuz.local");
await p.waitForSelector(".conv", { timeout: 30000 });
await p.getByRole("button", { name: "Todas", exact: true }).click();
check("vendedor Huánuco ve la conversación de Carla", (await p.locator(".conv").first().innerText()).includes("Carla"));
await p.locator(".conv").first().click();
await p.waitForSelector(".bubble", { timeout: 30000 });
check("el hilo muestra los 2 mensajes (lead y bot)", (await p.locator(".bubble").count()) === 2);
check("el mensaje del bot está marcado 🤖 Bot", await p.locator(".bubble.bot .who", { hasText: "Bot" }).isVisible());
await p.screenshot({ path: `${SHOTS}01-hilo.png` });

await sleep(4000); // suscripción Realtime ya activa: esto prueba el push, no la relectura
await q(db.from("messages").insert({ conversation_id: conv.id, direction: "in", sender: "lead", content: "Mensaje en vivo", wa_message_id: "wamid.live" }));
check("Realtime: un mensaje nuevo aparece sin recargar", await p.getByText("Mensaje en vivo").isVisible({ timeout: 15000 }).catch(() => false));
check("con el bot activo el cuadro de mensaje NO está bloqueado y avisa que escribir toma el control", !(await p.locator(".composer textarea").isDisabled()) && await p.locator(".takeover-hint").isVisible());

// Barra lateral: expandida con nombres por defecto; se puede contraer a íconos (con aviso al pasar el cursor) y se recuerda
const navLabel = () => p.locator(".side-item a[aria-label='Inbox'] .side-label");
check("barra lateral expandida por defecto: se ve el nombre de cada sección", await navLabel().isVisible() && await p.locator(".brand-name").isVisible());
await p.getByRole("button", { name: "Contraer barra lateral" }).click();
await sleep(500); // la barra anima su ancho (0,18 s)
check("contraer: la barra sigue visible pero sin nombres (solo íconos)", await p.locator(".sidebar").isVisible() && !(await navLabel().isVisible()) && (await p.locator(".sidebar").boundingBox()).width < 80);
await p.locator(".side-item a[aria-label='Tablero de leads']").hover();
check("contraída: al pasar el cursor por un ícono aparece su nombre", await p.locator(".side-tip", { hasText: "Tablero de leads" }).isVisible({ timeout: 3000 }).catch(() => false));
await p.screenshot({ path: `${SHOTS}23-barra-contraida.png` });
await p.locator(".content").hover();
check("...y el aviso desaparece al salir", !(await p.locator(".side-tip").isVisible({ timeout: 1500 }).catch(() => false)));
await p.reload();
await p.waitForSelector(".thread", { timeout: 30000 });
await sleep(500);
check("la barra sigue contraída tras recargar (se recuerda) y sin parpadeo inicial", !(await navLabel().isVisible()) && (await p.locator(".sidebar").boundingBox()).width < 80);
await p.getByRole("button", { name: "Expandir barra lateral" }).click();
await sleep(500);
check("expandir: vuelven los nombres", await navLabel().isVisible() && (await p.locator(".sidebar").boundingBox()).width > 150);

await p.locator(".bot-state").getByRole("button", { name: "Pausar" }).click();
check("pausar el bot persiste bot_active=false", !!(await waitFor(async () => (await q(db.from("conversations").select("bot_active").eq("id", conv.id)))[0].bot_active === false, 10000)));
await p.locator(".composer textarea").fill("Hola Carla, soy Luis de Huánuco");
await p.getByRole("button", { name: "Enviar" }).click();
check("el envío humano llegó a la Graph API", !!(await waitFor(() => waCalls.length === 2, 15000)) && waCalls[1].body.text.body === "Hola Carla, soy Luis de Huánuco" && waCalls[1].body.to === "51987654321");
const human = await waitFor(async () => (await q(db.from("messages").select("*").eq("sender", "humano")))[0], 10000);
check("mensaje guardado como sender=humano con su autor y su wamid", human?.direction === "out" && human?.author_id === users["huanuco@optuz.local"] && human?.wa_message_id === "wamid.OUT2", JSON.stringify(human));
check("el mensaje humano aparece en el hilo", await p.locator(".bubble.humano", { hasText: "soy Luis" }).isVisible({ timeout: 10000 }).catch(() => false));
await p.screenshot({ path: `${SHOTS}02-humano.png` });

// Meta rechaza texto libre pasadas 24 h (131047): el asesor debe verlo claro y nada debe guardarse
graphFail = { code: 131047, message: "Re-engagement message" };
await p.locator(".composer textarea").fill("Mensaje fuera de ventana");
await p.getByRole("button", { name: "Enviar" }).click();
check("ventana de 24 h cerrada (131047): el asesor ve un aviso claro", await p.getByText(/24 horas/).isVisible({ timeout: 15000 }).catch(() => false));
check("...y el mensaje rechazado no se guarda ni cuenta como enviado", waRejected.length === 1 && waCalls.length === 2 && (await q(db.from("messages").select("id").eq("content", "Mensaje fuera de ventana"))).length === 0);
await p.locator(".composer textarea").fill("");

const before = llmCalls.length;
await post(payload("wamid.2", "Quiero una cita mañana"));
await sleep(3500);
check("con el bot pausado: guarda el mensaje pero el agente NO responde", (await q(db.from("messages").select("id").eq("wa_message_id", "wamid.2"))).length === 1 && llmCalls.length === before && waCalls.length === 2);

await p.getByRole("button", { name: "Notas internas (0)" }).click();
await p.locator(".composer textarea").fill("Cliente prefiere la tarde");
await p.getByRole("button", { name: "Guardar nota" }).click();
const note = await waitFor(async () => (await q(db.from("conversation_notes").select("*")))[0], 10000);
check("nota interna guardada con su autor (no se envía al cliente)", note?.body === "Cliente prefiere la tarde" && note.author_id === users["huanuco@optuz.local"] && waCalls.length === 2);
await p.getByRole("button", { name: /^Chat/ }).click();

await q(db.from("conversations").update({ requires_human: true, handoff_reason: "Reclamo por garantía" }).eq("id", conv.id));
await p.reload();
check("derivación: banner 'Requiere atención humana' con el motivo", await p.getByText("Reclamo por garantía").isVisible({ timeout: 20000 }).catch(() => false));
check("derivación: la lista marca «Requiere persona»", await p.locator(".conv .tag.warn", { hasText: "Requiere persona" }).isVisible());
await p.screenshot({ path: `${SHOTS}03-derivada.png` });

await p.locator(".bot-state").getByRole("button", { name: "Reactivar" }).click();
check("reactivar el bot limpia la derivación", !!(await waitFor(async () => { const c = (await q(db.from("conversations").select("bot_active, requires_human, handoff_reason").eq("id", conv.id)))[0]; return c.bot_active === true && c.requires_human === false && c.handoff_reason === null; }, 10000)));

check("chat: el panel muestra la etapa del tablero (una sola verdad, no un estado aparte)", await p.locator(".cp-stage").getByText("En seguimiento").isVisible());
check("chat: el panel ya no ofrece cambiar el estado a mano", (await p.getByRole("combobox", { name: "Estado del lead" }).count()) === 0);

await p.goto(`${BASE}/leads`);
check("/leads lista a Carla", await p.getByText("Carla").isVisible({ timeout: 30000 }).catch(() => false));
await p.goto(`${BASE}/promociones`);
await p.waitForSelector("table", { timeout: 30000 });
const promoText = await p.locator("table").innerText();
check("/promociones (vendedor): ve la de su sucursal, no la de Tocache", promoText.includes("Examen + descuento") && !promoText.includes("Solo Tocache"));
check("/promociones (vendedor): sin formulario de alta", (await p.getByText("Nueva promoción").count()) === 0);
await p.goto(`${BASE}/sucursales`);
check("/sucursales: el vendedor es redirigido al inbox", p.url().includes("/inbox"), p.url());
await p.goto(`${BASE}/citas`);
check("/citas carga (vacía)", await p.getByText("No hay citas próximas").isVisible({ timeout: 30000 }).catch(() => false));

// Vendedor de Tocache: no debe ver nada de Huánuco
const toc = await browser.newContext();
const pt = await login(toc, "tocache@optuz.local");
await pt.waitForLoadState("networkidle");
check("vendedor Tocache: bandeja vacía (aislamiento por sucursal)", (await pt.locator(".conv").count()) === 0 && await pt.getByText("Aún no hay conversaciones").isVisible());
const direct = await pt.goto(`${BASE}/inbox/${conv.id}`);
check("vendedor Tocache: abrir el chat de Huánuco por URL → 404", direct.status() === 404 || (await pt.getByText(/could not be found|404/i).count()) > 0, String(direct.status()));
const apiTry = await toc.request.post(`${BASE}/api/inbox/conversations/${conv.id}/messages`, { data: { text: "intruso" } });
check("vendedor Tocache: no puede enviar por la API a una conversación ajena", apiTry.status() === 404, String(apiTry.status()));
const noAuth = await fetch(`${BASE}/api/inbox/conversations/${conv.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
check("API de envío sin sesión → 401", noAuth.status === 401);
check("ningún mensaje intruso salió a WhatsApp", waCalls.length === 2);

// Admin
const adm = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pa = await login(adm, "admin@optuz.local");
check("admin ve la conversación de Huánuco", await pa.locator(".conv", { hasText: "Carla" }).isVisible({ timeout: 30000 }).catch(() => false));
await pa.goto(`${BASE}/sucursales`);
await pa.waitForSelector(".branch-card", { timeout: 30000 });
await pa.waitForLoadState("networkidle"); // el dev server compila la ruta en frío y puede recargar la página a medias
const branchCard = (name) => pa.locator(".branch-card", { has: pa.getByRole("heading", { name, exact: true }) });
check("/sucursales muestra las 5 sucursales", (await pa.locator(".branch-card").count()) === 5);
check("/sucursales: la tarjeta muestra dirección, agenda sin conectar y cifras", await branchCard("Huánuco").getByText("Jr. 28 de Julio 1131").isVisible() && await branchCard("Huánuco").getByText("Sin calendario").isVisible() && await branchCard("Huánuco").getByText("contactos").isVisible());
check("/sucursales: avisa UNA sola vez de que el calendario no está conectado (antes salía dos veces)", await pa.locator(".banner.warn", { hasText: "Google Calendar aún no está conectado" }).isVisible() && (await pa.locator(".banner.warn").count()) === 1);
await branchCard("Huánuco").getByRole("button", { name: "Editar" }).click();
const dlg = pa.locator("dialog[open]");
await dlg.waitFor({ timeout: 10000 });
check("/sucursales: el diálogo de edición carga los IDs de campaña guardados", (await dlg.locator("textarea[name=meta_campaign_ids]").inputValue()).includes("AD-HCO-1"));
await pa.screenshot({ path: `${SHOTS}24-dialogo-sucursal.png` });
await pa.keyboard.press("Escape");
check("/sucursales: Esc cierra el diálogo sin guardar", (await pa.locator("dialog[open]").count()) === 0);
await branchCard("Huánuco").getByRole("button", { name: "Editar" }).click();
await dlg.waitFor({ timeout: 10000 });
await dlg.locator("input[name=google_calendar_id]").fill("hco@group.calendar.google.com");
await dlg.locator("textarea[name=meta_campaign_ids]").fill("AD-HCO-1, AD-HCO-2\nAD-HCO-3");
await dlg.getByRole("button", { name: "Guardar cambios" }).click();
const bUpd = await waitFor(async () => { const b = (await q(db.from("branches").select("google_calendar_id, meta_campaign_ids").eq("id", branches["Huánuco"])))[0]; return b.google_calendar_id === "hco@group.calendar.google.com" ? b : null; }, 15000);
check("admin edita calendario y campañas (se separan por coma/espacio/salto)", JSON.stringify(bUpd?.meta_campaign_ids) === JSON.stringify(["AD-HCO-1", "AD-HCO-2", "AD-HCO-3"]), JSON.stringify(bUpd));
await pa.waitForLoadState("networkidle");
check("/sucursales: tras guardar, la tarjeta muestra «Calendario asignado» (sin afirmar que está conectado) y 3 anuncios", await branchCard("Huánuco").getByText("Calendario asignado").isVisible({ timeout: 15000 }).catch(() => false) && await branchCard("Huánuco").getByText("falta conectar Google").isVisible() && await branchCard("Huánuco").getByText("3 anuncios de Meta").isVisible());
check("/sucursales: el chip del resumen cuenta las sucursales con calendario y avisa en ámbar", (await pa.locator(".stat-chip", { hasText: "con calendario" }).getAttribute("class")).includes("warn"));
check("/sucursales: «Probar conexión» solo aparece en las sucursales con calendario", await branchCard("Huánuco").getByRole("button", { name: "Probar conexión" }).isVisible() && (await branchCard("Tocache").getByRole("button", { name: "Probar conexión" }).count()) === 0);
await branchCard("Huánuco").getByRole("button", { name: "Probar conexión" }).click();
check("«Probar conexión» sin credenciales explica qué falta (y no llama a Google)", await pa.locator(".banner.warn", { hasText: "aún no está configurado" }).isVisible({ timeout: 20000 }).catch(() => false));
await pa.waitForLoadState("networkidle");
await pa.screenshot({ path: `${SHOTS}04-sucursales.png` });
await pa.screenshot({ path: `${SHOTS}04-sucursales.png` });

// Registrar una sucursal nueva desde el panel
await pa.getByRole("button", { name: "Nueva sucursal" }).click();
const nd = pa.locator("dialog[open]");
await nd.waitFor({ timeout: 10000 });
await nd.locator("input[name=nombre]").fill("Sucursal E2E");
await nd.locator("input[name=direccion]").fill("Jr. Prueba 123, frente al parque");
await nd.locator("textarea[name=meta_campaign_ids]").fill("AD-E2E-1");
await nd.getByRole("button", { name: "Registrar sucursal" }).click();
check("registrar sucursal: aviso de éxito", await pa.locator(".banner.ok", { hasText: "registrada" }).isVisible({ timeout: 20000 }).catch(() => false));
const newBranch = (await q(db.from("branches").select("*").eq("nombre", "Sucursal E2E")))[0];
check("registrar sucursal: queda en la base, activa, con dirección y campaña", newBranch?.direccion === "Jr. Prueba 123, frente al parque" && newBranch.activa === true && JSON.stringify(newBranch.meta_campaign_ids) === '["AD-E2E-1"]' && newBranch.google_calendar_id === null, JSON.stringify(newBranch));
check("registrar sucursal: aparece su tarjeta (ahora 6)", (await pa.locator(".branch-card").count()) === 6);

await pa.waitForLoadState("networkidle");
await pa.getByRole("button", { name: "Nueva sucursal" }).click();
await nd.waitFor({ timeout: 10000 });
await nd.locator("input[name=nombre]").fill("SUCURSAL e2e "); // mismo nombre con otras mayúsculas y espacio
await nd.locator("input[name=direccion]").fill("Otra dirección 999");
await nd.getByRole("button", { name: "Registrar sucursal" }).click();
check("nombre duplicado (aunque cambien mayúsculas/espacios): se rechaza con un aviso claro", await pa.locator(".banner.warn", { hasText: "Ya existe" }).isVisible({ timeout: 20000 }).catch(() => false));
check("...y no se crea una segunda", (await q(db.from("branches").select("id").ilike("nombre", "%sucursal e2e%"))).length === 1);

await pa.waitForLoadState("networkidle");
await branchCard("Sucursal E2E").getByRole("button", { name: "Editar" }).click();
await dlg.waitFor({ timeout: 10000 });
await dlg.locator("input[name=direccion]").fill("Jr. Prueba 123 (corregida), frente a la plaza");
await dlg.getByRole("button", { name: "Guardar cambios" }).click();
check("editar la dirección de una sucursal: se guarda", !!(await waitFor(async () => (await q(db.from("branches").select("direccion").eq("id", newBranch.id)))[0].direccion === "Jr. Prueba 123 (corregida), frente a la plaza", 15000)));
await pa.screenshot({ path: `${SHOTS}04b-sucursal-nueva.png` });

await pa.goto(`${BASE}/promociones`);
await openCard(pa); // el alta abre un diálogo
const promoDlg = pa.locator("dialog[open]");
await promoDlg.locator("input[name=titulo]").fill("Promo desde el panel");
await promoDlg.locator("textarea[name=descripcion]").fill("Descripción de prueba");
await promoDlg.locator("input[name=valid_from]").fill("2026-09-01T00:00");
await promoDlg.locator("input[name=valid_to]").fill("2026-12-31T23:59");
check("promociones: la vigencia viene propuesta y se puede cambiar con atajos", (await promoDlg.locator(".chip-btn").count()) === 3);
await promoDlg.getByRole("button", { name: "Crear promoción" }).click();
const created = await waitFor(async () => (await q(db.from("promotions").select("*").eq("titulo", "Promo desde el panel")))[0], 15000);
check("admin crea promoción; la hora de Lima se guarda en UTC (00:00 Lima = 05:00Z)", created?.valid_from === "2026-09-01T05:00:00+00:00" && created?.branch_id === null, JSON.stringify(created));
await pa.screenshot({ path: `${SHOTS}05-promociones.png` });

// ── Móvil (390 px): una columna, lista → hilo → volver
console.log("\n── Móvil");
const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
const pm = await login(mob, "huanuco@optuz.local");
await pm.waitForSelector(".conv", { timeout: 30000 });
await pm.getByRole("button", { name: "Todas", exact: true }).click();
check("móvil: /inbox muestra la lista y oculta el hilo", (await pm.locator(".conv-list").isVisible()) && !(await pm.locator(".thread-pane").isVisible()));
await pm.screenshot({ path: `${SHOTS}06-movil-lista.png` });
await pm.locator(".conv").first().click();
await pm.waitForSelector(".thread", { timeout: 30000 });
check("móvil: al abrir un chat se ve el hilo y se oculta la lista", (await pm.locator(".thread").isVisible()) && !(await pm.locator(".conv-list").isVisible()));
check("móvil: aparece '← Chats' para volver", await pm.getByRole("link", { name: /Chats/ }).isVisible());
await pm.screenshot({ path: `${SHOTS}07-movil-hilo.png` });
await pm.getByRole("link", { name: /Chats/ }).click();
await pm.waitForSelector(".conv-list", { state: "visible", timeout: 15000 });
check("móvil: '← Chats' vuelve a la lista", await pm.locator(".conv-list").isVisible());
check("escritorio: '← Chats' no se muestra", !(await p.getByRole("link", { name: /Chats/ }).isVisible().catch(() => false)));

// ═════ 3. Identidad, entregas múltiples y estados de la Cloud API ═════
console.log("\n── Identidad (BSUID), entregas múltiples y estados");
const diego = { user_id: "US.13491208655302741918", name: "Diego" }; // usuario de WhatsApp: sin wa_id / from
const a0 = llmCalls.length, w0 = waCalls.length;
const rB = await post(inbound(diego, "wamid.b1", "Buenas tardes"));
check("usuario de WhatsApp sin número (solo BSUID): el webhook responde 200", rB.status === 200);
const diegoLead = await waitFor(async () => (await q(db.from("leads").select("*").eq("bsuid", diego.user_id)))[0], 15000);
check("lead creado con BSUID, sin teléfono y con su nombre", !!diegoLead && diegoLead.phone === null && diegoLead.nombre === "Diego", JSON.stringify(diegoLead));
check("el agente le responde por BSUID (`recipient`, sin `to`)", !!(await waitFor(() => waCalls.length === w0 + 1, 60000)) && waCalls[w0].body.recipient === diego.user_id && !("to" in waCalls[w0].body), JSON.stringify(waCalls[w0]?.body));
check("el agente sabe que no hay teléfono y debe pedirlo (contact_phone)", !!llmCalls[a0]?.body.instructions.includes("contact_phone"));
await p.goto(`${BASE}/leads`);
check("/leads muestra 'Sin número visible' para ese cliente", await p.getByText("Sin número visible").isVisible({ timeout: 30000 }).catch(() => false));

const w1 = waCalls.length;
await post(inbound({ ...diego, wa_id: "51955443322" }, "wamid.b2", "Mi número es este"));
const merged = await waitFor(async () => { const l = (await q(db.from("leads").select("*").eq("bsuid", diego.user_id)))[0]; return l?.phone === "+51955443322" ? l : null; }, 15000);
check("misma persona ahora con teléfono visible: se completa el lead y no se duplica", !!merged && (await q(db.from("leads").select("id").eq("nombre", "Diego"))).length === 1);
check("...y desde ahora se le escribe al teléfono (`to`)", !!(await waitFor(() => waCalls.length === w1 + 1, 60000)) && waCalls[w1].body.to === "51955443322");

// Una sucursal registrada en el panel: el agente la conoce (con su dirección ACTUAL) y acepta su nombre sin tilde ni mayúsculas
const rosa = { wa_id: "51944444444", user_id: "PE.444", name: "Rosa" };
const aRosa = llmCalls.length, wRosa = waCalls.length;
await post(inbound(rosa, "wamid.r1", "Quiero mi cita en la sucursal E2E"));
await waitFor(() => waCalls.length === wRosa + 1, 60000);
const rosaIns = llmCalls[aRosa]?.body.instructions ?? "";
check("el agente conoce la sucursal nueva con su dirección corregida (sale de la base, no del código)", rosaIns.includes("- Sucursal E2E: Jr. Prueba 123 (corregida), frente a la plaza"), rosaIns.slice(0, 400));
check("...y lista todas las sucursales activas en el prompt", rosaIns.includes("las 6 sucursales") && rosaIns.includes("Huánuco: Jr. 28 de Julio 1131"));
const rosaLead = (await q(db.from("leads").select("branch_id").eq("bsuid", rosa.user_id)))[0];
check("set_branch con 'sucursal e2e' (minúsculas, sin tilde) asigna la sucursal nueva", rosaLead?.branch_id === newBranch.id, JSON.stringify(rosaLead));
await q(db.from("branches").update({ activa: false }).eq("id", newBranch.id));
const aOff = llmCalls.length, wOff = waCalls.length;
await post(inbound(rosa, "wamid.r2", "Hola otra vez"));
await waitFor(() => waCalls.length === wOff + 1, 60000);
check("una sucursal desactivada deja de estar en la lista del prompt del agente", !(llmCalls[aOff]?.body.instructions ?? "").includes("- Sucursal E2E:") && (llmCalls[aOff]?.body.instructions ?? "").includes("las 5 sucursales"));

// Una entrega con DOS mensajes seguidos del mismo cliente: se guardan ambos y el agente responde UNA sola vez
const elena = { wa_id: "51922222222", user_id: "PE.222", name: "Elena" };
const w2 = waCalls.length;
const multi = wrap({ contacts: [contactOf(elena)], messages: [waMessage(elena, "wamid.e1", "Hola"), waMessage(elena, "wamid.e2", "¿Atienden el sábado?")] });
const rM = await (await post(multi)).json();
check("entrega con 2 mensajes: se procesan los 2", rM.processed === 2, JSON.stringify(rM));
await waitFor(() => waCalls.length > w2, 60000);
await sleep(4000);
check("...y el agente responde una sola vez (solo la corrida del último mensaje)", waCalls.length === w2 + 1 && (await q(db.from("messages").select("id").in("wa_message_id", ["wamid.e1", "wamid.e2"]))).length === 2, `respuestas: ${waCalls.length - w2}`);

// Multimedia: la imagen se guarda como adjunto (con su id de media) y su pie de foto como texto
const foto = wrap({ contacts: [contactOf(elena)], messages: [waMessage(elena, "wamid.img", "", { type: "image", text: undefined, image: { id: "MEDIA-1", mime_type: "image/jpeg", caption: "Mi receta" } })] });
await post(foto);
const imgMsg = await waitFor(async () => (await q(db.from("messages").select("*").eq("wa_message_id", "wamid.img")))[0], 15000);
check("imagen con pie de foto: texto = caption y adjunto con id de media", imgMsg?.content === "Mi receta" && imgMsg.attachments?.[0]?.id === "MEDIA-1" && imgMsg.attachments[0].type === "image", JSON.stringify(imgMsg));

// Estados: solo `failed` hace algo. 131047 = ventana de 24 h cerrada
const okStatuses = wrap({ statuses: ["sent", "delivered", "read"].map((status) => ({ id: "wamid.OUT1", status, recipient_id: "51987654321" })) });
const rS = await (await post(okStatuses)).json();
const deliv = async () => (await q(db.from("messages").select("delivery_status").eq("wa_message_id", "wamid.OUT1")))[0]?.delivery_status;
check("estados sent / delivered / read: se registran (3 eventos) y el mensaje queda «read»", rS.processed === 3 && (await deliv()) === "read", JSON.stringify({ rS, d: await deliv() }));
await post(wrap({ statuses: [{ id: "wamid.OUT1", status: "delivered", recipient_id: "51987654321" }] }));
check("un estado viejo que llega tarde (delivered tras read) NO retrocede", (await deliv()) === "read");
const failed = wrap({ statuses: [{ id: "wamid.OUT1", status: "failed", recipient_id: "51987654321", errors: [{ code: 131047, title: "Re-engagement message" }] }] });
await post(failed);
const cf = (await q(db.from("conversations").select("requires_human, handoff_reason").eq("id", conv.id)))[0];
check("estado `failed`: la conversación queda 'Requiere humano' con el motivo (131047)", cf.requires_human === true && cf.handoff_reason.includes("131047"), JSON.stringify(cf));
const failedUnknown = wrap({ statuses: [{ id: "wamid.NOEXISTE", status: "failed", recipient_id: "51900000099", errors: [{ code: 131026, title: "Message undeliverable" }] }] });
check("estado `failed` de un mensaje desconocido: 200 sin error", (await post(failedUnknown)).status === 200);

// Otro número del mismo WABA y objetos que no son de WhatsApp: se ignoran
const rOther = await (await post(inbound({ wa_id: "51933333333", user_id: "PE.333", name: "Otro" }, "wamid.o1", "hola", { pnid: "OTRO_NUMERO" }))).json();
check("mensaje de OTRO número del WABA: se ignora sin crear leads", rOther.processed === 0 && (await q(db.from("leads").select("id").eq("nombre", "Otro"))).length === 0);
const rPage = await post(JSON.stringify({ object: "page", entry: [] }));
check("objeto que no es de WhatsApp: 200 y sin efecto", rPage.status === 200 && (await rPage.json()).processed === 0);
check("cuerpo que no es JSON (con firma válida) → 400", (await post("esto no es json")).status === 400);

const events = await q(db.from("webhook_events").select("event_id, processed_at, error"));
check("todos los eventos quedaron procesados", events.every((e) => e.processed_at), JSON.stringify(events.filter((e) => !e.processed_at)));

// ═════ CRM: resumen, pipeline, contactos, asignación, respuestas rápidas, conocimiento, equipo ═════
console.log("\n── CRM");
const carlaBranchId = branchesBefore.find((b) => b.nombre === "Huánuco").id;
await pa.goto(`${BASE}/dashboard`);
check("/dashboard: muestra el resumen con métricas", await pa.getByText("Conversaciones nuevas", { exact: true }).isVisible({ timeout: 30000 }).catch(() => false) && await pa.getByRole("heading", { name: "Embudo" }).isVisible());
await pa.screenshot({ path: `${SHOTS}20-dashboard.png` });

// Tablero de leads: las cuatro etapas hacia la cita, más «Requiere humano» delante
// Parte de un estado conocido: las pruebas de entregas fallidas dejaron a Carla esperando a una persona.
await q(db.from("conversations").update({ requires_human: false, handoff_reason: null }).eq("id", conv.id));
await pa.goto(`${BASE}/pipeline`);
await pa.waitForSelector(".lead-card", { timeout: 30000 });
await pa.waitForLoadState("networkidle");
const carlaCard = () => pa.locator(".lead-card", { hasText: "Carla" });
const stageOf = async () => (await q(db.from("leads").select("stage").eq("id", lead.id)))[0].stage;
const colTitles = await pa.locator(".column > header strong").allInnerTexts();
check("tablero: «Requiere humano» y las cuatro etapas, en ese orden", JSON.stringify(colTitles) === JSON.stringify(["Requiere humano", "Nuevo", "En seguimiento", "Sin respuesta", "Cita agendada"]), JSON.stringify(colTitles));
check("tablero: quien ya recibió respuesta está en «En seguimiento»", await pa.locator(".column[data-status='seguimiento'] .lead-card", { hasText: "Carla" }).isVisible());
await carlaCard().locator("select").selectOption("cita_agendada");
check("tablero: mover con el selector persiste la etapa", !!(await waitFor(async () => (await stageOf()) === "cita_agendada", 10000)));
// El arrastre HTML5 solo funciona con la página hidratada: se espera a que se estabilice y se reintenta una vez.
await pa.waitForLoadState("networkidle");
const dragged = async () => !!(await waitFor(async () => (await stageOf()) === "sin_respuesta", 6000));
await carlaCard().dragTo(pa.locator(".column[data-status='sin_respuesta']"));
let movedByDrag = await dragged();
if (!movedByDrag) { await carlaCard().dragTo(pa.locator(".column[data-status='sin_respuesta']")); movedByDrag = await dragged(); }
check("tablero: arrastrar la tarjeta a otra columna persiste la etapa", movedByDrag);

// «Requiere humano» manda sobre la etapa y, al sacarla de ahí, se da por atendida
await carlaCard().locator("select").selectOption("humano");
const reqConv = await waitFor(async () => { const c = (await q(db.from("conversations").select("requires_human, bot_active").eq("lead_id", lead.id)))[0]; return c.requires_human ? c : null; }, 10000);
check("tablero: pasar a «Requiere humano» avisa a una persona y pausa el bot", reqConv?.requires_human === true && reqConv.bot_active === false, JSON.stringify(reqConv));
check("...la tarjeta sale en esa columna y no en su etapa, que se conserva", await pa.locator(".column[data-status='humano'] .lead-card", { hasText: "Carla" }).isVisible() && (await stageOf()) === "sin_respuesta");
await carlaCard().locator("select").selectOption("seguimiento");
const attended = await waitFor(async () => { const c = (await q(db.from("conversations").select("requires_human").eq("lead_id", lead.id)))[0]; return !c.requires_human && (await stageOf()) === "seguimiento"; }, 10000);
check("tablero: sacarla de «Requiere humano» la da por atendida y la deja en la etapa elegida", !!attended);
await pa.screenshot({ path: `${SHOTS}21-pipeline.png` });
// Se deja a Carla como estaba para las pruebas siguientes
await q(db.from("jobs").delete().eq("status", "pending").contains("payload", { conversationId: conv.id }));
await q(db.from("conversations").update({ bot_active: true, requires_human: false, handoff_reason: null, handoff_summary: null, escalated_at: null, assigned_to: null }).eq("id", conv.id));
await q(db.from("leads").update({ stage: "seguimiento" }).eq("id", lead.id));

// Contactos: búsqueda, alta manual, ficha, CSV
await pa.goto(`${BASE}/leads?q=carla`);
check("contactos: la búsqueda encuentra a Carla", await pa.getByRole("link", { name: "Carla" }).isVisible({ timeout: 30000 }).catch(() => false));
await pa.goto(`${BASE}/leads?q=zzzz`);
check("contactos: búsqueda sin resultados", await pa.getByText("No hay contactos con esos filtros").isVisible({ timeout: 30000 }).catch(() => false));
await pa.goto(`${BASE}/leads?q=${encodeURIComponent("a,b)(*%")}`);
check("contactos: caracteres especiales en la búsqueda no rompen la página", await pa.getByText("No hay contactos con esos filtros").isVisible({ timeout: 30000 }).catch(() => false));
await pa.goto(`${BASE}/leads`);
await openCard(pa);
await pa.fill("form input[name=nombre]", "Contacto Manual");
await pa.fill("form input[name=phone]", "955 000 111");
await pa.locator("form select[name=branch_id]").selectOption({ label: "Huánuco" });
await pa.fill("form input[name=tags]", "VIP, Prueba");
await pa.getByRole("button", { name: "Crear contacto" }).click();
await pa.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30000 });
const manual = (await q(db.from("leads").select("*").eq("phone", "+51955000111")))[0];
check("contacto manual: teléfono normalizado a E.164, etiquetas limpias y sucursal", manual?.nombre === "Contacto Manual" && JSON.stringify(manual.tags) === '["vip","prueba"]' && manual.branch_id === carlaBranchId, JSON.stringify(manual));
check("contacto manual: tiene conversación propia", (await q(db.from("conversations").select("id").eq("lead_id", manual.id))).length === 1);
await pa.goto(`${BASE}/leads`);
await openCard(pa);
await pa.fill("form input[name=nombre]", "Duplicado");
await pa.fill("form input[name=phone]", "+51955000111");
await pa.locator("form select[name=branch_id]").selectOption({ label: "Huánuco" });
await pa.getByRole("button", { name: "Crear contacto" }).click();
check("contacto manual: teléfono duplicado se rechaza con aviso", await pa.getByText("Ya existe un contacto con el teléfono +51955000111").isVisible({ timeout: 30000 }).catch(() => false));
await pa.goto(`${BASE}/leads`);
await openCard(pa);
await pa.fill("form input[name=nombre]", "Malo");
await pa.fill("form input[name=phone]", "12");
await pa.locator("form select[name=branch_id]").selectOption({ label: "Huánuco" });
await pa.getByRole("button", { name: "Crear contacto" }).click();
check("contacto manual: teléfono inválido se rechaza con aviso", await pa.getByText("El teléfono no es válido").isVisible({ timeout: 30000 }).catch(() => false));

await pa.goto(`${BASE}/leads/${manual.id}`);
await pa.fill("input[name=email]", "manual@example.com");
await pa.fill("input[name=tags]", "vip, lentes de contacto");
await pa.fill("textarea[name=notes]", "Prefiere atención por la tarde");
await pa.getByRole("button", { name: "Guardar" }).click();
check("ficha: guardar email, etiquetas y notas persiste", !!(await waitFor(async () => { const l = (await q(db.from("leads").select("email, tags, notes").eq("id", manual.id)))[0]; return l.email === "manual@example.com" && l.tags.includes("lentes de contacto") && l.notes === "Prefiere atención por la tarde"; }, 10000)));
await pa.waitForLoadState("networkidle");
await pa.fill("input[name=email]", "a@b");
await pa.getByRole("button", { name: "Guardar" }).click();
check("ficha: un email inválido se rechaza con aviso", await pa.getByText("El email no es válido").isVisible({ timeout: 30000 }).catch(() => false));

await p.goto(`${BASE}/leads/${manual.id}`);
check("ficha: el vendedor de la misma sucursal la ve (sin selector de sucursal)", await p.locator("input[name=email]").isVisible({ timeout: 30000 }).catch(() => false) && (await p.locator("select[name=branch_id]").count()) === 0);
const tocFicha = await pt.goto(`${BASE}/leads/${manual.id}`);
check("ficha: el vendedor de otra sucursal recibe 404", tocFicha.status() === 404, String(tocFicha.status()));

const csvRes = await adm.request.get(`${BASE}/api/leads/export?q=Contacto`);
const csvText = await csvRes.text();
check("exportar CSV: 200, text/csv, con BOM, cabecera y el contacto", csvRes.status() === 200 && (csvRes.headers()["content-type"] ?? "").includes("text/csv") && csvText.startsWith("﻿Nombre,") && csvText.includes("Contacto Manual") && !csvText.includes("Carla"), csvText.slice(0, 200));
check("exportar CSV: sin sesión → 401", (await fetch(`${BASE}/api/leads/export`)).status === 401);

// Respuestas rápidas (admin) y su uso en el inbox
await pa.goto(`${BASE}/respuestas`);
await openCard(pa);
await pa.fill("input[name=atajo]", "/E2E-Saludo");
await pa.fill("input[name=titulo]", "Saludo inicial");
await pa.fill("textarea[name=cuerpo]", "Hola, gracias por escribir a Caddyf. ¿En qué te ayudamos?");
await pa.getByRole("button", { name: "Crear" }).click();
check("respuestas rápidas: el atajo se normaliza (minúsculas, sin /) y se guarda", !!(await waitFor(async () => (await q(db.from("quick_replies").select("atajo").eq("atajo", "e2e-saludo"))).length === 1, 10000)));
await pa.locator(".banner.ok").waitFor({ timeout: 20000 }); // el alta redirige: espera a la recarga antes de reabrir el bloque
await openCard(pa);
await pa.fill("input[name=atajo]", "e2e-saludo");
await pa.fill("input[name=titulo]", "Otro");
await pa.fill("textarea[name=cuerpo]", "x");
await pa.getByRole("button", { name: "Crear" }).click();
check("respuestas rápidas: atajo repetido → aviso", await pa.getByText("Ya existe el atajo /e2e-saludo").isVisible({ timeout: 30000 }).catch(() => false));
await p.goto(`${BASE}/respuestas`);
check("respuestas rápidas: el vendedor no accede (redirige al inbox)", p.url().includes("/inbox"), p.url());

await p.goto(`${BASE}/inbox/${conv.id}`);
await p.waitForSelector(".composer textarea", { timeout: 30000 });
await sleep(1500);
await q(db.from("conversations").update({ bot_active: false }).eq("id", conv.id));
await p.reload();
await p.waitForSelector(".composer textarea:not([disabled])", { timeout: 30000 });
await p.locator(".composer textarea").fill("/e2e-sal");
check("inbox: escribir /e2e-sal abre el menú con la respuesta rápida", await p.locator(".qr-menu").getByText("/e2e-saludo").isVisible({ timeout: 10000 }).catch(() => false));
await p.locator(".composer textarea").press("Enter");
check("inbox: Enter inserta el mensaje de la respuesta rápida (sin enviarlo)", (await p.locator(".composer textarea").inputValue()).startsWith("Hola, gracias por escribir a Caddyf") && (await q(db.from("messages").select("id").eq("content", "Hola, gracias por escribir a Caddyf. ¿En qué te ayudamos?"))).length === 0);

// Asignación y filtros del inbox
const huanuco = (await q(db.from("users").select("id, nombre").eq("email", "huanuco@optuz.local")))[0];
await p.getByRole("combobox", { name: "Asignado a" }).selectOption(huanuco.id);
check("asignar la conversación a un asesor persiste", !!(await waitFor(async () => (await q(db.from("conversations").select("assigned_to").eq("id", conv.id)))[0].assigned_to === huanuco.id, 10000)));
await p.goto(`${BASE}/inbox`);
await p.waitForSelector(".conv", { timeout: 30000 });
await p.getByRole("button", { name: "Mías", exact: true }).click();
check("inbox: filtro «Mías» muestra la conversación asignada", await p.locator(".conv", { hasText: "Carla" }).isVisible());
await p.getByRole("button", { name: "Sin asignar", exact: true }).click();
check("inbox: los filtros se suman («Mías» + «Sin asignar» no puede dar nada)", (await p.locator(".conv").count()) === 0 && (await p.locator(".conv-filters .chip-btn.on").count()) === 2);
await p.getByRole("button", { name: "Mías", exact: true }).click();
check("inbox: quitar «Mías» deja solo «Sin asignar», y Carla sigue fuera", (await p.locator(".conv", { hasText: "Carla" }).count()) === 0 && (await p.locator(".conv-filters .chip-btn.on").count()) === 1);
await p.getByRole("button", { name: "Todas", exact: true }).click();
await p.getByPlaceholder("Buscar chat…").fill("zzzz");
check("inbox: la búsqueda sin coincidencias muestra «Sin resultados»", await p.getByText("Sin resultados").isVisible());
await q(db.from("conversations").update({ bot_active: true, assigned_to: null }).eq("id", conv.id));

// Conocimiento del agente
await pa.goto(`${BASE}/conocimiento`);
await openCard(pa);
const kbDlg = pa.locator("dialog[open]");
await kbDlg.locator("input[name=titulo]").fill("Formas de pago E2E");
await kbDlg.locator("textarea[name=contenido]").fill("Aceptamos Yape, Plin, efectivo y tarjetas. KB-E2E-MARCA");
await kbDlg.locator("select[name=categoria]").selectOption("compra");
check("conocimiento: se ve cómo queda el texto antes de guardarlo", await kbDlg.locator(".wa-bubble", { hasText: "Aceptamos Yape" }).isVisible());
await kbDlg.getByRole("button", { name: "Agregar", exact: true }).click();
check("conocimiento: la entrada se guarda", !!(await waitFor(async () => (await q(db.from("knowledge_base").select("id").eq("titulo", "Formas de pago E2E"))).length === 1, 10000)));
const aKb = llmCalls.length, wKb = waCalls.length;
await post(inbound(rosa, "wamid.kb1", "¿Cómo puedo pagar?"));
await waitFor(() => waCalls.length === wKb + 1, 60000);
check("conocimiento: el agente recibe la entrada activa en sus instrucciones", (llmCalls[aKb]?.body.instructions ?? "").includes("### Formas de pago E2E\nAceptamos Yape, Plin, efectivo y tarjetas. KB-E2E-MARCA"));
// Apagarla desde la tarjeta, de un clic (antes había que marcar una casilla y además guardar)
await pa.goto(`${BASE}/conocimiento`);
await pa.waitForLoadState("networkidle");
check("conocimiento: la barra muestra cuánto del presupuesto ocupa lo activo", (await pa.locator(".kb-budget").innerText()).includes("de 9,000 caracteres"));
const kbGrupo = await pa.locator(".kb-group").evaluateAll((els) => els.map((el) => ({ tema: el.querySelector(".kb-g-head h2")?.textContent, fichas: [...el.querySelectorAll(".kb-card h3")].map((h) => h.textContent) })));
check("conocimiento: las fichas se agrupan por tema", kbGrupo.find((g) => g.fichas.includes("Formas de pago E2E"))?.tema === "Compra y entrega", JSON.stringify(kbGrupo.map((g) => g.tema)));
await pa.locator(".kb-card", { hasText: "Formas de pago E2E" }).locator("button.switch").click();
check(
  "conocimiento: el interruptor de la tarjeta la apaga de un clic",
  !!(await waitFor(async () => (await q(db.from("knowledge_base").select("activa").eq("titulo", "Formas de pago E2E")))[0]?.activa === false, 10000)),
);
const aKb2 = llmCalls.length, wKb2 = waCalls.length;
await post(inbound(rosa, "wamid.kb2", "Gracias"));
await waitFor(() => waCalls.length === wKb2 + 1, 60000);
check("conocimiento: una entrada desactivada deja de llegar al agente", !(llmCalls[aKb2]?.body.instructions ?? "").includes("KB-E2E-MARCA"));
await p.goto(`${BASE}/conocimiento`);
check("conocimiento: el vendedor no accede", p.url().includes("/inbox"), p.url());

// Equipo (admin crea usuarios)
await pa.goto(`${BASE}/equipo`);
await pa.waitForSelector("table", { timeout: 30000 });
await pa.waitForLoadState("networkidle");
const cellOf = (nombre, i) => pa.locator("tbody tr", { hasText: nombre }).locator("td").nth(i).innerText();
check("equipo: lista a las personas con su rol y a quién atienden", (await cellOf("Vendedor Huánuco", 2)).trim() === "Huánuco" && (await cellOf("Vendedor Huánuco", 1)).includes("Asesor") && (await cellOf("Admin Dev", 2)).trim() === "Todas las sucursales");
check("equipo: solo avisa de las sucursales que ningún asesor cubre (no exige uno por tienda)", await pa.locator(".banner.warn", { hasText: "Sin asesor en:" }).isVisible() && !(await pa.locator(".banner.warn").innerText()).includes("Huánuco"));
check("equipo: sin filtros por rol (con 1 o 2 personas sobran)", (await pa.locator(".chips").count()) === 0);
await pa.waitForLoadState("networkidle");
// Tu propia cuenta: el rol no se puede cambiar
await pa.locator("tr", { hasText: "Admin Dev" }).getByRole("button", { name: "Editar" }).click();
await pa.locator("dialog[open]").waitFor({ timeout: 10000 });
check("equipo: en tu propia cuenta el rol está bloqueado", await pa.locator("dialog[open] select").first().isDisabled());
await pa.keyboard.press("Escape");
// Crear
await pa.getByRole("button", { name: "Nuevo usuario" }).click();
const td = pa.locator("dialog[open]");
await td.waitFor({ timeout: 10000 });
await td.locator("select[name=role]").selectOption("admin");
check("equipo: al elegir «Administrador» el selector de sucursal se desactiva", await td.locator("select[name=branch_id]").isDisabled());
await td.locator("select[name=role]").selectOption("vendedor");
check("equipo: como asesor la sucursal es OPCIONAL y por defecto atiende todas", await td.locator("select[name=branch_id]").isEnabled() && !(await td.locator("select[name=branch_id]").evaluate((el) => el.required)) && (await td.locator("select[name=branch_id]").inputValue()) === "" && (await td.locator("select[name=branch_id] option").first().innerText()) === "Todas las sucursales");
await td.getByRole("button", { name: "Generar" }).click();
const generated = await td.locator("input[name=password]").inputValue();
check("equipo: «Generar» crea una contraseña de 12 caracteres y la muestra", generated.length === 12 && (await td.locator("input[name=password]").getAttribute("type")) === "text", generated);
await pa.screenshot({ path: `${SHOTS}25-dialogo-usuario.png` });
await td.locator("input[name=nombre]").fill("Vendedora Nueva");
await td.locator("input[name=email]").fill("nueva@optuz.local");
await td.locator("input[name=password]").fill("clave-nueva-123");
await td.locator("select[name=branch_id]").selectOption({ label: "Huánuco" });
await td.getByRole("button", { name: "Crear usuario" }).click();
const nuevaU = await waitFor(async () => (await q(db.from("users").select("id, role, branch_id").eq("email", "nueva@optuz.local")))[0], 15000);
check("equipo: crear usuario → perfil con rol y sucursal", nuevaU?.role === "vendedor" && nuevaU.branch_id === carlaBranchId, JSON.stringify(nuevaU));
const newCtx = await browser.newContext();
const pn = await newCtx.newPage();
await pn.goto(`${BASE}/login`);
await pn.fill("input[name=email]", "nueva@optuz.local");
await pn.fill("input[name=password]", "clave-nueva-123");
await pn.click("button[type=submit]");
check("equipo: el usuario nuevo puede iniciar sesión", await pn.waitForURL("**/inbox", { timeout: 60000 }).then(() => true).catch(() => false));
await pa.goto(`${BASE}/equipo`);
await pa.waitForLoadState("networkidle");
await pa.getByRole("button", { name: "Nuevo usuario" }).click();
await td.waitFor({ timeout: 10000 });
await td.locator("input[name=nombre]").fill("Duplicada");
await td.locator("input[name=email]").fill("nueva@optuz.local");
await td.locator("input[name=password]").fill("clave-nueva-123");
await td.locator("select[name=branch_id]").selectOption({ label: "Huánuco" });
await td.getByRole("button", { name: "Crear usuario" }).click();
check("equipo: email repetido → aviso", await pa.getByText("Ya existe un usuario con ese email").isVisible({ timeout: 30000 }).catch(() => false));
await p.goto(`${BASE}/equipo`);
check("equipo: el vendedor no accede", p.url().includes("/inbox"), p.url());
await newCtx.close();
await db.auth.admin.deleteUser(nuevaU.id); // users cae en cascada
await pa.goto(`${BASE}/equipo`);
await pa.waitForLoadState("networkidle");
await pa.getByRole("button", { name: "Nuevo usuario" }).click();
await td.waitFor({ timeout: 10000 });
await td.locator("input[name=nombre]").fill("Asesora Global");
await td.locator("input[name=email]").fill("global-ui@optuz.local");
await td.locator("input[name=password]").fill("clave-global-123");
await td.getByRole("button", { name: "Crear usuario" }).click();
const globalU = await waitFor(async () => (await q(db.from("users").select("id, role, branch_id").eq("email", "global-ui@optuz.local")))[0], 15000);
check("equipo: un asesor creado sin elegir sucursal queda sin sucursal (atiende todas)", globalU?.role === "vendedor" && globalU.branch_id === null, JSON.stringify(globalU));
await pa.goto(`${BASE}/equipo`);
await pa.waitForSelector("table", { timeout: 30000 });
check("equipo: en la lista figura «Todas las sucursales» y ya no avisa de sucursales sin asesor", (await cellOf("Asesora Global", 2)).trim() === "Todas las sucursales" && (await pa.locator(".banner.warn", { hasText: "Sin asesor en:" }).count()) === 0);
await pa.goto(`${BASE}/sucursales`);
await pa.waitForLoadState("networkidle");
check("sucursales: cada sucursal cuenta al asesor que atiende todas", (await pa.locator(".stat-chip", { hasText: "con asesor" }).innerText()).startsWith("5"), await pa.locator(".stat-chip", { hasText: "con asesor" }).innerText());
await db.auth.admin.deleteUser(globalU.id);
await pa.screenshot({ path: `${SHOTS}22-equipo.png` });

// ═════ Baja, re-consentimiento, PROMO, registro y eliminación de datos (Ley 29733) ═════
console.log("\n── Consentimientos");
{
  const bea = { wa_id: "51955555555", user_id: "PE.555", name: "Beatriz" };
  const w0 = waCalls.length;
  await post(inbound(bea, "wamid.baja1", "Hola, quiero información"));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  const bLead = (await q(db.from("leads").select("id").eq("bsuid", "PE.555")))[0];
  const bConv = (await q(db.from("conversations").select("id").eq("lead_id", bLead.id)))[0];
  const st = async () => (await q(db.from("leads").select("opt_out, promo_consent").eq("id", bLead.id)))[0];
  const convSt = async () => (await q(db.from("conversations").select("requires_human, handoff_reason, bot_active").eq("id", bConv.id)))[0];
  const log = async () => q(db.from("consent_log").select("kind, action, channel, evidence, wa_message_id, actor_id, text_version").eq("lead_id", bLead.id).order("created_at", { ascending: true }));
  const lastText = () => waCalls.at(-1)?.body.text?.body ?? waCalls.at(-1)?.body.interactive?.body?.text ?? "";
  const say = (id, text) => post(inbound(bea, id, text));

  // ── A. Se da de baja y escribe otra cosa: UNA pregunta de re-consentimiento, sin promociones ──
  await q(db.from("leads").update({ opt_out: true, promo_consent: false }).eq("id", bLead.id));
  let l = llmCalls.length, w = waCalls.length;
  await say("wamid.baja2", "Quiero una cita");
  await waitFor(() => waCalls.length === w + 1, 20000);
  check("dado de baja que escribe: el bot responde UNA vez pidiendo autorización (sin llamar al modelo)", waCalls.length === w + 1 && llmCalls.length === l && /autorizaci/.test(lastText()) && lastText().includes("*SÍ*"), lastText());
  const lastBody = waCalls.at(-1)?.body;
  check("...la pregunta llega con botones «Sí, acepto» / «No, gracias»", lastBody?.type === "interactive" && lastBody.interactive.type === "button" && lastBody.interactive.action.buttons.map((b) => b.reply.title).join("|") === "Sí, acepto|No, gracias", JSON.stringify(lastBody?.interactive));
  check("...separa la atención de las promociones (PROMO aparte)", lastText().includes("PROMO") && /solo te las enviaremos/.test(lastText()));
  check("...sigue dado de baja y sin promociones, y no queda pendiente", (await st()).opt_out === true && (await st()).promo_consent === false && (await convSt()).requires_human === false);
  check("...el evento queda registrado sin error", ((await q(db.from("webhook_events").select("error").eq("event_id", "msg:wamid.baja2")))[0]?.error ?? null) === null);

  // ── B. Responde algo que no es sí/no: no se reactiva; lo ve una persona ──
  w = waCalls.length;
  await say("wamid.baja3", "alta calidad?");
  const flagged = await waitFor(async () => ((await convSt()).requires_human ? await convSt() : null), 10000);
  check("una frase parecida («alta calidad?») NO reactiva: queda «Requiere humano»", (await st()).opt_out === true && !!flagged && /dado de baja/i.test(flagged.handoff_reason) && waCalls.length === w);
  await q(db.from("conversations").update({ requires_human: false, handoff_reason: null }).eq("id", bConv.id));

  // ── C. «sí» justo después de la pregunta: se reactiva y el agente contesta lo que había pedido ──
  l = llmCalls.length; w = waCalls.length;
  await say("wamid.baja4", "sí");
  await waitFor(() => waCalls.length === w + 1, 60000);
  check("«sí» tras la pregunta: se le quita la baja", (await st()).opt_out === false);
  check("...y el agente contesta con normalidad (usa el modelo)", llmCalls.length > l && waCalls.length === w + 1 && lastText().length > 0);
  let entries = await log();
  const granted = entries.find((e) => e.action === "otorgado" && e.kind === "atencion");
  check("...queda registrado: atención otorgada por WhatsApp con su texto y el id del mensaje", !!granted && granted.channel === "whatsapp" && granted.evidence === "sí" && granted.wa_message_id === "wamid.baja4" && granted.text_version === "v2", JSON.stringify(granted));
  check("...pero NO se le otorgan las promociones", (await st()).promo_consent === false && !entries.some((e) => e.kind === "promociones" && e.action === "otorgado"));

  // ── D. «sí» FUERA de contexto no reactiva nada ──
  await q(db.from("leads").update({ opt_out: true }).eq("id", bLead.id));
  await q(db.from("messages").insert({ conversation_id: bConv.id, direction: "out", sender: "bot", content: "Un mensaje cualquiera del bot", wa_message_id: "wamid.OUT-relleno" }));
  l = llmCalls.length; w = waCalls.length;
  await say("wamid.baja5", "sí");
  await waitFor(() => waCalls.length === w + 1, 20000);
  check("«sí» suelto (sin haber recibido la pregunta) NO lo reactiva: recibe la pregunta", (await st()).opt_out === true && lastText().includes("autorización"), lastText());
  check("...y no responde el modelo", llmCalls.length === l);
  await q(db.from("leads").update({ opt_out: true }).eq("id", bLead.id));

  // ── E. Responde «no»: sigue de baja y no se le escribe más ──
  w = waCalls.length;
  await say("wamid.baja6", "no gracias");
  await sleep(2000);
  check("«no gracias»: sigue de baja, sin más mensajes ni pendiente", (await st()).opt_out === true && waCalls.length === w && (await convSt()).requires_human === false);
  await say("wamid.baja7", "gracias");
  await sleep(1500);
  check("un «gracias» suelto no genera nada", waCalls.length === w && (await convSt()).requires_human === false);

  // ── F. ALTA por palabra clave ──
  await q(db.from("messages").insert({ conversation_id: bConv.id, direction: "out", sender: "bot", content: "Otro mensaje del bot", wa_message_id: "wamid.OUT-relleno2" }));
  l = llmCalls.length; w = waCalls.length;
  await say("wamid.baja8", "ALTA");
  await waitFor(() => waCalls.length === w + 1, 30000);
  check("ALTA: se le quita la baja y el bot lo confirma con un texto fijo (sin modelo)", (await st()).opt_out === false && lastText().includes("Volveremos a atenderte") && llmCalls.length === l, lastText());
  entries = await log();
  check("...queda registrado con el texto «ALTA»", entries.some((e) => e.kind === "atencion" && e.action === "otorgado" && e.evidence === "ALTA" && e.wa_message_id === "wamid.baja8"));

  // ── G. PROMO: consentimiento aparte de la atención ──
  l = llmCalls.length; w = waCalls.length;
  await say("wamid.baja9", "PROMO");
  await waitFor(() => waCalls.length === w + 1, 30000);
  check("PROMO: acepta promociones, con confirmación fija y sin modelo", (await st()).promo_consent === true && /promociones/.test(lastText()) && llmCalls.length === l, lastText());
  entries = await log();
  check("...registrado como consentimiento de PROMOCIONES", entries.some((e) => e.kind === "promociones" && e.action === "otorgado" && e.evidence === "PROMO"));

  // ── H. BAJA: revoca todo; y recién dado de baja no se le vuelve a preguntar (enfriamiento de 24 h) ──
  await q(db.from("leads").update({ opt_out: true, promo_consent: false }).eq("id", bLead.id));
  await q(db.from("consent_log").insert({ lead_id: bLead.id, kind: "atencion", action: "revocado", channel: "whatsapp", evidence: "baja", text_version: "v2" }));
  await q(db.from("messages").insert({ conversation_id: bConv.id, direction: "out", sender: "bot", content: "Confirmación de baja", wa_message_id: "wamid.OUT-relleno3" }));
  w = waCalls.length;
  await say("wamid.baja10", "Necesito ayuda urgente con mis lentes");
  const cooled = await waitFor(async () => ((await convSt()).requires_human ? await convSt() : null), 10000);
  check("recién dado de baja (menos de 24 h): NO se le vuelve a preguntar; queda «Requiere humano»", !!cooled && waCalls.length === w && (await st()).opt_out === true);
  await q(db.from("conversations").update({ requires_human: false, handoff_reason: null }).eq("id", bConv.id));

  // ── I. Panel: «Reactivar atención» con constancia ──
  await q(db.from("conversations").update({ requires_human: true, handoff_reason: "prueba", bot_active: false }).eq("id", bConv.id));
  await pa.goto(`${BASE}/inbox/${bConv.id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  check("panel: un cliente dado de baja se ve con un aviso y el botón «Reactivar atención»", await pa.locator(".optout-banner").getByText("Cliente dado de baja").isVisible() && await pa.getByRole("button", { name: "Reactivar atención" }).isVisible());
  await pa.getByRole("button", { name: "Reactivar atención" }).click();
  const reac = await waitFor(async () => { const c = await convSt(); return c.bot_active === true && c.requires_human === false && (await st()).opt_out === false ? c : null; }, 10000);
  check("panel: «Reactivar atención» quita la baja, reactiva el bot y limpia el pendiente", !!reac);
  entries = await log();
  const byPanel = entries.filter((e) => e.channel === "panel").at(-1);
  check("...y deja constancia con quién lo hizo (canal panel)", byPanel?.action === "otorgado" && byPanel.actor_id === users["admin@optuz.local"], JSON.stringify(byPanel));
  check("panel: el aviso de baja desaparece", !(await pa.locator(".optout-banner").isVisible({ timeout: 1500 }).catch(() => false)));

  // ── J. Ficha: consentimientos, historial y cambio manual de la baja ──
  await pa.goto(`${BASE}/leads/${bLead.id}`);
  await pa.waitForSelector("text=Consentimientos y datos personales", { timeout: 30000 });
  check("ficha: muestra el estado de atención y de promociones", await pa.locator(".consent-box", { hasText: "Atención" }).getByText("Autorizada").isVisible() && await pa.locator(".consent-box", { hasText: "Promociones" }).getByText("No autorizadas").isVisible());
  const histText = await pa.locator("section.card", { hasText: "Consentimientos y datos personales" }).locator("table").innerText();
  check("ficha: el historial muestra fecha, canal y la constancia («sí», «ALTA», «PROMO»)", histText.includes("«sí»") && histText.includes("«ALTA»") && histText.includes("«PROMO»") && histText.includes("WhatsApp") && histText.includes("Panel"), histText.slice(0, 300));
  await pa.locator("input[name=opt_out]").check();
  await pa.getByRole("button", { name: "Guardar", exact: true }).click();
  check("ficha: marcar «Dado de baja» y guardar la registra (canal panel, revocado)", !!(await waitFor(async () => (await st()).opt_out === true && (await log()).filter((e) => e.channel === "panel" && e.action === "revocado").length === 2, 10000)));
  await q(db.from("leads").update({ opt_out: false }).eq("id", bLead.id));

  // ── K. Vendedor: no ve la zona de eliminación ──
  await p.goto(`${BASE}/leads/${bLead.id}`);
  await p.waitForSelector("text=Consentimientos y datos personales", { timeout: 30000 });
  check("ficha: el vendedor ve los consentimientos pero NO puede eliminar datos", (await p.getByRole("button", { name: /Eliminar datos/ }).count()) === 0);

  // ── L. Eliminar los datos (derecho de cancelación) ──
  const hcoBranch = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  await q(db.from("appointments").insert({ lead_id: bLead.id, branch_id: hcoBranch, scheduled_at: new Date(Date.now() + 5 * 86400000).toISOString(), status: "agendada" }));
  await q(db.from("conversation_notes").insert({ conversation_id: bConv.id, author_id: users["admin@optuz.local"], body: "nota de Beatriz" }));
  const evBefore = (await q(db.from("webhook_events").select("event_id").like("event_id", "msg:wamid.baja%"))).length;
  await pa.goto(`${BASE}/leads/${bLead.id}`);
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: /Eliminar datos/ }).click();
  const dd = pa.locator("dialog[open]");
  await dd.waitFor({ timeout: 10000 });
  await pa.screenshot({ path: `${SHOTS}27-eliminar-datos.png` });
  await dd.locator("input[name=motivo]").fill("E2E prueba");
  await dd.locator("input[name=confirmacion]").fill("no");
  await dd.getByRole("button", { name: "Eliminar definitivamente" }).click();
  check("eliminar: sin escribir ELIMINAR se rechaza y no borra nada", await pa.locator(".banner.warn", { hasText: "escribe ELIMINAR" }).isVisible({ timeout: 20000 }).catch(() => false) && (await q(db.from("leads").select("id").eq("id", bLead.id))).length === 1);
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: /Eliminar datos/ }).click();
  await dd.waitFor({ timeout: 10000 });
  await dd.locator("input[name=motivo]").fill("E2E prueba");
  await dd.locator("input[name=confirmacion]").fill("ELIMINAR");
  await dd.getByRole("button", { name: "Eliminar definitivamente" }).click();
  check("eliminar: con la confirmación se borra el contacto y avisa", await pa.locator(".banner.ok", { hasText: "Contacto eliminado" }).isVisible({ timeout: 30000 }).catch(() => false));
  const gone = async (t, col, val) => (await q(db.from(t).select("id").eq(col, val))).length === 0;
  check("...desaparecen su conversación, mensajes, notas, citas y consentimientos", (await q(db.from("leads").select("id").eq("bsuid", "PE.555"))).length === 0 && await gone("conversations", "id", bConv.id) && await gone("messages", "conversation_id", bConv.id) && await gone("conversation_notes", "conversation_id", bConv.id) && await gone("appointments", "lead_id", bLead.id) && await gone("consent_log", "lead_id", bLead.id));
  const evAfter = (await q(db.from("webhook_events").select("event_id").like("event_id", "msg:wamid.baja%"))).length;
  check("...y los eventos crudos de WhatsApp con su número también", evBefore > 0 && evAfter === 0, `${evBefore} → ${evAfter}`);
  const dl = (await q(db.from("deletion_log").select("subject_hash, motivo, actor_id").eq("motivo", "E2E prueba")))[0];
  check("...queda una constancia SIN datos personales (hash, motivo y quién)", !!dl && /^[0-9a-f]{64}$/.test(dl.subject_hash) && dl.actor_id === users["admin@optuz.local"] && !JSON.stringify(dl).includes("51955555555"), JSON.stringify(dl));
  check("...y el panel vuelve a Contactos", pa.url().includes("/leads") && !pa.url().includes(bLead.id));
}

// ═════ Cola de trabajos, agrupación, reintentos, escalamiento, seguimiento y estado del sistema ═════
console.log("\n── Cola y operación");
{
  const runJobs = (secret = "e2e-cron") => fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { "x-cron-secret": secret } });
  const dueNow = (id) => q(db.from("jobs").update({ run_at: new Date().toISOString() }).eq("id", id));

  const lastJob = async (kind, convId, status) => {
    let qy = db.from("jobs").select("*").eq("kind", kind).contains("payload", { conversationId: convId }).order("created_at", { ascending: false }).limit(1);
    if (status) qy = qy.eq("status", status);
    return (await q(qy))[0];
  };

  // ── Endpoint para el cron ──
  check("/api/jobs/run sin secreto → 401", (await fetch(`${BASE}/api/jobs/run`, { method: "POST" })).status === 401);
  check("...con un secreto incorrecto → 401", (await runJobs("mal")).status === 401);
  const okRun = await runJobs();
  check("...con el secreto correcto → 200", okRun.status === 200 && (await okRun.json()).ok === true);

  // ── Ticks de entrega en el chat ──
  await pa.goto(`${BASE}/inbox/${conv.id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  await pa.screenshot({ path: `${SHOTS}29-ticks.png` });
  check("chat: un mensaje que WhatsApp no pudo entregar se ve como «⚠ no entregado»", await pa.locator(".ticks.failed").first().isVisible({ timeout: 15000 }).catch(() => false));
  check("chat: el mensaje del asesor muestra ✓ (enviado)", await pa.locator(".bubble.humano").first().locator("xpath=following-sibling::span[contains(@class,'msg-meta')]").locator(".ticks.sent").isVisible());
  // En vivo: Meta avisa que lo leyeron y el ✓ pasa a ✓✓ azul sin recargar
  await q(db.from("messages").update({ delivery_status: "read" }).eq("wa_message_id", "wamid.OUT2"));
  check("chat: al leerlo el cliente, el ✓ pasa a ✓✓ azul en vivo (sin recargar)", await pa.locator(".ticks.read").first().isVisible({ timeout: 15000 }).catch(() => false));

  // ── Agrupación: 3 mensajes seguidos → UNA respuesta ──
  const rafa = { wa_id: "51966666666", user_id: "PE.666", name: "Rafa" };
  let l0 = llmCalls.length, w0 = waCalls.length;
  await Promise.all(["Hola", "quiero información", "de los lentes"].map((t, i) => post(inbound(rafa, `wamid.agr${i}`, t))));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  await sleep(1500);
  const rLead = (await q(db.from("leads").select("id").eq("bsuid", "PE.666")))[0];
  const rConv = (await q(db.from("conversations").select("id").eq("lead_id", rLead.id)))[0];
  const runs = await q(db.from("agent_runs").select("outcome, input_tokens, output_tokens, tool_calls, duration_ms").eq("conversation_id", rConv.id));
  check("3 mensajes seguidos → UNA sola respuesta y un solo ciclo del modelo", waCalls.length === w0 + 1 && llmCalls.length - l0 === 3, `wa ${waCalls.length - w0}, llm ${llmCalls.length - l0}`);
  check("...y una sola corrida registrada, con tokens, herramientas y duración", runs.length === 1 && runs[0].outcome === "reply" && runs[0].input_tokens === 30 && runs[0].output_tokens === 15 && runs[0].tool_calls.map((t) => t.name).join() === "set_branch,get_active_promotions" && runs[0].duration_ms >= 0, JSON.stringify(runs));

  // ── Reintento: el modelo falla una vez y la tarea no se pierde ──
  w0 = waCalls.length;
  llmFail = 1;
  await post(inbound(rafa, "wamid.rt1", "¿Y tienen para niños?"));
  await waitFor(async () => { const j = await lastJob("agent", rConv.id); return j?.status === "pending" && j.attempts === 1 ? j : null; }, 45000);
  let job = await lastJob("agent", rConv.id);
  check("el modelo falla: la tarea NO se pierde; queda pendiente con el error registrado y sin enviar nada", job.status === "pending" && job.attempts === 1 && /fallo simulado/.test(job.last_error ?? "") && waCalls.length === w0, JSON.stringify(job));
  check("...y la corrida fallida queda en el registro (agent_runs: error)", (await q(db.from("agent_runs").select("id").eq("conversation_id", rConv.id).eq("outcome", "error"))).length === 1);
  await dueNow(job.id);
  await runJobs();
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  job = await lastJob("agent", rConv.id);
  check("el reintento responde al cliente y cierra la tarea (2 intentos)", waCalls.length === w0 + 1 && job.status === "done" && job.attempts === 2, JSON.stringify(job));

  // ── Se agotan los reintentos: se avisa a una persona ──
  w0 = waCalls.length;
  llmFail = 3;
  await post(inbound(rafa, "wamid.rt2", "¿hola?"));
  // Cada intento fallido deja la tarea «pending» con un intento más: se espera ese estado antes de adelantarla.
  await driveRetries(() => lastJob("agent", rConv.id), 1, 2);
  await waitFor(async () => (await lastJob("agent", rConv.id))?.status === "failed", 30000);
  await sleep(500);
  job = await lastJob("agent", rConv.id);
  const cSt = (await q(db.from("conversations").select("requires_human, handoff_reason").eq("id", rConv.id)))[0];
  check("3 fallos seguidos: la tarea queda «failed» y la conversación pasa a «Requiere humano»", job.status === "failed" && job.attempts === 3 && cSt.requires_human === true && /Error del agente/.test(cSt.handoff_reason ?? ""), JSON.stringify({ job, cSt }));

  // ── Página Sistema ──
  await pa.goto(`${BASE}/sistema`);
  await pa.waitForSelector("text=Tareas fallidas", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  check("/sistema: muestra la tarea fallida con su error y el botón «Reintentar»", await pa.locator("table", { hasText: "fallo simulado" }).getByRole("button", { name: "Reintentar" }).isVisible());
  check("/sistema: muestra la calidad y el límite del número de WhatsApp", await pa.getByText("Alta (verde)").isVisible() && await pa.getByText("250 conversaciones nuevas por día").isVisible());
  check("/sistema: lista las corridas del agente (resultado, herramientas)", await pa.locator("table", { hasText: "get_active_promotions" }).getByText("Respondió").first().isVisible());
  await pa.screenshot({ path: `${SHOTS}28-sistema.png` });
  llmFail = 0;
  await pa.getByRole("button", { name: "Reintentar" }).first().click();
  check("«Reintentar» devuelve la tarea a la cola", await pa.locator(".banner.ok", { hasText: "volvió a la cola" }).isVisible({ timeout: 20000 }).catch(() => false));
  await runJobs();
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  check("...y el cliente recibe su respuesta", waCalls.length === w0 + 1 && (await lastJob("agent", rConv.id)).status === "done");

  // ── Derivación: auto-asignación, resumen y escalamiento ──
  const users_ = users;
  const reset = () => q(db.from("conversations").update({ requires_human: false, handoff_reason: null, assigned_to: null, handoff_summary: null, escalated_at: null }).eq("id", rConv.id));
  await reset();
  await q(db.from("jobs").delete().eq("kind", "escalation").contains("payload", { conversationId: rConv.id }));
  await q(db.from("conversations").update({ requires_human: true, handoff_reason: "Reclamo (e2e)" }).eq("id", rConv.id));
  const assigned = await waitFor(async () => (await q(db.from("conversations").select("assigned_to").eq("id", rConv.id)))[0].assigned_to, 5000);
  check("derivación: se asigna sola al vendedor de la sucursal del cliente", assigned === users_["huanuco@optuz.local"], String(assigned));
  const esc = await lastJob("escalation", rConv.id, "pending");
  const sum = await lastJob("handoff_summary", rConv.id, "pending");
  const inMin = esc ? (new Date(esc.run_at).getTime() - Date.now()) / 60000 : -1;
  check("...y programa el resumen (ya) y el escalamiento (en ~15 min)", !!sum && !!esc && inMin > 13 && inMin < 16, `${!!sum} ${inMin}`);
  await runJobs();
  const summ = await waitFor(async () => (await q(db.from("conversations").select("handoff_summary").eq("id", rConv.id)))[0].handoff_summary, 15000);
  check("el resumen para el asesor se genera con el modelo y se guarda", !!summ && /Quiere agendar una cita/.test(summ) && summaryCalls.length >= 1, String(summ));
  await pa.goto(`${BASE}/inbox/${rConv.id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  check("chat: el banner de derivación muestra «Resumen para ti»", await pa.locator(".handoff-summary", { hasText: "Quiere agendar una cita" }).isVisible({ timeout: 10000 }).catch(() => false));
  await dueNow(esc.id);
  await runJobs();
  const escalated = await waitFor(async () => (await q(db.from("conversations").select("escalated_at").eq("id", rConv.id)))[0].escalated_at, 15000);
  check("escalamiento: pasados 15 min sin atender, la conversación queda marcada", !!escalated);
  await pa.reload();
  await pa.waitForSelector(".thread", { timeout: 30000 });
  check("...y se ve en el chat («Sin atender hace más de 15 min») y en la lista con ⏱", await pa.getByText("Sin atender hace más de 15 min").first().isVisible({ timeout: 10000 }).catch(() => false) && await pa.locator(".conv", { hasText: "Rafa" }).getByText("⏱").isVisible());

  // Si alguien la atendió antes, NO se escala
  await reset();
  await q(db.from("jobs").insert({ kind: "escalation", payload: { conversationId: rConv.id }, run_at: new Date().toISOString() }));
  await runJobs();
  check("si ya la atendieron (no está pendiente), el escalamiento no hace nada", (await q(db.from("conversations").select("escalated_at").eq("id", rConv.id)))[0].escalated_at === null);

  // Sucursal sin vendedor: queda sin asignar (la ven los administradores)
  const uchiza = (await q(db.from("branches").select("id").eq("nombre", "Uchiza")))[0].id;
  const hcoId = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  await q(db.from("leads").update({ branch_id: uchiza }).eq("id", rLead.id));
  await q(db.from("conversations").update({ requires_human: true, handoff_reason: "otra" }).eq("id", rConv.id));
  await sleep(500);
  check("una sucursal sin vendedores deja la derivación sin asignar", (await q(db.from("conversations").select("assigned_to").eq("id", rConv.id)))[0].assigned_to === null);
  await q(db.from("leads").update({ branch_id: hcoId }).eq("id", rLead.id));
  await reset();

  // ── Seguimiento: UN mensaje, dentro de la ventana, cancelable ──
  const lucia = { wa_id: "51977777777", user_id: "PE.777", name: "Lucía" };
  w0 = waCalls.length;
  await post(inbound(lucia, "wamid.luc1", "Hola, ¿qué horarios tienen?"));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  const lLead = (await q(db.from("leads").select("id").eq("bsuid", "PE.777")))[0];
  const lConv = (await q(db.from("conversations").select("id").eq("lead_id", lLead.id)))[0];
  const fu = await waitFor(() => lastJob("followup", lConv.id, "pending"), 10000);
  const fuMin = fu ? (new Date(fu.run_at).getTime() - Date.now()) / 60000 : -1;
  check("tras responder, el bot programa UN seguimiento a las ~3 h", !!fu && fuMin > 170 && fuMin < 185, String(fuMin));
  await dueNow(fu.id);
  w0 = waCalls.length;
  await runJobs();
  await waitFor(() => waCalls.length === w0 + 1, 30000);
  const fuMsg = (await q(db.from("messages").select("content, meta, sender").eq("conversation_id", lConv.id).order("created_at", { ascending: false }).limit(1)))[0];
  check("el seguimiento se envía una vez, con el texto fijo y etiquetado como «followup»", waCalls.length === w0 + 1 && /evaluación visual gratuita/.test(fuMsg.content) && fuMsg.meta?.kind === "followup" && fuMsg.sender === "bot", JSON.stringify(fuMsg));
  check("...y la conversación recuerda que ya se hizo", !!(await q(db.from("conversations").select("followup_sent_at").eq("id", lConv.id)))[0].followup_sent_at);
  await q(db.from("jobs").insert({ kind: "followup", payload: { conversationId: lConv.id }, run_at: new Date().toISOString() }));
  w0 = waCalls.length;
  await runJobs();
  await sleep(800);
  check("NUNCA se manda un segundo seguimiento", waCalls.length === w0);

  // Un mensaje nuevo del cliente cancela el seguimiento pendiente (lo hace la base)
  await q(db.from("conversations").update({ followup_sent_at: null }).eq("id", rConv.id));
  const fuPending = () => q(db.from("jobs").select("id").eq("dedupe_key", `followup:${rConv.id}`).eq("status", "pending"));
  if ((await fuPending()).length === 0) await q(db.from("jobs").insert({ kind: "followup", payload: { conversationId: rConv.id }, dedupe_key: `followup:${rConv.id}`, run_at: new Date(Date.now() + 3600_000).toISOString() }));
  check("(antes) hay un seguimiento pendiente", (await fuPending()).length === 1);
  await q(db.from("messages").insert({ conversation_id: rConv.id, direction: "in", sender: "lead", content: "gracias", wa_message_id: "wamid.canc1" }));
  check("un mensaje nuevo del cliente cancela el seguimiento pendiente", (await q(db.from("jobs").select("id").eq("dedupe_key", `followup:${rConv.id}`).eq("status", "pending"))).length === 0);

  // Fuera de la ventana de 24 h no se manda (haría falta una plantilla aprobada)
  await q(db.from("messages").insert({ conversation_id: lConv.id, direction: "out", sender: "bot", content: "Última respuesta del bot", wa_message_id: "wamid.OUT-ventana" }));
  await q(db.from("messages").update({ created_at: new Date(Date.now() - 26 * 3600_000).toISOString() }).eq("conversation_id", lConv.id).eq("direction", "in"));
  await q(db.from("conversations").update({ followup_sent_at: null }).eq("id", lConv.id));
  await q(db.from("jobs").insert({ kind: "followup", payload: { conversationId: lConv.id }, run_at: new Date().toISOString() }));
  w0 = waCalls.length;
  await runJobs();
  await sleep(800);
  check("con la ventana de 24 h cerrada NO se manda seguimiento", waCalls.length === w0);
}

// ═════ Medios (imágenes, notas de voz, documentos) y botones de WhatsApp ═════
console.log("\n── Medios y botones");
{
  const runJobs = () => fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { "x-cron-secret": "e2e-cron" } });
  const msgOf = async (wamid) => (await q(db.from("messages").select("id, content, attachments, conversation_id").eq("wa_message_id", wamid)))[0];

  // ── Imagen con pie de foto (la de Elena, enviada antes) ──
  const img = await waitFor(async () => { const m = await msgOf("wamid.img"); return m?.attachments?.[0]?.storage_path ? m : null; }, 20000);
  check("imagen: se descarga de Meta (con token), se guarda en almacenamiento privado y queda enlazada al mensaje", !!img && img.attachments[0].size === PNG.length && img.attachments[0].mime_type === "image/png" && img.content === "Mi receta" && mediaCalls.some((c) => c.step === "meta" && c.auth === `Bearer ${WA_TOKEN}`), JSON.stringify(img?.attachments));
  const dl = await db.storage.from("chat-media").download(img.attachments[0].storage_path);
  check("...el archivo guardado es idéntico al enviado por Meta", !dl.error && Buffer.from(await dl.data.arrayBuffer()).equals(PNG));
  const url = `${BASE}/api/media/${img.id}/0`;
  const ok = await adm.request.get(url);
  check("/api/media: un usuario con acceso recibe el archivo (enlace firmado)", ok.status() === 200 && (ok.headers()["content-type"] ?? "").includes("image/png"), String(ok.status()));
  check("/api/media: sin sesión → 401", (await fetch(url, { redirect: "manual" })).status === 401);
  check("/api/media: un vendedor de OTRA sucursal no lo ve (404)", (await toc.request.get(url)).status() === 404);
  await pa.goto(`${BASE}/inbox/${img.conversation_id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  check("chat: la imagen se muestra dentro de la burbuja, con su pie de foto", await pa.locator(".bubble img.chat-img").first().isVisible({ timeout: 15000 }).catch(() => false) && await pa.locator(".bubble .body", { hasText: "Mi receta" }).first().isVisible());

  // ── Nota de voz: se transcribe y el agente responde sobre lo que dijo ──
  const nora = { wa_id: "51988888888", user_id: "PE.888", name: "Nora" };
  let l0 = llmCalls.length, w0 = waCalls.length, t0 = transcribeCalls.length;
  await post(wrap({ contacts: [contactOf(nora)], messages: [waMessage(nora, "wamid.aud1", "", { type: "audio", text: undefined, audio: { id: "MEDIA-AUD-1", mime_type: "audio/ogg; codecs=opus", voice: true } })] }));
  const toNora = () => waCalls.filter((c) => (c.body.to ?? c.body.recipient) === "51988888888").length;
  await waitFor(async () => {
    await runJobs();
    return toNora() === 1;
  }, 60000);
  const aud = await msgOf("wamid.aud1");
  check("nota de voz: se transcribe con el modelo y el texto pasa a ser el mensaje", transcribeCalls.length === t0 + 1 && aud.content === "🎤 Hola, quiero agendar una cita en Huánuco" && aud.attachments[0].transcript === "Hola, quiero agendar una cita en Huánuco", JSON.stringify(aud));
  await sleep(800);
  check("...el agente espera la transcripción y responde UNA vez sobre lo que dijo", toNora() === 1 && llmCalls.slice(l0).some((c) => JSON.stringify(c.body.input).includes("quiero agendar una cita")), `respuestas a Nora: ${toNora()}; entradas: ${JSON.stringify(llmCalls.slice(l0).map((c) => c.body.input))}`);
  await pa.goto(`${BASE}/inbox/${aud.conversation_id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  check("chat: la nota de voz tiene reproductor y muestra su transcripción", await pa.locator("audio.chat-audio").first().isVisible({ timeout: 15000 }).catch(() => false) && await pa.getByText("Hola, quiero agendar una cita en Huánuco").first().isVisible());

  // ── Un medio que Meta no entrega: reintentos y aviso a una persona ──
  await post(wrap({ contacts: [contactOf(nora)], messages: [waMessage(nora, "wamid.fail1", "", { type: "image", text: undefined, image: { id: "MEDIA-FAIL-1", mime_type: "image/png" } })] }));
  // Cada intento fallido deja la tarea «pending» con un intento más: se espera ese estado antes de adelantarla.
  const mediaJob = async () => (await q(db.from("jobs").select("id, status, attempts").eq("kind", "media").contains("payload", { conversationId: aud.conversation_id }).order("created_at", { ascending: false }).limit(1)))[0];
  await driveRetries(mediaJob, 0, 2);
  await waitFor(async () => (await mediaJob())?.status === "failed", 30000);
  await waitFor(async () => (await msgOf("wamid.fail1"))?.content === "[No se pudo procesar un archivo del cliente]", 15000);
  const failed = await msgOf("wamid.fail1");
  const nc = (await q(db.from("conversations").select("requires_human, handoff_reason").eq("id", aud.conversation_id)))[0];
  check("un medio que no se puede descargar: tras 3 intentos queda anotado y una persona lo ve", failed.content === "[No se pudo procesar un archivo del cliente]" && nc.requires_human === true && /archivo/.test(nc.handoff_reason ?? ""), JSON.stringify({ failed, nc }));

  // ── Al eliminar el contacto también se borran sus archivos ──
  const noraLead = (await q(db.from("leads").select("id").eq("bsuid", "PE.888")))[0];
  const audioPath = aud.attachments[0].storage_path;
  await pa.goto(`${BASE}/leads/${noraLead.id}`);
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: /Eliminar datos/ }).click();
  const dd2 = pa.locator("dialog[open]");
  await dd2.waitFor({ timeout: 10000 });
  await dd2.locator("input[name=motivo]").fill("E2E prueba");
  await dd2.locator("input[name=confirmacion]").fill("ELIMINAR");
  await dd2.getByRole("button", { name: "Eliminar definitivamente" }).click();
  await pa.locator(".banner.ok", { hasText: "Contacto eliminado" }).waitFor({ timeout: 30000 });
  const gone = await db.storage.from("chat-media").download(audioPath);
  check("eliminar un contacto borra también sus archivos guardados (nota de voz)", !!gone.error);

  // ── Botones: el agente ofrece una lista y el cliente toca una opción ──
  const ivan = { wa_id: "51910101010", user_id: "PE.1010", name: "Iván" };
  l0 = llmCalls.length; w0 = waCalls.length;
  await post(inbound(ivan, "wamid.opc1", "Hola, opciones e2e por favor"));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  await sleep(1200);
  const opt = waCalls.at(-1)?.body;
  check("send_options: 5 sucursales → UN mensaje de WhatsApp con LISTA (no texto)", waCalls.length === w0 + 1 && opt?.type === "interactive" && opt.interactive.type === "list" && opt.interactive.action.sections[0].rows.length === 5, JSON.stringify(opt));
  check("...el texto final del modelo NO se envía además (solo la lista)", waCalls.length === w0 + 1 && llmCalls.length - l0 === 2);
  const ivanLead = (await q(db.from("leads").select("id").eq("bsuid", "PE.1010")))[0];
  const ivanConv = (await q(db.from("conversations").select("id").eq("lead_id", ivanLead.id)))[0];
  const optMsg = (await q(db.from("messages").select("content, meta, sender").eq("conversation_id", ivanConv.id).eq("direction", "out")))[0];
  check("...en el inbox se ve la pregunta con sus opciones, etiquetado como «options»", optMsg.sender === "bot" && optMsg.content.includes("¿Cuál sucursal te queda más cerca?") && optMsg.content.includes("▫ Tingo María") && optMsg.meta.kind === "options" && optMsg.meta.options.length === 5, JSON.stringify(optMsg));
  const run = (await q(db.from("agent_runs").select("outcome, detail").eq("conversation_id", ivanConv.id)))[0];
  check("...la corrida queda registrada como «respondió con botones»", run?.outcome === "reply" && run.detail === "respondió con botones", JSON.stringify(run));

  w0 = waCalls.length;
  await post(wrap({ contacts: [contactOf(ivan)], messages: [waMessage(ivan, "wamid.opc2", "", { type: "interactive", text: undefined, interactive: { type: "list_reply", list_reply: { id: "opt_2", title: "Tingo María" } } })] }));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  const tapped = await msgOf("wamid.opc2");
  check("el cliente toca «Tingo María»: llega como su mensaje y el agente responde con normalidad", tapped.content === "Tingo María" && waCalls.length === w0 + 1 && waCalls.at(-1).body.type === "text");
}

// ═════ Plantillas, recordatorios de cita, confirmación por chat, conversión a Meta y anuncios ═════
console.log("\n── Citas, plantillas y anuncios");
{
  const runJobs = () => fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { "x-cron-secret": "e2e-cron" } });
  const hco = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  const leadOf = async (bsuid) => (await q(db.from("leads").select("id").eq("bsuid", bsuid)))[0];
  const convOf = async (leadId) => (await q(db.from("conversations").select("id").eq("lead_id", leadId)))[0];
  const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const addAppt = async (leadId, h) => (await q(db.from("appointments").insert({ lead_id: leadId, branch_id: hco, scheduled_at: hoursFromNow(h), status: "agendada" }).select("id")))[0].id;
  /**
   * Crea una tarea y NO vuelve hasta que terminó de verdad. Dos motivos por los que no basta con «lanzar y esperar»:
   * el reloj de esta prueba y el de la base pueden diferir en milisegundos (la tarea no vencería aún), y una pasada
   * puede no tomarla. Si quedara pendiente, se dispararía más tarde y ensuciaría las comprobaciones siguientes.
   */
  const runJob = async (kind, payload, key) => {
    const [j] = await q(db.from("jobs").insert({ kind, payload, run_at: new Date(Date.now() - 5000).toISOString(), dedupe_key: key ?? null }).select("id"));
    const done = await waitFor(async () => {
      await runJobs();
      const row = (await q(db.from("jobs").select("status, last_error").eq("id", j.id)))[0];
      return row && (row.status === "done" || row.status === "failed") ? row : null;
    }, 30000);
    if (!done) throw new Error(`la tarea «${kind}» no llegó a ejecutarse`);
    if (done.status === "failed") console.log(`  (aviso) la tarea «${kind}» falló: ${done.last_error}`);
    return j.id;
  };

  // ── Plantillas (admin) ──
  // La prueba empieza sin plantillas (la copia de seguridad repone las reales al terminar).
  await q(db.from("message_templates").delete().neq("name", ""));
  await pa.goto(`${BASE}/plantillas`);
  await pa.waitForLoadState("networkidle");
  check("/plantillas: sin plantilla aprobada avisa que un recordatorio fuera de las 24 h no se podría enviar", await pa.locator(".banner.warn", { hasText: "Sin plantilla de recordatorio aprobada" }).isVisible());
  await pa.getByRole("button", { name: /Crear plantilla de recordatorio/ }).click();
  check("«Crear plantilla de recordatorio» la envía a Meta (utilidad, con ejemplos para las 5 variables)", await pa.locator(".banner.ok", { hasText: "enviada a Meta" }).isVisible({ timeout: 20000 }).catch(() => false) && templateCalls.length === 1 && templateCalls[0].name === "cita_recordatorio" && templateCalls[0].category === "UTILITY" && templateCalls[0].components[0].example.body_text[0].length === 5, JSON.stringify(templateCalls[0]));
  check("...y queda registrada como «En revisión»", (await q(db.from("message_templates").select("status").eq("name", "cita_recordatorio")))[0].status === "PENDING");
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: "Sincronizar con Meta" }).click();
  check("«Sincronizar con Meta» trae el nuevo estado: Aprobada", await pa.locator("tr", { hasText: "cita_recordatorio" }).getByText("Aprobada").isVisible({ timeout: 20000 }).catch(() => false) && (await q(db.from("message_templates").select("status, body").eq("name", "cita_recordatorio")))[0].status === "APPROVED");
  await pa.screenshot({ path: `${SHOTS}30-plantillas.png` });

  // ── Recordatorio dentro de la ventana de 24 h: texto normal ──
  // Esperar a que termine todo lo anterior (respuestas tardías del agente) y usar un contacto propio
  
  await idle();
  const marta = { wa_id: "51912121212", user_id: "PE.1212", name: "Marta" };
  let w00 = waCalls.length;
  await post(inbound(marta, "wamid.rem0", "Hola, recordatorio e2e"));
  await waitFor(() => waCalls.length === w00 + 1, 60000);
  await idle();
  const ivan = await leadOf("PE.1212");
  const ivanConv = await convOf(ivan.id);
  await q(db.from("leads").update({ branch_id: hco, nombre: "Marta Prueba" }).eq("id", ivan.id));
  const apptA = await addAppt(ivan.id, 30);
  let w0 = waCalls.length;
  await runJob("reminder", { appointmentId: apptA, kind: "24h" }, `reminder24h:${apptA}`);
  const r1 = waCalls.at(-1)?.body;
  const rMsg = (await q(db.from("messages").select("content, meta").eq("conversation_id", ivanConv.id).eq("direction", "out").order("created_at", { ascending: false }).limit(1)))[0];
  check("recordatorio (cliente escribió hace poco): sale como texto normal con fecha, hora, sucursal y cómo responder", waCalls.length === w0 + 1 && r1.type === "text" && /Marta/.test(r1.text.body) && /evaluación visual gratuita/.test(r1.text.body) && /Responde \*1\*/.test(r1.text.body) && /Huánuco/.test(r1.text.body), JSON.stringify(r1));
  check("...queda etiquetado como «reminder» con su cita y marcado como enviado", rMsg.meta.kind === "reminder" && rMsg.meta.appointment_id === apptA && !!(await q(db.from("appointments").select("reminder_24h_sent_at").eq("id", apptA)))[0].reminder_24h_sent_at);
  w0 = waCalls.length;
  await runJob("reminder", { appointmentId: apptA, kind: "24h" });
  check("el mismo recordatorio NUNCA se envía dos veces", waCalls.length === w0);

  // ── El cliente responde «1»: se confirma sin usar el modelo ──
  const llm0 = llmCalls.length;
  w0 = waCalls.length;
  await post(inbound(marta, "wamid.conf1", "1"));
  await waitFor(() => waCalls.length === w0 + 1, 30000);
  const aA = (await q(db.from("appointments").select("status, confirmed_at").eq("id", apptA)))[0];
  check("responde «1»: la cita queda «confirmada» (con fecha) y recibe el agradecimiento", aA.status === "confirmada" && !!aA.confirmed_at && /queda confirmada/.test(waCalls.at(-1).body.text.body));
  await sleep(1200);
  check("...sin llamar al modelo (respuesta directa)", llmCalls.length === llm0);

  // ── Cancelar con «3»: libera la cita y quita sus recordatorios pendientes ──
  const apptB = await addAppt(ivan.id, 60);
  await q(db.from("jobs").insert({ kind: "reminder", payload: { appointmentId: apptB, kind: "2h" }, run_at: hoursFromNow(58), dedupe_key: `reminder2h:${apptB}` }));
  await runJob("reminder", { appointmentId: apptB, kind: "24h" });
  w0 = waCalls.length;
  await post(inbound(marta, "wamid.canc3", "3"));
  await waitFor(() => waCalls.length === w0 + 1, 30000);
  const bB = (await q(db.from("appointments").select("status").eq("id", apptB)))[0];
  check("responde «3»: la cita queda «cancelada» y se le confirma", bB.status === "cancelada" && /cancelé tu cita/.test(waCalls.at(-1).body.text?.body ?? ""), JSON.stringify({ bB, last: waCalls.at(-1)?.body, n: waCalls.length - w0 }));
  check("...y se quitan los recordatorios pendientes de esa cita", (await q(db.from("jobs").select("id").eq("dedupe_key", `reminder2h:${apptB}`).eq("status", "pending"))).length === 0, JSON.stringify(await q(db.from("jobs").select("id, status, dedupe_key").eq("dedupe_key", `reminder2h:${apptB}`))));
  w0 = waCalls.length;
  await runJob("reminder", { appointmentId: apptB, kind: "2h" });
  check("una cita cancelada no recibe recordatorios", waCalls.length === w0);

  // ── Fuera de la ventana: plantilla aprobada ──
  await idle();
  const lucia = await leadOf("PE.777");
  const luciaConv = await convOf(lucia.id);
  await q(db.from("leads").update({ nombre: "Lucía Prueba", branch_id: hco }).eq("id", lucia.id));
  const apptC = await addAppt(lucia.id, 26);
  w0 = waCalls.length;
  await runJob("reminder", { appointmentId: apptC, kind: "24h" });
  const t1 = waCalls.at(-1)?.body;
  const tMsg = (await q(db.from("messages").select("content, meta").eq("conversation_id", luciaConv.id).eq("direction", "out").order("created_at", { ascending: false }).limit(1)))[0];
  check("recordatorio con la ventana de 24 h CERRADA: se envía la plantilla aprobada con sus 5 parámetros", waCalls.length === w0 + 1 && t1.type === "template" && t1.template.name === "cita_recordatorio" && t1.template.language.code === "es" && t1.template.components[0].parameters.length === 5 && t1.template.components[0].parameters[0].text === "Lucía" && t1.template.components[0].parameters[3].text === "Huánuco", JSON.stringify({ n: waCalls.length - w0, t1 }));
  check("...en el chat se ve el texto ya rellenado, etiquetado con la plantilla", /Hola Lucía/.test(tMsg.content) && /Huánuco/.test(tMsg.content) && tMsg.meta.template === "cita_recordatorio", JSON.stringify(tMsg));

  // ── Sin plantilla aprobada: no se puede; que una persona avise ──
  await q(db.from("message_templates").update({ status: "PENDING" }).eq("name", "cita_recordatorio"));
  const apptD = await addAppt(lucia.id, 27);
  w0 = waCalls.length;
  await runJob("reminder", { appointmentId: apptD, kind: "24h" });
  const lc = (await q(db.from("conversations").select("requires_human, handoff_reason").eq("id", luciaConv.id)))[0];
  check("fuera de ventana y SIN plantilla aprobada: no se envía nada y el chat queda «Requiere humano» con el motivo", waCalls.length === w0 && lc.requires_human === true && /plantilla/.test(lc.handoff_reason ?? ""), JSON.stringify(lc));
  await q(db.from("message_templates").update({ status: "APPROVED" }).eq("name", "cita_recordatorio"));

  // ── Conversión hacia Meta (API de Conversiones) ──
  const carla = await leadOf("PE.111");
  const apptE = await addAppt(carla.id, 72);
  await runJob("capi", { appointmentId: apptE, event: "schedule" });
  const cc = capiCalls.at(-1);
  const ev = cc?.body?.data?.[0];
  check("cita de un lead que llegó por anuncio: se informa a Meta (Schedule, mensajería de negocios, con su ctwa_clid)", capiCalls.length === 1 && ev.event_name === "Schedule" && ev.action_source === "business_messaging" && ev.messaging_channel === "whatsapp" && ev.user_data.ctwa_clid === "clid-1" && ev.user_data.whatsapp_business_account_id === "WABA-E2E" && cc.auth === `Bearer ${WA_TOKEN}`, JSON.stringify(cc));
  check("...queda marcada como enviada y no se repite", !!(await q(db.from("appointments").select("capi_sent_at").eq("id", apptE)))[0].capi_sent_at && await (async () => { await runJob("capi", { appointmentId: apptE, event: "schedule" }); return capiCalls.length === 1; })());
  const apptF = await addAppt(ivan.id, 90);
  await runJob("capi", { appointmentId: apptF, event: "schedule" });
  check("un lead que NO vino de un anuncio no genera evento hacia Meta", capiCalls.length === 1);

  // ── Página de anuncios ──
  await pa.goto(`${BASE}/anuncios`);
  await pa.waitForSelector("table", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  const adRow = pa.locator("tbody tr", { hasText: "AD-HCO-1" });
  check("/anuncios: muestra el anuncio con sus leads y las citas que produjo", await adRow.isVisible() && (await adRow.locator("td").nth(2).innerText()).trim() === "1" && (await adRow.locator("td").nth(3).innerText()).trim() === "1");
  check("/anuncios: indica que el envío a Meta está activo", await pa.getByText("Envío a Meta:").locator("xpath=..").getByText("activo").isVisible());
  await adRow.getByRole("button", { name: "Gasto" }).click();
  const sd = pa.locator("dialog[open]");
  await sd.waitFor({ timeout: 10000 });
  await sd.locator("input[name=amount]").fill("150");
  await sd.getByRole("button", { name: "Guardar" }).click();
  check("/anuncios: al anotar el gasto calcula el costo por cita", await pa.locator("tbody tr", { hasText: "AD-HCO-1" }).getByText(/150/).first().isVisible({ timeout: 20000 }).catch(() => false) && (await pa.locator("tbody tr", { hasText: "AD-HCO-1" }).innerText()).includes("S/"), await pa.locator("tbody tr", { hasText: "AD-HCO-1" }).innerText());
  await pa.screenshot({ path: `${SHOTS}31-anuncios.png` });
  await q(db.from("ad_spend").delete().eq("ad_id", "AD-HCO-1"));
}

// ═════ Etiquetas automáticas, opinión 👍/👎, conversación resuelta y unir duplicados ═════
console.log("\n── Etiquetas, opinión, resueltas y duplicados");
{
  
  const marta = { wa_id: "51912121212", user_id: "PE.1212", name: "Marta" };
  const martaLead = (await q(db.from("leads").select("id, tags").eq("bsuid", "PE.1212")))[0];
  const martaConv = (await q(db.from("conversations").select("id").eq("lead_id", martaLead.id)))[0];
  await idle();

  // ── El agente etiqueta solo (lista cerrada) ──
  let w0 = waCalls.length;
  await post(inbound(marta, "wamid.tag1", "Hola, etiquetas e2e: busco lentes de contacto"));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  await idle();
  const tagged = (await q(db.from("leads").select("tags").eq("id", martaLead.id)))[0].tags;
  check("tag_lead: el agente etiqueta lo que el cliente busca (etiqueta de la lista)", tagged.includes("quiere lentes de contacto"), JSON.stringify(tagged));
  check("...y descarta lo que no está en la lista (nada de datos de salud inventados)", !tagged.includes("diabetes") && tagged.length === martaLead.tags.length + 1, JSON.stringify(tagged));
  const toolOut = llmCalls.at(-1)?.body.input?.find((i) => i.type === "function_call_output")?.output ?? "";
  check("...la herramienta le dice al modelo que no se lo mencione al cliente", /no le menciones/.test(toolOut), toolOut);

  // ── 👍 / 👎 sobre respuestas del bot ──
  await pa.goto(`${BASE}/inbox/${martaConv.id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  const botBubble = pa.locator(".msg.out", { has: pa.locator(".bubble.bot") }).last();
  const botMsgId = (await q(db.from("messages").select("id").eq("conversation_id", martaConv.id).eq("sender", "bot").order("created_at", { ascending: false }).limit(1)))[0].id;
  check("las respuestas del bot muestran 👍/👎 (las del cliente no)", await botBubble.locator(".fb").isVisible() && (await pa.locator(".msg:not(.out) .fb").count()) === 0);
  await botBubble.getByRole("button", { name: "Buena respuesta" }).click();
  check("👍: queda guardado en el mensaje", !!(await waitFor(async () => (await q(db.from("messages").select("feedback").eq("id", botMsgId)))[0].feedback === 1, 10000)));
  pa.once("dialog", (d) => d.accept("Dijo un dato incorrecto (e2e)"));
  await botBubble.getByRole("button", { name: "Mala respuesta" }).click();
  const fb = await waitFor(async () => { const m = (await q(db.from("messages").select("feedback, feedback_note").eq("id", botMsgId)))[0]; return m.feedback === -1 ? m : null; }, 10000);
  check("👎: cambia el voto y guarda qué estuvo mal", fb?.feedback_note === "Dijo un dato incorrecto (e2e)", JSON.stringify(fb));
  check("...el botón queda marcado", await botBubble.locator('button[aria-label="Mala respuesta"][aria-pressed="true"]').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await pa.goto(`${BASE}/sistema`);
  await pa.waitForLoadState("networkidle");
  check("/sistema: lista la respuesta marcada con 👎, con el motivo y el conteo", await pa.getByText("Dijo un dato incorrecto (e2e)").isVisible() && await pa.getByText("Respuestas del bot marcadas con 👎").isVisible());
  await pa.screenshot({ path: `${SHOTS}32-sistema-feedback.png` });

  // ── La bandeja se ordena por quién espera: «Sin responder» y «Requieren persona» ──
  await q(db.from("conversations").update({ requires_human: true, handoff_reason: "Prueba de derivación (e2e)" }).eq("id", martaConv.id));
  await pa.goto(`${BASE}/inbox`);
  await pa.waitForSelector(".conv", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  check("inbox: abre filtrando por quién espera respuesta", await pa.locator(".conv-filters .chip-btn.on", { hasText: "Esperando respuesta" }).isVisible());
  await pa.getByRole("button", { name: "Requieren persona", exact: true }).click();
  check("inbox: «Requieren persona» deja las derivadas", await pa.locator(".conv", { hasText: "Marta" }).isVisible({ timeout: 10000 }).catch(() => false));
  check("inbox: cada filtro dice cuántos chats dejaría", /d/.test(await pa.locator(".conv-filters .chip-btn").first().innerText()));
  check("inbox: ya no existe «Resueltas»", (await pa.getByRole("button", { name: "Resueltas" }).count()) === 0);
  await pa.screenshot({ path: `${SHOTS}33-inbox-carpetas.png` });

  w0 = waCalls.length;
  await post(inbound(marta, "wamid.again1", "Hola de nuevo, ¿siguen atendiendo?"));
  await waitFor(() => waCalls.length === w0 + 1, 60000);
  await idle();
  await pa.goto(`${BASE}/inbox/${martaConv.id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  check("chat: el panel dice si tiene cita (el dato que se busca al abrirlo)", (await pa.locator(".cp-block", { hasText: "Citas" }).innerText()).includes("Sin cita agendada"));
  check("chat: el panel muestra el origen del contacto", await pa.locator(".cp-line", { hasText: "Origen" }).isVisible());
  check("chat: ya no muestra el conteo de mensajes ni el último mensaje (están en la lista)", !(await pa.locator(".contact-panel").innerText()).includes("Último mensaje"));

  // ── Unir contactos duplicados ──
  const hco = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  const [A] = await q(db.from("leads").insert({ nombre: "Duplicado Principal", phone: "+51900000091", tags: ["vip"], notes: "nota A" }).select("id"));
  const [B] = await q(db.from("leads").insert({ nombre: "Duplicado Secundario", phone: "+51900000092", email: "dup@example.com", branch_id: hco, tags: ["lentes"], notes: "nota B" }).select("id"));
  const [cA] = await q(db.from("conversations").insert({ lead_id: A.id }).select("id"));
  const [cB] = await q(db.from("conversations").insert({ lead_id: B.id }).select("id"));
  await q(db.from("messages").insert([
    { conversation_id: cA.id, direction: "in", sender: "lead", content: "Mensaje en la ficha A" },
    { conversation_id: cB.id, direction: "in", sender: "lead", content: "Mensaje en la ficha B 1" },
    { conversation_id: cB.id, direction: "out", sender: "humano", content: "Respuesta en la ficha B" },
  ]));
  await q(db.from("appointments").insert({ lead_id: B.id, branch_id: hco, scheduled_at: new Date(Date.now() + 5 * 86400_000).toISOString(), status: "agendada" }));

  await pa.goto(`${BASE}/leads/${A.id}`);
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: /Unir con otro contacto/ }).click();
  let md = pa.locator("dialog[open]");
  await md.waitFor({ timeout: 10000 });
  await md.locator("select[name=source_id]").selectOption({ value: B.id });
  await md.locator("input[name=confirmacion]").fill("no");
  await md.getByRole("button", { name: "Unir contactos" }).click();
  check("unir: sin escribir UNIR se rechaza con aviso y no se toca nada", await pa.locator(".banner.warn", { hasText: "escribe UNIR" }).isVisible({ timeout: 20000 }).catch(() => false) && (await q(db.from("leads").select("id").eq("id", B.id))).length === 1);

  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: /Unir con otro contacto/ }).click();
  md = pa.locator("dialog[open]");
  await md.waitFor({ timeout: 10000 });
  await md.locator("select[name=source_id]").selectOption({ value: B.id });
  await md.locator("input[name=confirmacion]").fill("UNIR");
  await md.getByRole("button", { name: "Unir contactos" }).click();
  await pa.locator(".banner.ok", { hasText: "Contactos unidos" }).waitFor({ timeout: 30000 });
  const merged = (await q(db.from("leads").select("nombre, email, branch_id, tags, notes, phone").eq("id", A.id)))[0];
  check("unir: el contacto sobrante desaparece", (await q(db.from("leads").select("id").eq("id", B.id))).length === 0 && (await q(db.from("conversations").select("id").eq("id", cB.id))).length === 0);
  check("...los datos vacíos se completan con los del otro y los propios se conservan", merged.nombre === "Duplicado Principal" && merged.email === "dup@example.com" && merged.branch_id === hco && merged.phone === "+51900000091", JSON.stringify(merged));
  check("...etiquetas unidas y notas concatenadas", merged.tags.includes("vip") && merged.tags.includes("lentes") && merged.notes.includes("nota A") && merged.notes.includes("nota B"), JSON.stringify(merged));
  const allMsgs = await q(db.from("messages").select("content").eq("conversation_id", cA.id));
  check("...los mensajes de ambos quedan en un solo chat", allMsgs.length === 3, String(allMsgs.length));
  check("...la cita pasó a la ficha que quedó", (await q(db.from("appointments").select("id").eq("lead_id", A.id))).length === 1);
  check("...y queda una nota interna con quién hizo la unión", (await q(db.from("conversation_notes").select("body").eq("conversation_id", cA.id))).some((n) => /Contacto unido/.test(n.body)));
  await pa.screenshot({ path: `${SHOTS}34-unir.png` });
}

// ═════ Pantalla de Citas: lo que ya pasó pide acción; lo cancelado no ocupa la agenda ═════
console.log("\n── Citas: pendientes de marcar");
{
  const hco = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const [lead] = await q(db.from("leads").insert({ nombre: "Cita Pasada E2E", phone: "+51900000301", branch_id: hco }).select("id"));
  const [pasada] = await q(db.from("appointments").insert({ lead_id: lead.id, branch_id: hco, scheduled_at: at(-3), status: "agendada" }).select("id"));
  const [futura] = await q(db.from("appointments").insert({ lead_id: lead.id, branch_id: hco, scheduled_at: at(30), status: "agendada" }).select("id"));
  const [canc] = await q(db.from("appointments").insert({ lead_id: lead.id, branch_id: hco, scheduled_at: at(50), status: "cancelada" }).select("id"));

  await pa.goto(`${BASE}/citas`);
  await pa.waitForLoadState("networkidle");
  const card = pa.locator(".appt.pending", { hasText: "Cita Pasada E2E" });
  check("citas: una cita que ya pasó y nadie marcó sube a «Pendientes de marcar» y pregunta si vino", await card.isVisible({ timeout: 20000 }).catch(() => false) && (await card.innerText()).includes("¿Vino?"));
  check("...con el día y la hora en palabras, no solo la hora suelta", /Hoy a las|Ayer a las|El .* a las/.test(await card.locator(".appt-when").innerText()), await card.locator(".appt-when").innerText().catch(() => ""));
  check("...la futura sigue en la agenda, sin pedir acción", await pa.locator(".appt:not(.pending)", { hasText: "Cita Pasada E2E" }).first().isVisible());
  check("...y una cita cancelada NO ocupa la agenda; se cuenta al pie", (await pa.locator(".appt", { hasText: "Cita Pasada E2E" }).count()) === 2 && await pa.locator(".cancelled-box summary").isVisible());
  await pa.screenshot({ path: `${SHOTS}35-citas-pendientes.png` });

  await card.getByRole("button", { name: "Sí, atendida" }).click();
  const marcada = await waitFor(async () => (await q(db.from("appointments").select("status").eq("id", pasada.id)))[0].status === "atendida", 20000);
  check("citas: «Sí, atendida» la marca y deja de pedir acción", !!marcada && !(await pa.locator(".appt.pending", { hasText: "Cita Pasada E2E" }).isVisible({ timeout: 10000 }).catch(() => false)));

  // El resumen cuenta lo mismo que la pantalla de citas
  const [otra] = await q(db.from("appointments").insert({ lead_id: lead.id, branch_id: hco, scheduled_at: at(-5), status: "confirmada" }).select("id"));
  await pa.goto(`${BASE}/dashboard`);
  await pa.waitForLoadState("networkidle");
  // El resumen abre con lo que pide una decisión hoy, no con nueve cifras iguales.
  const pend = pa.locator(".todo", { hasText: "cita por marcar" });
  check("resumen: lo pendiente encabeza la pantalla, con su número y enlace a Citas", await pend.isVisible({ timeout: 20000 }).catch(() => false) && (await pend.innerText()).includes("1") && (await pend.getAttribute("href")) === "/citas", await pa.locator(".todo-row, .all-clear").first().innerText().catch(() => "(nada)"));

  for (const id of [pasada.id, futura.id, canc.id, otra.id]) await q(db.from("appointments").delete().eq("id", id));
  await q(db.from("leads").delete().eq("id", lead.id));
}

// ═════ Asesor que atiende todas las sucursales (canal de citas: 1 o 2 personas) ═════
console.log("\n── Asesor de todas las sucursales");
{
  const uch = (await q(db.from("branches").select("id").eq("nombre", "Uchiza")))[0].id;
  const hco = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  const mk = async (nombre, phone, branch_id) => {
    const [l] = await q(db.from("leads").insert({ nombre, phone, branch_id }).select("id"));
    const [c] = await q(db.from("conversations").insert({ lead_id: l.id }).select("id"));
    await q(db.from("messages").insert({ conversation_id: c.id, direction: "in", sender: "lead", content: `Hola desde ${nombre}` }));
    return { lead: l.id, conv: c.id };
  };
  const uUch = await mk("Lead Uchiza E2E", "+51900000201", uch);
  const uHco = await mk("Lead Huánuco E2E", "+51900000202", hco);
  const uNone = await mk("Lead Sin Sucursal E2E", "+51900000203", null);
  const assignedOf = async (convId) => (await q(db.from("conversations").select("assigned_to").eq("id", convId)))[0].assigned_to;
  const flag = (convId) => q(db.from("conversations").update({ requires_human: true, handoff_reason: "e2e asesor global" }).eq("id", convId));

  // Antes de existir: Uchiza y sin sucursal quedan sin asignar
  await flag(uUch.conv);
  await sleep(400);
  check("sin asesores que cubran Uchiza: la derivación queda sin asignar", (await assignedOf(uUch.conv)) === null);
  await q(db.from("conversations").update({ requires_human: false, handoff_reason: null }).eq("id", uUch.conv));

  const { data: created, error: cErr } = await db.auth.admin.createUser({ email: "asesor-todas@optuz.local", password: "clave-todas-123", email_confirm: true });
  if (cErr) throw cErr;
  await q(db.from("users").insert({ id: created.user.id, nombre: "Asesor Todas", email: "asesor-todas@optuz.local", role: "vendedor", branch_id: null }));

  // Asignación: el de la sucursal tiene prioridad; si no hay, el que atiende todas
  await flag(uUch.conv);
  await flag(uNone.conv);
  await flag(uHco.conv);
  await sleep(500);
  const huaId = (await q(db.from("users").select("id").eq("email", "huanuco@optuz.local")))[0].id;
  check("derivación en Uchiza (sin asesor propio): se asigna al asesor que atiende todas", (await assignedOf(uUch.conv)) === created.user.id);
  check("derivación de un cliente sin sucursal detectada: también a quien atiende todas", (await assignedOf(uNone.conv)) === created.user.id);
  check("derivación en Huánuco: el asesor de esa sucursal tiene prioridad sobre el que atiende todas", (await assignedOf(uHco.conv)) === huaId);

  // Entra y ve todo
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/login`);
  await pg.fill("input[name=email]", "asesor-todas@optuz.local");
  await pg.fill("input[name=password]", "clave-todas-123");
  await pg.click("button[type=submit]");
  await pg.waitForURL("**/inbox", { timeout: 60000 });
  await pg.waitForSelector(".conv", { timeout: 30000 });
  await pg.waitForLoadState("networkidle");
  await pg.getByRole("button", { name: "Todas", exact: true }).click();
  const list = await pg.locator(".conv").allInnerTexts();
  check("asesor de todas: en el inbox ve los chats de varias sucursales a la vez", list.some((t) => t.includes("Lead Uchiza E2E")) && list.some((t) => t.includes("Lead Huánuco E2E")) && list.some((t) => t.includes("Lead Sin Sucursal E2E")));
  check("...su cabecera lo identifica como Asesor", await pg.getByText("Asesor", { exact: true }).first().isVisible());
  const chat = await ctx.request.get(`${BASE}/inbox/${uUch.conv}`);
  check("...abre el chat de cualquier sucursal", chat.status() === 200, String(chat.status()));
  await pg.goto(`${BASE}/leads`);
  await pg.waitForLoadState("networkidle");
  check("/leads: ve los contactos de todas las sucursales y puede crear uno en cualquiera", (await pg.locator("tbody tr", { hasText: "Lead Uchiza E2E" }).count()) === 1 && (await pg.locator("select[name=branch_id] option").count()) >= 6);
  await pg.goto(`${BASE}/citas`);
  await pg.waitForLoadState("networkidle");
  check("/citas: carga sin error", !(await pg.getByText(/Application error|Unhandled/i).count()));
  await pg.goto(`${BASE}/equipo`);
  check("...pero no entra a Equipo (solo administradores)", pg.url().includes("/inbox"), pg.url());
  await pg.goto(`${BASE}/sistema`);
  check("...ni a Sistema", pg.url().includes("/inbox"), pg.url());
  // Puede escribir por API en una conversación de otra sucursal (antes solo su sucursal)
  const send = await ctx.request.post(`${BASE}/api/inbox/conversations/${uUch.conv}/messages`, { data: { text: "Hola, te escribe el asesor (e2e)" } });
  check("...y puede escribirle a un cliente de cualquier sucursal (tomando el control)", send.status() === 200 || send.status() === 201, String(send.status()));
  // El asesor de Huánuco sigue sin ver otras sucursales
  const otro = await browser.newContext();
  const po = await otro.newPage();
  await po.goto(`${BASE}/login`);
  await po.fill("input[name=email]", "huanuco@optuz.local");
  await po.fill("input[name=password]", PASSWORD);
  await po.click("button[type=submit]");
  await po.waitForURL("**/inbox", { timeout: 60000 });
  const own = await otro.request.get(`${BASE}/inbox/${uUch.conv}`);
  check("un asesor limitado a Huánuco sigue sin ver el chat de Uchiza", own.status() === 404, String(own.status()));
  await otro.close();
  await ctx.close();

  // Limpieza: primero lo que referencia al asesor (mensajes con su autoría), después el usuario
  for (const x of [uUch, uHco, uNone]) {
    await q(db.from("jobs").delete().contains("payload", { conversationId: x.conv }));
    await q(db.from("leads").delete().eq("id", x.lead));
  }
  const del = await db.auth.admin.deleteUser(created.user.id);
  check("(limpieza) el asesor de prueba se elimina sin dejar rastro", !del.error && (await q(db.from("users").select("id").eq("id", created.user.id))).length === 0, del.error?.message);
}

// ═════ Interruptor del agente, «Nuevo» que se llena, archivar, «Últimas 24 h» y origen ═════
console.log("\n── Interruptor del agente y tablero");
{
  const runJobs = () => fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { "x-cron-secret": "e2e-cron" } });
  const tomas = { wa_id: "51913131313", user_id: "PE.1313", name: "Tomás" };
  const toTomas = () => waCalls.filter((c) => (c.body.to ?? c.body.recipient) === "51913131313").length;
  await idle();

  // Apagar desde Agente IA
  await pa.goto(`${BASE}/agente`);
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: "Apagar agente" }).click();
  const offDlg = pa.locator("dialog[open]");
  await offDlg.waitFor({ timeout: 10000 });
  await offDlg.locator("input[name=reason]").fill("Prueba e2e del interruptor");
  await offDlg.getByRole("button", { name: "Apagar el agente" }).click();
  const off = await waitFor(async () => { const s = (await q(db.from("app_settings").select("agent_enabled, agent_pause_reason, agent_paused_by").eq("id", 1)))[0]; return s.agent_enabled === false ? s : null; }, 15000);
  check("interruptor: apagar el agente desde Agente IA queda guardado, con motivo y quién", !!off && off.agent_pause_reason === "Prueba e2e del interruptor" && !!off.agent_paused_by, JSON.stringify(off));
  await pa.goto(`${BASE}/inbox`);
  await pa.waitForLoadState("networkidle");
  check("...y todo el panel avisa de que está apagado, con el motivo", await pa.locator(".agent-off", { hasText: "Prueba e2e del interruptor" }).isVisible());

  // Un cliente nuevo escribe con el agente apagado
  await post(inbound(tomas, "wamid.off1", "Hola, quiero información"));
  const tLead = await waitFor(async () => (await q(db.from("leads").select("id, stage").eq("bsuid", "PE.1313")))[0], 15000);
  await sleep(2500);
  await runJobs();
  await sleep(1500);
  const tConv = (await q(db.from("conversations").select("id").eq("lead_id", tLead.id)))[0];
  const tMsgs = await q(db.from("messages").select("direction").eq("conversation_id", tConv.id));
  check("agente apagado: el mensaje llega al inbox pero NO se responde", tMsgs.length === 1 && tMsgs[0].direction === "in" && toTomas() === 0, JSON.stringify({ tMsgs, env: toTomas() }));
  check("...ni se encola una respuesta que pudiera salir después", (await q(db.from("jobs").select("id").eq("kind", "agent").contains("payload", { conversationId: tConv.id }))).length === 0);
  check("agente apagado: el cliente sin responder se queda en «Nuevo» (la cola por atender)", (await q(db.from("leads").select("stage").eq("id", tLead.id)))[0].stage === "nuevo");
  await pa.goto(`${BASE}/pipeline`);
  await pa.waitForSelector(".board", { timeout: 30000 });
  check("...y en el tablero se ve en la columna «Nuevo»", await pa.locator(".column[data-status='nuevo'] .lead-card", { hasText: "Tomás" }).isVisible({ timeout: 10000 }).catch(() => false));

  // Tampoco salen recordatorios de cita
  const hcoT = (await q(db.from("branches").select("id").eq("nombre", "Huánuco")))[0].id;
  const [tAppt] = await q(db.from("appointments").insert({ lead_id: tLead.id, branch_id: hcoT, scheduled_at: new Date(Date.now() + 30 * 3600_000).toISOString(), status: "agendada" }).select("id"));
  const w0 = waCalls.length;
  await q(db.from("jobs").insert({ kind: "reminder", payload: { appointmentId: tAppt.id, kind: "24h" }, run_at: new Date(Date.now() - 5000).toISOString() }));
  await waitFor(async () => { await runJobs(); return (await q(db.from("jobs").select("status").eq("kind", "reminder").contains("payload", { appointmentId: tAppt.id })))[0]?.status === "done"; }, 20000);
  check("agente apagado: tampoco sale el recordatorio de cita", waCalls.length === w0 && !(await q(db.from("appointments").select("reminder_24h_sent_at").eq("id", tAppt.id)))[0].reminder_24h_sent_at);
  await q(db.from("appointments").delete().eq("id", tAppt.id));
  await q(db.from("leads").update({ stage: "nuevo" }).eq("id", tLead.id));

  // Encender
  await pa.goto(`${BASE}/agente`);
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: "Encender agente" }).click();
  check("interruptor: encender lo deja activo y sin motivo", !!(await waitFor(async () => { const s = (await q(db.from("app_settings").select("agent_enabled, agent_pause_reason").eq("id", 1)))[0]; return s.agent_enabled && !s.agent_pause_reason; }, 15000)));
  await pa.goto(`${BASE}/inbox`);
  await pa.waitForLoadState("networkidle");
  check("...y el aviso desaparece del panel", (await pa.locator(".agent-off").count()) === 0);
  await post(inbound(tomas, "wamid.on1", "¿Me ayudan?"));
  await waitFor(() => toTomas() === 1, 60000);
  check("encendido: el bot vuelve a responder", toTomas() === 1);
  check("...y con esa primera respuesta sale de «Nuevo» a «En seguimiento»", !!(await waitFor(async () => (await q(db.from("leads").select("stage").eq("id", tLead.id)))[0].stage === "seguimiento", 10000)));
  await idle();

  // Archivar desde el tablero y volver al escribir
  await pa.goto(`${BASE}/pipeline`);
  await pa.waitForSelector(".board", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  await pa.locator(".lead-card", { hasText: "Tomás" }).getByRole("button", { name: /Archivar/ }).click();
  await pa.locator(".archive-card").getByRole("button", { name: "No le interesa" }).click();
  const arch = await waitFor(async () => { const l = (await q(db.from("leads").select("archived_at, archive_reason").eq("id", tLead.id)))[0]; return l.archived_at ? l : null; }, 10000);
  check("archivar desde la tarjeta: sale del tablero con su motivo", arch?.archive_reason === "no_interesa" && (await pa.locator(".lead-card", { hasText: "Tomás" }).count()) === 0, JSON.stringify(arch));
  await post(inbound(tomas, "wamid.back1", "Hola de nuevo"));
  check("...y vuelve al tablero en cuanto escribe otra vez", !!(await waitFor(async () => !(await q(db.from("leads").select("archived_at").eq("id", tLead.id)))[0].archived_at, 15000)));
  await idle();
  await q(db.from("leads").update({ archived_at: new Date().toISOString(), archive_reason: "no_es_cliente" }).eq("id", tLead.id));
  await post(inbound(tomas, "wamid.back2", "Otra vez yo"));
  await sleep(2500);
  check("archivado como «no es un cliente»: NO vuelve aunque escriba", !!(await q(db.from("leads").select("archived_at").eq("id", tLead.id)))[0].archived_at);
  await idle();

  // Filtro «Últimas 24 h» del inbox
  await q(db.from("conversations").update({ last_message_at: new Date(Date.now() - 48 * 3600_000).toISOString() }).eq("id", tConv.id));
  await pa.goto(`${BASE}/inbox`);
  await pa.waitForSelector(".conv", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  await pa.getByRole("button", { name: "Últimas 24 h" }).click();
  check("inbox «Últimas 24 h»: muestra lo reciente y oculta lo que tiene más de un día", (await pa.locator(".conv", { hasText: "Tomás" }).count()) === 0 && (await pa.locator(".conv").count()) > 0);
  await pa.getByRole("button", { name: "Todas", exact: true }).click();

  // Origen: se corrige a mano desde la ficha
  await pa.goto(`${BASE}/leads/${tLead.id}`);
  await pa.waitForLoadState("networkidle");
  await pa.locator("select[name=origin]").selectOption("cliente_antiguo");
  await pa.getByRole("button", { name: "Guardar" }).click();
  check("origen: se anota a mano en la ficha (cliente antiguo)", !!(await waitFor(async () => (await q(db.from("leads").select("origin").eq("id", tLead.id)))[0].origin === "cliente_antiguo", 15000)));
  await pa.goto(`${BASE}/anuncios`);
  await pa.waitForLoadState("networkidle");
  check("/anuncios «De dónde vienen»: cuenta a los clientes por origen, no solo por anuncio", await pa.getByText("De dónde vienen").isVisible() && await pa.getByText("Cliente antiguo").first().isVisible());
  await pa.screenshot({ path: `${SHOTS}36-origen.png` });
}

// ═════ Escribir con el bot activo = tomar el control ═════
console.log("\n── Tomar el control");
{
  const elenaLead = (await q(db.from("leads").select("id").eq("bsuid", "PE.222")))[0];
  const elenaConv = (await q(db.from("conversations").select("id, bot_active").eq("lead_id", elenaLead.id)))[0];
  await q(db.from("conversations").update({ bot_active: true }).eq("id", elenaConv.id));
  await pa.goto(`${BASE}/inbox/${elenaConv.id}`);
  await pa.waitForSelector(".thread", { timeout: 30000 });
  await pa.waitForLoadState("networkidle");
  const box = pa.locator(".composer textarea");
  check("bot activo: se puede escribir y el botón de enviar se activa", !(await box.isDisabled()) && await (async () => { await box.fill("prueba"); const ok = await pa.getByRole("button", { name: "Enviar" }).isEnabled(); await box.fill(""); return ok; })());

  // Si el envío falla (ventana de 24 h), el bot NO queda pausado: nadie contestó
  const w0 = waCalls.length, r0 = waRejected.length;
  graphFail = { code: 131047, message: "Re-engagement message" };
  await box.fill("Mensaje fuera de ventana con el bot activo");
  await pa.getByRole("button", { name: "Enviar" }).click();
  check("bot activo + ventana de 24 h cerrada: avisa del error", await pa.getByText(/24 horas/).isVisible({ timeout: 15000 }).catch(() => false));
  await sleep(500);
  check("...y el bot sigue activo (no se pausa si el mensaje no salió)", (await q(db.from("conversations").select("bot_active").eq("id", elenaConv.id)))[0].bot_active === true && waCalls.length === w0 && waRejected.length === r0 + 1);
  check("...y no se guardó el mensaje rechazado", (await q(db.from("messages").select("id").eq("content", "Mensaje fuera de ventana con el bot activo"))).length === 0);

  // Envío correcto: pausa el bot y sale por WhatsApp
  await box.fill("Hola, te escribe una persona del equipo");
  await pa.getByRole("button", { name: "Enviar" }).click();
  const paused = await waitFor(async () => (await q(db.from("conversations").select("bot_active, assigned_to").eq("id", elenaConv.id)))[0].bot_active === false, 15000);
  check("bot activo + enviar: el bot queda pausado automáticamente", !!paused);
  // El servidor pausa el bot ANTES de enviar y guarda el mensaje y la asignación después: se espera a que terminen.
  const humanMsg = await waitFor(async () => (await q(db.from("messages").select("sender, author_id, wa_message_id").eq("content", "Hola, te escribe una persona del equipo")))[0], 15000);
  await waitFor(async () => (await q(db.from("conversations").select("assigned_to").eq("id", elenaConv.id)))[0].assigned_to === users["admin@optuz.local"], 15000);
  check("...el mensaje sale por WhatsApp como «humano» con su autor", waCalls.length === w0 + 1 && humanMsg?.sender === "humano" && humanMsg.author_id === users["admin@optuz.local"] && !!humanMsg.wa_message_id, JSON.stringify(humanMsg));
  check("...y quien escribió queda como responsable de la conversación", (await q(db.from("conversations").select("assigned_to").eq("id", elenaConv.id)))[0].assigned_to === users["admin@optuz.local"]);
  check("...la pantalla pasa a «Bot pausado» con la opción de reactivarlo y desaparece el aviso", await pa.locator(".bot-state", { hasText: "Bot pausado" }).isVisible({ timeout: 10000 }).catch(() => false) && !(await pa.locator(".takeover-hint").isVisible()));

  // Con el bot pausado por la persona, un mensaje del cliente ya no lo contesta el bot
  const llm0 = llmCalls.length;
  await post(inbound({ wa_id: "51922222222", user_id: "PE.222", name: "Elena" }, "wamid.tras-toma", "¿Me pueden confirmar?"));
  await sleep(3500);
  check("tras tomar el control, el bot NO responde al cliente", llmCalls.length === llm0);
}

// ═════ Conversación larga: el scroll es del chat, no de la página ═════
console.log("\n── Conversación larga");
{
  const total0 = (await q(db.from("messages").select("id").eq("conversation_id", conv.id))).length;
  const t0 = Date.now() - 400 * 60_000;
  const rows = Array.from({ length: 250 }, (_, i) => ({
    conversation_id: conv.id, direction: "in", sender: "lead", content: `Relleno ${i + 1}: mensaje de prueba para una conversación larga`,
    created_at: new Date(t0 + i * 60_000).toISOString(),
  }));
  await q(db.from("messages").insert(rows));
  const total = total0 + 250;
  const newest = (await q(db.from("messages").select("content").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(1)))[0].content;

  await p.goto(`${BASE}/inbox/${conv.id}`);
  await p.waitForSelector(".thread", { timeout: 30000 });
  await p.waitForLoadState("networkidle");
  await sleep(600);
  const geo = () => p.evaluate(() => {
    const m = document.querySelector(".messages");
    const c = document.querySelector(".content");
    const comp = document.querySelector(".composer")?.getBoundingClientRect();
    return { docH: document.documentElement.scrollHeight, winH: innerHeight, contentScroll: c.scrollHeight - c.clientHeight, msgScroll: m.scrollHeight - m.clientHeight, msgTop: m.scrollTop, msgClient: m.clientHeight, composerBottom: comp?.bottom ?? -1, lastText: [...document.querySelectorAll(".bubble .body")].at(-1)?.textContent ?? "" };
  });
  let g = await geo();
  check("chat largo: la página NO se alarga (el scroll no es de toda la pantalla)", g.docH <= g.winH + 1 && g.contentScroll <= 1, JSON.stringify(g));
  check("chat largo: los mensajes tienen su propio scroll", g.msgScroll > 200, JSON.stringify(g));
  check("chat largo: el cuadro de mensaje sigue a la vista (no se va abajo)", g.composerBottom > 0 && g.composerBottom <= g.winH + 1, JSON.stringify(g));
  check("chat largo: abre en lo más reciente (al final)", g.msgTop + g.msgClient >= g.msgScroll + g.msgClient - 4 && g.lastText === newest, `${g.lastText} | ${newest}`);
  check("chat largo: carga los 100 mensajes MÁS RECIENTES (no los más antiguos)", (await p.locator(".bubble").count()) === 100 && !(await p.locator(".bubble .body", { hasText: "Relleno 1:" }).count()));
  check("chat largo: ofrece «Ver mensajes anteriores»", await p.getByRole("button", { name: "Ver mensajes anteriores" }).isVisible());

  await p.getByRole("button", { name: "Ver mensajes anteriores" }).click();
  await p.waitForFunction(() => document.querySelectorAll(".bubble").length >= 200, null, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  g = await geo();
  check("chat largo: «Ver anteriores» suma otros 100 sin saltar al final", (await p.locator(".bubble").count()) === 200 && g.msgTop > 0 && g.msgTop + g.msgClient < g.msgScroll + g.msgClient - 40, JSON.stringify(g));
  check("chat largo: tras cargar más, la página sigue sin alargarse y el cuadro de mensaje sigue visible", g.docH <= g.winH + 1 && g.contentScroll <= 1 && g.composerBottom > 0 && g.composerBottom <= g.winH + 1, JSON.stringify(g));

  for (let i = 0; i < 3 && (await p.getByRole("button", { name: "Ver mensajes anteriores" }).count()); i++) {
    await p.getByRole("button", { name: "Ver mensajes anteriores" }).click();
    await sleep(900);
  }
  check("chat largo: al cargar todo desaparece el botón y están los ${total} mensajes".replace("${total}", String(total)), (await p.getByRole("button", { name: "Ver mensajes anteriores" }).count()) === 0 && (await p.locator(".bubble").count()) === total, String(await p.locator(".bubble").count()));

  // Un mensaje nuevo en vivo sí baja al final
  await p.locator(".messages").evaluate((el) => (el.scrollTop = 0));
  await q(db.from("messages").insert({ conversation_id: conv.id, direction: "in", sender: "lead", content: "Ultimo en vivo", wa_message_id: "wamid.largo-vivo" }));
  await p.getByText("Ultimo en vivo").waitFor({ timeout: 15000 });
  await sleep(300);
  g = await geo();
  check("chat largo: un mensaje nuevo en vivo lleva la vista al final y el cuadro de mensaje sigue visible", g.msgTop + g.msgClient >= g.msgScroll + g.msgClient - 4 && g.composerBottom <= g.winH + 1, JSON.stringify(g));
  await p.screenshot({ path: `${SHOTS}26-chat-largo.png` });
}

// Limpieza: la base local queda como estaba antes de la prueba (sin conversaciones ni promociones de mentira,
// sin la sucursal de prueba y con el calendario y las campañas originales de cada sucursal).
for (const t of ["messages", "conversation_notes", "appointments", "conversations", "leads", "promotions", "webhook_events", "jobs"]) {
  await q(db.from(t).delete().not(t === "webhook_events" ? "event_id" : "id", "is", null));
}
await q(db.from("quick_replies").delete().eq("atajo", "e2e-saludo"));
await q(db.from("deletion_log").delete().eq("motivo", "E2E prueba"));
await q(db.from("knowledge_base").delete().eq("titulo", "Formas de pago E2E"));
await q(db.from("branches").delete().eq("id", newBranch.id));
for (const b of branchesBefore) {
  await q(db.from("branches").update({ nombre: b.nombre, direccion: b.direccion, google_calendar_id: b.google_calendar_id, meta_campaign_ids: b.meta_campaign_ids, activa: b.activa }).eq("id", b.id));
}

await browser.close();
mock.close();
try { execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" }); } catch { /* ya cerrado */ }
console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
