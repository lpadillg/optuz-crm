// Configuración de la WhatsApp Cloud API de Meta (Graph API). Lee las variables de .env.local.
//
//   npm run whatsapp -- token                       genera un WHATSAPP_VERIFY_TOKEN aleatorio
//   npm run whatsapp -- app                         valida META_APP_ID/SECRET; muestra si falta la política de privacidad y el webhook registrado
//   npm run whatsapp -- token-info                  ¿el WHATSAPP_ACCESS_TOKEN es permanente o vence? ¿tiene los permisos necesarios?
//   npm run whatsapp -- numbers                     lista los números del WABA → copia el id a WHATSAPP_PHONE_NUMBER_ID
//   npm run whatsapp -- status                      estado del número (calidad, modo, verificación); prueba que el token sirve
//   npm run whatsapp -- subscribe                   suscribe tu app a los eventos del WABA (obligatorio para recibir mensajes)
//   npm run whatsapp -- webhook --url <https://…/api/webhooks/whatsapp>
//                                                   registra la URL del webhook en tu app (Meta la verifica al instante)
//   npm run whatsapp -- send --to 51999888777 [--text "Hola"]
//                                                   mensaje de prueba. Sin --text envía la plantilla `hello_world` (abre la ventana de 24 h)
//
// Variables: META_APP_ID, META_APP_SECRET, WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_VERIFY_TOKEN, y opcionalmente META_GRAPH_VERSION (v25.0) y META_GRAPH_BASE_URL.
import { randomBytes } from "node:crypto";

const BASE = (process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com").replace(/\/$/, "");
const VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const e = process.env;

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((acc, a, i) => (a.startsWith("--") ? [...acc, [a.slice(2), rest[i + 1]]] : acc), []));

// Se lanza (no process.exit) para que Node cierre limpio: en Windows, salir con una petición en vuelo imprime un "Assertion failed".
class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};
const need = (...names) => {
  const missing = names.filter((n) => !e[n]);
  if (missing.length) fail(`Faltan en .env.local: ${missing.join(", ")} (guía: README → "Conectar WhatsApp (API de Meta)")`);
};

/** Llamada a la Graph API. Los errores de Meta traen { error: { message, code, error_subcode, fbtrace_id } }. */
async function graph(method, path, { token = e.WHATSAPP_ACCESS_TOKEN, query = {}, json, form } = {}) {
  const qs = new URLSearchParams(query);
  const res = await fetch(`${BASE}/${VERSION}${path}${qs.size ? `?${qs}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const er = data.error ?? {};
    const hint = er.code === 190 ? "\n→ El token venció o es inválido. Crea uno permanente con un usuario del sistema (README)." : "";
    fail(`${method} ${path} → ${res.status}\n#${er.code ?? "?"} ${er.message ?? JSON.stringify(data)}${hint}`);
  }
  return data;
}

async function main() {
  switch (command) {
    case "token":
      console.log(randomBytes(24).toString("hex"));
      console.log("\nPégalo como WHATSAPP_VERIFY_TOKEN en .env.local (y en Vercel). Es el mismo que se registra en el webhook.");
      break;

    case "app": {
      need("META_APP_ID", "META_APP_SECRET");
      const appToken = `${e.META_APP_ID}|${e.META_APP_SECRET}`;
      let info;
      try {
        info = await graph("GET", `/${e.META_APP_ID}`, { token: appToken, query: { fields: "name,category,link,privacy_policy_url" } });
      } catch (err) {
        // Un campo que Meta no acepte para esta app no debe impedir validar las credenciales.
        if (!(err instanceof Fail) || !/#100/.test(err.message)) throw err;
        info = await graph("GET", `/${e.META_APP_ID}`, { token: appToken, query: { fields: "name" } });
      }
      console.log(`App: ${info.name ?? "?"} (${info.id ?? e.META_APP_ID})${info.category ? ` · categoría: ${info.category}` : ""}`);
      console.log(
        info.privacy_policy_url
          ? `Política de privacidad: ${info.privacy_policy_url}`
          : "⚠ Sin URL de política de privacidad (Configuración → Básica). Meta la exige para publicar la app (modo Live).",
      );
      const subs = await graph("GET", `/${e.META_APP_ID}/subscriptions`, { token: appToken });
      const wa = (subs.data ?? []).find((s) => s.object === "whatsapp_business_account");
      console.log(
        wa
          ? `Webhook de WhatsApp: ${wa.callback_url} · activo: ${wa.active} · campos: ${(wa.fields ?? []).map((f) => f.name).join(", ") || "(ninguno)"}`
          : "Webhook de WhatsApp: aún no registrado (README, paso 7).",
      );
      break;
    }

    case "token-info": {
      need("META_APP_ID", "META_APP_SECRET", "WHATSAPP_ACCESS_TOKEN");
      // debug_token lo consulta la propia app con su token de app; no revela el token, solo sus propiedades.
      const r = await graph("GET", "/debug_token", { token: `${e.META_APP_ID}|${e.META_APP_SECRET}`, query: { input_token: e.WHATSAPP_ACCESS_TOKEN } });
      const d = r.data ?? {};
      const never = !d.expires_at;
      console.log(`Válido: ${d.is_valid} · tipo: ${d.type ?? "?"} · app: ${d.application ?? d.app_id ?? "?"}`);
      console.log(never ? "Vencimiento: NUNCA (token permanente) ✓" : `Vencimiento: ${new Date(d.expires_at * 1000).toLocaleString("es-PE")} ⚠ temporal: el bot dejará de enviar al vencer`);
      console.log(`Permisos: ${(d.scopes ?? []).join(", ") || "(ninguno)"}`);
      const missing = ["whatsapp_business_messaging", "whatsapp_business_management"].filter((s) => !(d.scopes ?? []).includes(s));
      if (missing.length) console.log(`⚠ Faltan permisos: ${missing.join(", ")}`);
      break;
    }

    case "numbers": {
      need("WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_ACCESS_TOKEN");
      const r = await graph("GET", `/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers`, {
        query: { fields: "id,display_phone_number,verified_name,quality_rating" },
      });
      if (!r.data?.length) fail("Ese WABA no tiene números. Agrega uno en Meta → WhatsApp → Configuración de la API.");
      for (const n of r.data) console.log(`${n.id}  ${n.display_phone_number}  ${n.verified_name ?? ""}  calidad: ${n.quality_rating ?? "?"}`);
      console.log("\nCopia el id del número al que escribirán tus clientes a WHATSAPP_PHONE_NUMBER_ID en .env.local.");
      break;
    }

    case "status": {
      need("WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN");
      let r;
      try {
        r = await graph("GET", `/${e.WHATSAPP_PHONE_NUMBER_ID}`, {
          query: { fields: "display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,account_mode,throughput" },
        });
      } catch (err) {
        // Si Meta no acepta algún campo opcional, se reintenta con los básicos: lo importante es validar token y id.
        if (!(err instanceof Fail) || !/#100/.test(err.message)) throw err;
        r = await graph("GET", `/${e.WHATSAPP_PHONE_NUMBER_ID}`, { query: { fields: "display_phone_number,verified_name,quality_rating" } });
      }
      console.log(JSON.stringify(r, null, 2));
      if (r.quality_rating && r.quality_rating !== "GREEN") console.log(`\n⚠ Calidad ${r.quality_rating}: revisa bloqueos y reportes en WhatsApp Manager antes de subir el volumen.`);
      break;
    }

    case "subscribe": {
      need("WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_ACCESS_TOKEN");
      const r = await graph("POST", `/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`);
      console.log(JSON.stringify(r));
      const list = await graph("GET", `/${e.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`);
      console.log("Apps suscritas a este WABA:");
      for (const a of list.data ?? []) console.log(`  ${a.whatsapp_business_api_data?.id ?? a.id}  ${a.whatsapp_business_api_data?.name ?? a.name ?? ""}`);
      break;
    }

    case "webhook": {
      need("META_APP_ID", "META_APP_SECRET", "WHATSAPP_VERIFY_TOKEN");
      if (!args.url || !/^https:\/\//.test(args.url)) fail("Indica --url con la dirección pública HTTPS, p. ej. https://TU-DOMINIO/api/webhooks/whatsapp");
      // Este paso lo hace el "token de app" (APP_ID|APP_SECRET), no el token del usuario del sistema.
      // Meta llama a la URL (GET con hub.challenge) al momento: la app debe estar desplegada y con WHATSAPP_VERIFY_TOKEN.
      const r = await graph("POST", `/${e.META_APP_ID}/subscriptions`, {
        token: `${e.META_APP_ID}|${e.META_APP_SECRET}`,
        form: { object: "whatsapp_business_account", callback_url: args.url, verify_token: e.WHATSAPP_VERIFY_TOKEN, fields: "messages" },
      });
      console.log(JSON.stringify(r));
      console.log("\nWebhook registrado. Falta que la app esté suscrita al WABA: npm run whatsapp -- subscribe");
      break;
    }

    case "send": {
      need("WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN");
      if (!args.to) fail("Indica --to con el número de destino en formato internacional, p. ej. --to 51999888777");
      const to = args.to.replace(/\D/g, "");
      const message = args.text
        ? { type: "text", text: { body: args.text, preview_url: false } }
        : { type: "template", template: { name: "hello_world", language: { code: "en_US" } } };
      const r = await graph("POST", `/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        json: { messaging_product: "whatsapp", recipient_type: "individual", to, ...message },
      });
      console.log(JSON.stringify(r, null, 2));
      if (args.text) console.log("\nEl texto libre solo llega si el destinatario te escribió en las últimas 24 h.");
      break;
    }

    default:
      console.log(
        [
          "Uso: npm run whatsapp -- <comando>",
          "  token | app | token-info | numbers | status | subscribe | webhook --url https://… | send --to 51999888777 [--text …]",
          "Ver la cabecera de scripts/whatsapp-setup.mjs para el orden recomendado.",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Fail ? err.message : err);
  process.exitCode = 1;
});
