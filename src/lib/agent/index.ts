import "server-only";
import { attentionInfo } from "@/lib/attention";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeNowLima, formatLima, limpiaMarkdown, textoEn12h } from "@/lib/time";
import { humanPauseMs } from "@/lib/typing";
import { findNextSlots } from "@/lib/appointments";
import { sendBotOptions } from "@/lib/outbound";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { toTurns } from "./history";
import { converse, type RunStats } from "./llm";
import { dynamicContext, staticSystemPrompt } from "./prompt";
import type { ToolContext } from "./tools";

export interface AgentContext {
  conversationId: string;
  leadId: string;
  /** Id del mensaje entrante que disparó esta corrida (para descartar corridas obsoletas). */
  messageId: string;
}

const HISTORY_LIMIT = 30;

/** Fecha de hoy en Lima (YYYY-MM-DD), para consultar la agenda. */
const limaHoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/** Qué pasó en una corrida (se guarda en `agent_runs`). */
interface RunResult {
  outcome: "reply" | "refusal" | "skipped";
  detail?: string;
  stats?: RunStats;
}

/**
 * Corrida del agente para la cola de trabajos: registra la corrida en `agent_runs` y, si algo falla, LANZA el error para
 * que la cola reintente (con espera creciente). Si se agotan los intentos, `flagAgentFailure` avisa a una persona.
 */
export async function runAgentJob(ctx: AgentContext): Promise<void> {
  const started = Date.now();
  try {
    const result = await respond(ctx);
    await logRun(ctx, result, Date.now() - started);
  } catch (err) {
    await logRun(ctx, { outcome: "skipped", detail: undefined }, Date.now() - started, err);
    throw err;
  }
}

/**
 * Corrida directa (sin cola): si falla, la conversación queda marcada `requires_human` para que un vendedor la vea.
 * (El bot sigue activo: el siguiente mensaje del cliente lo reintenta.)
 */
export async function runAgent(ctx: AgentContext): Promise<void> {
  try {
    await runAgentJob(ctx);
  } catch (err) {
    console.error("[agent] falló", ctx.conversationId, err);
    await flagAgentFailure(ctx.conversationId, err);
  }
}

/** Avisa a una persona de que el agente no pudo responder (tras agotar los reintentos). */
export async function flagAgentFailure(conversationId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await createAdminClient()
    .from("conversations")
    .update({ requires_human: true, handoff_reason: `Error del agente: ${message}`.slice(0, 300) })
    .eq("id", conversationId);
}

async function logRun(ctx: AgentContext, result: RunResult, ms: number, err?: unknown) {
  try {
    await createAdminClient().from("agent_runs").insert({
      conversation_id: ctx.conversationId,
      lead_id: ctx.leadId,
      message_id: ctx.messageId,
      model: result.stats?.model ?? env.openaiModel,
      outcome: err ? "error" : result.outcome,
      detail: err ? (err instanceof Error ? err.message : String(err)).slice(0, 500) : (result.detail ?? null),
      duration_ms: ms,
      input_tokens: result.stats?.inputTokens ?? null,
      output_tokens: result.stats?.outputTokens ?? null,
      tool_calls: result.stats?.toolCalls ?? [],
    });
  } catch (e) {
    console.error("[agent] no se pudo registrar la corrida", e); // el registro nunca debe romper la respuesta
  }
}

async function isLatestInbound(conversationId: string, messageId: string): Promise<boolean> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id === messageId;
}

/** ¿Ya se le contestó a ese mensaje? (un reintento tras un fallo posterior al envío no debe mandar la respuesta dos veces) */
async function alreadyAnswered(conversationId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("messages")
    .select("direction")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.direction === "out";
}

async function respond(ctx: AgentContext): Promise<RunResult> {
  const db = createAdminClient();
  const startedAt = Date.now();

  // Estado fresco: entre el webhook y esta corrida un vendedor pudo pausar el bot.
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("bot_active, leads(id, nombre, phone, bsuid, branch_id, opt_out, branches(nombre, direccion))")
    .eq("id", ctx.conversationId)
    .single();
  if (convErr) throw convErr;
  const lead = conv.leads as unknown as {
    id: string;
    nombre: string | null;
    phone: string | null;
    bsuid: string | null;
    branch_id: string | null;
    opt_out: boolean;
    branches: { nombre: string; direccion: string } | null;
  };
  if (!conv.bot_active) return { outcome: "skipped", detail: "bot pausado" };
  if (lead.opt_out) return { outcome: "skipped", detail: "cliente dado de baja" };

  // Si el cliente escribió varios mensajes seguidos, solo la corrida del último responde.
  if (!(await isLatestInbound(ctx.conversationId, ctx.messageId))) return { outcome: "skipped", detail: "hay un mensaje más nuevo" };
  if (await alreadyAnswered(ctx.conversationId)) return { outcome: "skipped", detail: "ya se respondió" };

  const { data: rows, error: histErr } = await db
    .from("messages")
    .select("direction, sender, content, attachments")
    .eq("conversation_id", ctx.conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (histErr) throw histErr;
  const history = (rows ?? []).reverse();

  const messages = toTurns(history);
  if (messages.length === 0) return { outcome: "skipped", detail: "sin mensajes" };
  const isFirstBotReply = !history.some((m) => m.sender === "bot");

  const toolCtx: ToolContext = {
    leadId: lead.id,
    conversationId: ctx.conversationId,
    branchId: lead.branch_id,
    handedOff: false,
    messageId: ctx.messageId,
  };

  // Las sucursales (nombre y dirección) salen de la base: lo que el admin registre o edite en el panel lo sabe el agente al instante.
  const { data: branchRows, error: branchErr } = await db.from("branches").select("nombre, direccion").eq("activa", true).order("nombre");
  if (branchErr) throw branchErr;
  // Base de conocimiento que el admin mantiene en el panel (preguntas frecuentes, políticas, servicios).
  const { data: knowledgeRows, error: knowledgeErr } = await db
    .from("knowledge_base")
    .select("titulo, contenido")
    .eq("activa", true)
    .order("created_at");
  if (knowledgeErr) throw knowledgeErr;

  // Parte estable primero, contexto variable al final: así el prefijo idéntico puede reutilizarse en la caché de prompts.
  const instructions = [
    staticSystemPrompt(env.businessName, env.brandTone, branchRows ?? [], knowledgeRows ?? []),
    dynamicContext({
      nowLima: describeNowLima(),
      leadName: lead.nombre,
      branch: lead.branches,
      isFirstBotReply,
      hasPhone: !!lead.phone,
      attention: attentionInfo(),
    }),
  ].join("\n\n");

  const outcome = await converse(instructions, messages, toolCtx);
  const stats = outcome.stats;

  if (outcome.kind === "refusal") {
    // El modelo se negó a responder (o el filtro de contenido lo cortó): que lo vea una persona.
    await db
      .from("conversations")
      .update({ bot_active: false, requires_human: true, handoff_reason: "El asistente no pudo responder este mensaje" })
      .eq("id", ctx.conversationId);
    return { outcome: "refusal", stats };
  }

  if (toolCtx.sentReply) {
    // Respondió con botones/lista (send_options): ese fue el mensaje; el texto final del modelo se descarta.
    return { outcome: "reply", detail: "respondió con botones", stats };
  }

  const text = limpiaMarkdown(textoEn12h(outcome.text.trim()));
  if (!text) return { outcome: "skipped", detail: "el modelo no escribió texto", stats };

  // Las tiendas van SIEMPRE como lista tocable, con su dirección debajo de cada una: el cliente ve dónde están y,
  // al tocar la suya, queda elegida. El modelo las escribe en texto y le obliga a teclear el nombre.
  const tiendas = (branchRows ?? []).map((b) => ({ title: b.nombre as string, description: b.direccion as string }));
  const nombraVariasTiendas = tiendas.filter((t) => text.includes(t.title)).length >= 2;

  // Preguntar «¿en qué sucursal?» sin poner las tiendas obliga al cliente a teclear el nombre de una de las
  // cinco, y a acertar con la tilde. Si el modelo pregunta por la sucursal y todavía no sabemos cuál es la
  // suya, la lista sale igualmente: las opciones las decide el código, no lo que el modelo recuerde escribir.
  const preguntaLaSucursal =
    !toolCtx.branchId && !nombraVariasTiendas && text.includes("?") && /(en qué|en que|cuál|cual|qué|que) (sucursal|tienda)/i.test(text);
  if (!toolCtx.handedOff && preguntaLaSucursal && tiendas.length >= 2) {
    try {
      await sendBotOptions(ctx.conversationId, "¿Cuál sucursal te queda más cerca?", tiendas, { kind: "options" });
      return { outcome: "reply", detail: "sucursal preguntada con la lista de tiendas", stats };
    } catch (err) {
      console.error("[agent] no se pudo enviar la lista de tiendas; va como texto", err);
    }
  }

  if (!toolCtx.handedOff && nombraVariasTiendas) {
    try {
      // Como encabezado, la frase del modelo que no es parte del listado («Claro, aquí tienes nuestras tiendas»).
      const encabezado = text.split("\n").find((l) => l.trim() && !tiendas.some((t) => l.includes(t.title) || l.includes(t.description)))?.trim();
      await sendBotOptions(ctx.conversationId, (encabezado || "Estas son nuestras tiendas. Toca la que te quede más cerca:").slice(0, 900), tiendas, {
        kind: "options",
      });
      return { outcome: "reply", detail: "tiendas enviadas como lista", stats };
    } catch (err) {
      console.error("[agent] no se pudo enviar la lista de tiendas; va como texto", err);
    }
  }

  // Decir «no hay cupo» sin haber mirado la agenda le cuesta citas al negocio: pasó dos veces con horarios que
  // SÍ estaban libres, porque el modelo repetía lo que él mismo había dicho antes. Si lo afirma sin consultar,
  // se consulta aquí y se le ofrecen los horarios de verdad.
  const afirmaSinCupo = /no (hay|tengo|tenemos|queda|quedan)\s+(m[aá]s\s+)?(disponibilidad|cupo|horarios?|espacios?)|no est[aá] disponible/i.test(text);
  const consultoLaAgenda = (stats?.toolCalls ?? []).some((t) => t.name === "get_availability" || t.name === "next_available_slots");
  if (afirmaSinCupo && !consultoLaAgenda && toolCtx.branchId && !toolCtx.handedOff) {
    try {
      const libres = await findNextSlots(toolCtx.branchId, limaHoy(), 3, 7);
      if (libres.length >= 2) {
        const opciones = libres.map((s) => formatLima(new Date(s)).replace(/ de \w+/, ""));
        await sendBotOptions(ctx.conversationId, "Estos son los próximos horarios libres. ¿Cuál te acomoda?", opciones, { kind: "options" });
        return { outcome: "reply", detail: "dijo «sin cupo» sin consultar: se enviaron horarios reales", stats };
      }
    } catch (err) {
      console.error("[agent] no se pudo comprobar la agenda tras un «no hay cupo»", err);
    }
  }

  // Confirmar la tienda también se toca, no se escribe. El modelo lo pide en texto cuando no ha consultado la
  // agenda, y el cliente acaba teniendo que teclear el nombre de su sucursal.
  const suya = tiendas.find((t) => toolCtx.branchId && text.includes(t.title));
  const pideConfirmarTienda =
    !!suya && !nombraVariasTiendas && text.includes("?") && /(sucursal|tienda)/i.test(text) && /(confirm|te agendo|te queda|correcto|es esa|esa es)/i.test(text);
  if (pideConfirmarTienda && !toolCtx.handedOff) {
    try {
      await sendBotOptions(ctx.conversationId, `¿Te agendo en nuestra tienda de ${suya!.title}?`, [`Sí, en ${suya!.title}`, "En otra tienda"], { kind: "options" });
      return { outcome: "reply", detail: "confirmación de tienda con botones", stats };
    } catch (err) {
      console.error("[agent] no se pudo enviar la confirmación de tienda; va como texto", err);
    }
  }

  // «¿Mañana o tarde?» también sale tocable. El modelo la escribe en texto cuando no ha consultado la agenda
  // todavía, y entonces el cliente tiene que responder escribiendo.
  const preguntaFranja = text.includes("?") && /(en|por|de) la ma[ñn]ana/i.test(text) && /(en|por|de) la tarde/i.test(text);
  if (preguntaFranja && !toolCtx.handedOff) {
    try {
      const pregunta = text.split(/\r?\n/).find((l) => l.includes("?"))?.trim() || "¿Prefieres en la mañana o en la tarde?";
      await sendBotOptions(ctx.conversationId, pregunta.slice(0, 900), ["En la mañana", "En la tarde"], { kind: "options" });
      return { outcome: "reply", detail: "franja preguntada con botones", stats };
    } catch (err) {
      console.error("[agent] no se pudieron enviar los botones de franja; va como texto", err);
    }
  }

  // Antes de enviar: ¿siguen vigentes las condiciones? (pausa humana / mensaje más nuevo del cliente)
  if (!toolCtx.handedOff) {
    const { data: fresh } = await db.from("conversations").select("bot_active").eq("id", ctx.conversationId).single();
    if (!fresh?.bot_active) return { outcome: "skipped", detail: "un asesor tomó el chat mientras respondía", stats };
  }
  if (!(await isLatestInbound(ctx.conversationId, ctx.messageId))) return { outcome: "skipped", detail: "llegó un mensaje más nuevo", stats };

  // El «escribiendo…» dura hasta que sale el mensaje: una respuesta larga tarda un poco más que un «sí».
  const pause = humanPauseMs(text, Date.now() - startedAt);
  if (pause > 0) await new Promise((r) => setTimeout(r, pause));

  const sent = await sendWhatsAppText({ phone: lead.phone, bsuid: lead.bsuid }, text);
  const { error: insErr } = await db.from("messages").insert({
    conversation_id: ctx.conversationId,
    direction: "out",
    sender: "bot",
    content: text,
    wa_message_id: sent.id,
  });
  if (insErr) console.error("[agent] mensaje enviado pero no guardado", insErr);


  // Si el cliente no vuelve a escribir, se le hará UN seguimiento (dentro de la ventana de 24 h). Un mensaje suyo lo cancela.
  if (!toolCtx.handedOff && env.followupAfterMinutes > 0) {
    await enqueue({
      kind: "followup",
      payload: { conversationId: ctx.conversationId },
      runAt: new Date(Date.now() + env.followupAfterMinutes * 60_000),
      dedupeKey: `followup:${ctx.conversationId}`,
      debounce: true,
      maxAttempts: 2,
    }).catch((e) => console.error("[agent] no se pudo programar el seguimiento", e));
  }
  return { outcome: "reply", stats };
}
