import "server-only";
import OpenAI from "openai";
import type { FunctionTool, ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import { env } from "@/lib/env";
import type { Turn } from "./history";
import { AGENT_TOOLS, executeTool, type ToolContext } from "./tools";

const MAX_TOOL_TURNS = 8;
/** Tope de tokens por vuelta, razonamiento incluido (los modelos de razonamiento cuentan lo que "piensan"). */
const MAX_OUTPUT_TOKENS = 8000;

let client: OpenAI | null = null;
export const openai = () => (client ??= new OpenAI({ apiKey: env.openaiApiKey, baseURL: env.openaiBaseUrl }));

/** Herramientas en el formato de la API Responses. `strict: false` porque varios parámetros son opcionales. */
const TOOLS: FunctionTool[] = AGENT_TOOLS.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
  strict: false,
}));

/**
 * Solo los modelos de razonamiento (serie o, GPT-5 y GPT-6) aceptan el parámetro `reasoning`; a gpt-4o, gpt-4.1 y a las variantes
 * "chat" la API les responde 400 ("Unsupported parameter: reasoning.effort"), así que a esos no se les manda.
 */
export const isReasoningModel = (model: string) => /^(o\d|gpt-[56])/.test(model) && !model.includes("chat");

/** Qué costó una corrida: se guarda en `agent_runs` para poder auditar y vigilar el gasto. */
export interface RunStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: { name: string; ms: number; ok: boolean }[];
}

export type Outcome = { kind: "reply"; text: string; stats?: RunStats } | { kind: "refusal"; stats?: RunStats };

/**
 * Bucle de herramientas con la API Responses de OpenAI hasta obtener la respuesta final.
 *
 * Los modelos de razonamiento exigen devolver sus ítems de razonamiento junto con los resultados de las herramientas;
 * `previous_response_id` lo resuelve: cada vuelta solo envía lo nuevo (los `function_call_output`) y OpenAI conserva el resto.
 * Las `instructions` NO se heredan de la respuesta anterior, así que se reenvían en cada vuelta.
 * Cada corrida del agente arma la conversación desde nuestra base de datos, no depende de respuestas de corridas previas.
 */
export async function converse(instructions: string, messages: Turn[], toolCtx: ToolContext): Promise<Outcome> {
  let previousResponseId: string | undefined;
  let input: ResponseInputItem[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const model = env.openaiModel;
  const stats: RunStats = { model, inputTokens: 0, outputTokens: 0, toolCalls: [] };

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await openai().responses.create({
      model,
      instructions,
      input,
      tools: TOOLS,
      ...(isReasoningModel(model) && { reasoning: { effort: env.openaiReasoningEffort } }),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      // Una herramienta por vez y en orden: set_branch debe aplicarse antes de consultar disponibilidad.
      parallel_tool_calls: false,
      ...(previousResponseId && { previous_response_id: previousResponseId }),
    });

    stats.inputTokens += response.usage?.input_tokens ?? 0;
    stats.outputTokens += response.usage?.output_tokens ?? 0;
    console.info("[agent] uso", { turn, status: response.status, in: response.usage?.input_tokens, out: response.usage?.output_tokens });

    if (response.status === "failed") throw new Error(`OpenAI falló: ${response.error?.code ?? "?"} ${response.error?.message ?? ""}`.trim());
    if (response.status === "incomplete") {
      // El filtro de contenido equivale a una negativa: que lo vea una persona. Lo demás (p. ej. max_output_tokens) es un fallo.
      if (response.incomplete_details?.reason === "content_filter") return { kind: "refusal", stats };
      throw new Error(`La respuesta del modelo quedó incompleta (${response.incomplete_details?.reason ?? "?"})`);
    }

    const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");

    if (calls.length === 0) {
      let text = "";
      let refused = false;
      for (const item of response.output) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "output_text") text += (text ? "\n\n" : "") + part.text;
          else if (part.type === "refusal") refused = true;
        }
      }
      return refused && !text ? { kind: "refusal", stats } : { kind: "reply", text, stats };
    }

    const outputs: ResponseInputItem[] = [];
    for (const call of calls) {
      let result: { content: string; isError?: boolean };
      const started = Date.now();
      try {
        result = await executeTool(call.name, parseArguments(call.arguments), toolCtx);
      } catch (err) {
        console.error("[agent] herramienta falló", call.name, err);
        result = { content: "Error interno de la herramienta. Deriva a un asesor con handoff_to_human.", isError: true };
      }
      stats.toolCalls.push({ name: call.name, ms: Date.now() - started, ok: !result.isError });
      // La API no tiene un "is_error": el aviso va en el propio texto que lee el modelo.
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: result.isError ? `ERROR: ${result.content}` : result.content });
    }
    previousResponseId = response.id;
    input = outputs;
  }

  throw new Error(`El agente superó ${MAX_TOOL_TURNS} vueltas de herramientas sin responder`);
}

/** Una llamada simple al modelo, sin herramientas (resúmenes, clasificaciones). Devuelve el texto. */
export async function completeText(instructions: string, userText: string, maxOutputTokens = 700): Promise<string> {
  const model = env.openaiModel;
  const response = await openai().responses.create({
    model,
    instructions,
    input: userText,
    ...(isReasoningModel(model) && { reasoning: { effort: "low" as const } }),
    max_output_tokens: Math.max(maxOutputTokens, isReasoningModel(model) ? 2000 : maxOutputTokens),
  });
  if (response.status === "failed") throw new Error(`OpenAI falló: ${response.error?.code ?? "?"} ${response.error?.message ?? ""}`.trim());
  return (response.output_text ?? "").trim();
}

/** Los argumentos llegan como texto JSON; si el modelo manda algo inválido, la herramienta lo rechazará con un mensaje claro. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}
