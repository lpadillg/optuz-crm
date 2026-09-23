import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Dobles de prueba (hoisted: vi.mock se eleva sobre los imports) ──
const h = vi.hoisted(() => {
  const state = {
    botActive: true,
    freshBotActive: true,
    optOut: false,
    phone: "+51987654321" as string | null,
    branchId: "b1" as string | null,
    latestInboundId: "m1",
    history: [{ direction: "in", sender: "lead", content: "Hola, ¿cuánto cuesta un examen?", attachments: [] }] as Record<string, unknown>[],
    writes: [] as { table: string; op: string; payload: unknown; filters: [string, unknown][] }[],
  };

  function resolve(q: { table: string; op: string; cols: string; filters: [string, unknown][]; payload: unknown }) {
    if (q.op !== "select") {
      state.writes.push({ table: q.table, op: q.op, payload: q.payload, filters: q.filters });
      return { data: null, error: null };
    }
    if (q.table === "conversations") {
      if (q.cols.includes("leads(")) {
        return {
          data: {
            bot_active: state.botActive,
            leads: { id: "lead1", nombre: "Ana", phone: state.phone, bsuid: "PE.111", branch_id: state.branchId, opt_out: state.optOut, branches: state.branchId ? { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" } : null },
          },
          error: null,
        };
      }
      return { data: { bot_active: state.freshBotActive }, error: null };
    }
    if (q.table === "branches") {
      return {
        data: [
          { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" },
          { nombre: "Tingo María", direccion: "Av. Tito Jaime 343" },
          { nombre: "Uchiza", direccion: "Av. Leoncio Prado 615" },
        ],
        error: null,
      };
    }
    if (q.table === "messages") {
      const inbound = q.filters.some(([k, v]) => k === "direction" && v === "in");
      return { data: inbound ? [{ id: state.latestInboundId }] : [...state.history].reverse(), error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const q = { table, op: "select", cols: "", filters: [] as [string, unknown][], payload: undefined as unknown };
    const b: Record<string, unknown> = {
      select: (cols: string) => ((q.cols = cols), b),
      insert: (p: unknown) => ((q.op = "insert"), (q.payload = p), b),
      update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
      eq: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(q)),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(q)).then(ok, bad),
    };
    return b;
  }

  return { state, db: { from: builder }, create: vi.fn(), send: vi.fn(), sendOptions: vi.fn(), executeTool: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    responses = { create: h.create };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/whatsapp/client", () => ({ sendWhatsAppText: h.send }));
vi.mock("@/lib/outbound", () => ({ sendBotOptions: h.sendOptions }));
vi.mock("./tools", () => ({
  AGENT_TOOLS: [{ name: "set_branch", description: "d", input_schema: { type: "object", properties: {} } }],
  executeTool: h.executeTool,
}));

import { runAgent } from "./index";

const ctx = { conversationId: "c1", leadId: "lead1", messageId: "m1" };
const TO = { phone: "+51987654321", bsuid: "PE.111" }; // destinatario que arma el agente a partir del lead
const writes = (table: string, op: string) => h.state.writes.filter((w) => w.table === table && w.op === op);

// Respuestas en el formato de la API Responses de OpenAI
let n = 0;
const usage = { input_tokens: 1, output_tokens: 1 };
const textReply = (text: string) => ({
  id: `resp_${++n}`,
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage,
});
const callReply = (...calls: { name: string; args?: unknown; raw?: string; id?: string }[]) => ({
  id: `resp_${++n}`,
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    ...calls.map((c, i) => ({ type: "function_call", call_id: c.id ?? `call_${i + 1}`, name: c.name, arguments: c.raw ?? JSON.stringify(c.args ?? {}) })),
  ],
  usage,
});
const params = (i: number) => h.create.mock.calls[i][0];

beforeEach(() => {
  Object.assign(h.state, {
    botActive: true,
    freshBotActive: true,
    optOut: false,
    branchId: "b1",
    phone: "+51987654321",
    latestInboundId: "m1",
    writes: [],
    history: [{ direction: "in", sender: "lead", content: "Hola, ¿cuánto cuesta un examen?", attachments: [] }],
  });
  n = 0;
  h.create.mockReset();
  h.send.mockReset().mockResolvedValue({ id: "wamid.OUT1" });
  h.sendOptions.mockReset().mockResolvedValue("msg1");
  h.executeTool.mockReset();
  for (const k of ["OPENAI_MODEL", "OPENAI_REASONING_EFFORT", "OPENAI_BASE_URL", "BUSINESS_NAME"]) delete process.env[k];
  process.env.OPENAI_API_KEY = "test";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runAgent", () => {
  it("responde: envía por WhatsApp al teléfono/BSUID del lead y guarda el mensaje como sender bot", async () => {
    h.create.mockResolvedValueOnce(textReply("¡Hola Ana! 👋"));
    await runAgent(ctx);

    expect(h.send).toHaveBeenCalledWith(TO, "¡Hola Ana! 👋");
    expect(writes("messages", "insert")[0].payload).toMatchObject({ direction: "out", sender: "bot", content: "¡Hola Ana! 👋", wa_message_id: "wamid.OUT1" });
    // La etapa del tablero la mueve el disparador de la base al guardarse el mensaje saliente, no el agente.
    expect(writes("leads", "update")).toHaveLength(0);
  });

  it("ejecuta la herramienta y encadena la respuesta con previous_response_id (solo envía lo nuevo)", async () => {
    h.create.mockResolvedValueOnce(callReply({ name: "get_active_promotions", args: { x: 1 }, id: "call_A" })).mockResolvedValueOnce(textReply("Hoy hay una promo"));
    h.executeTool.mockResolvedValueOnce({ content: '{"promociones":[]}' });
    await runAgent(ctx);

    expect(h.executeTool).toHaveBeenCalledWith("get_active_promotions", { x: 1 }, expect.objectContaining({ leadId: "lead1", branchId: "b1" }));
    const second = params(1);
    expect(second.previous_response_id).toBe("resp_1");
    expect(second.input).toEqual([{ type: "function_call_output", call_id: "call_A", output: '{"promociones":[]}' }]);
    // Las instrucciones y las herramientas NO se heredan de la respuesta anterior: se reenvían.
    expect(second.instructions).toBe(params(0).instructions);
    expect(second.tools).toHaveLength(1);
    expect(h.send).toHaveBeenCalledWith(TO, "Hoy hay una promo");
  });

  it("varias herramientas en una misma respuesta: se ejecutan en orden y se devuelven juntas", async () => {
    h.create
      .mockResolvedValueOnce(callReply({ name: "set_branch", args: { branch: "Huánuco" }, id: "c1" }, { name: "get_availability", args: { date: "2026-09-21" }, id: "c2" }))
      .mockResolvedValueOnce(textReply("Listo"));
    const order: string[] = [];
    h.executeTool.mockImplementation(async (name: string) => (order.push(name), { content: `{"ok":"${name}"}` }));
    await runAgent(ctx);

    expect(order).toEqual(["set_branch", "get_availability"]);
    expect(params(1).input.map((i: { call_id: string }) => i.call_id)).toEqual(["c1", "c2"]);
  });

  it("si una herramienta lanza o responde con error, el modelo recibe 'ERROR: …' en vez de romper la conversación", async () => {
    h.create.mockResolvedValueOnce(callReply({ name: "get_availability", id: "c1" }, { name: "book_appointment", id: "c2" })).mockResolvedValueOnce(textReply("Te paso con un asesor"));
    h.executeTool.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ content: "Ese horario ya no está disponible", isError: true });
    await runAgent(ctx);

    const [a, b] = params(1).input;
    expect(a.output).toMatch(/^ERROR: .*handoff_to_human/);
    expect(b.output).toBe("ERROR: Ese horario ya no está disponible");
    expect(h.send).toHaveBeenCalled();
  });

  it("argumentos que no son JSON válido: la herramienta los recibe como null y los rechaza ella", async () => {
    h.create.mockResolvedValueOnce(callReply({ name: "book_appointment", raw: "{no es json" })).mockResolvedValueOnce(textReply("ok"));
    h.executeTool.mockResolvedValueOnce({ content: "Faltan datos", isError: true });
    await runAgent(ctx);
    expect(h.executeTool).toHaveBeenCalledWith("book_appointment", null, expect.anything());
  });

  it("primer mensaje del bot: el contexto pide el aviso de datos; después ya no", async () => {
    h.create.mockResolvedValue(textReply("ok"));
    await runAgent(ctx);
    expect(params(0).instructions).toContain("Es tu primer mensaje a este cliente");

    h.state.history.push({ direction: "out", sender: "bot", content: "Hola", attachments: [] }, { direction: "in", sender: "lead", content: "y?", attachments: [] });
    h.create.mockClear();
    await runAgent(ctx);
    expect(params(0).instructions).not.toContain("Es tu primer mensaje a este cliente");
  });

  it("cliente sin número visible: el contexto le indica al agente pedir un teléfono de contacto", async () => {
    h.state.phone = null;
    h.create.mockResolvedValueOnce(textReply("ok"));
    await runAgent(ctx);
    expect(params(0).instructions).toContain("contact_phone");

    h.state.phone = "+51987654321";
    h.create.mockClear().mockResolvedValueOnce(textReply("ok"));
    await runAgent(ctx);
    expect(params(0).instructions).not.toContain("contact_phone");
  });

  it("no hace nada si el bot está pausado (toma de control humana)", async () => {
    h.state.botActive = false;
    await runAgent(ctx);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("no responde a un lead dado de baja", async () => {
    h.state.optOut = true;
    await runAgent(ctx);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("descarta la corrida si ya llegó un mensaje más nuevo del cliente", async () => {
    h.state.latestInboundId = "m2";
    await runAgent(ctx);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("si un asesor pausa el bot mientras el modelo piensa, no envía", async () => {
    h.create.mockImplementationOnce(async () => {
      h.state.freshBotActive = false; // pausa durante la llamada al LLM
      return textReply("respuesta que ya no debe salir");
    });
    await runAgent(ctx);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("tras handoff_to_human envía el aviso al cliente aunque el bot ya quedó pausado", async () => {
    h.create.mockResolvedValueOnce(callReply({ name: "handoff_to_human", args: { reason: "reclamo" } })).mockResolvedValueOnce(textReply("Un asesor te atenderá en breve"));
    h.executeTool.mockImplementationOnce(async (_n: string, _i: unknown, tctx: { handedOff: boolean }) => {
      tctx.handedOff = true;
      h.state.freshBotActive = false; // el handler real pone bot_active=false
      return { content: '{"derivada":true}' };
    });
    await runAgent(ctx);
    expect(h.send).toHaveBeenCalledWith(TO, "Un asesor te atenderá en breve");
  });

  it("negativa del modelo (refusal): deriva a humano y no envía nada", async () => {
    h.create.mockResolvedValueOnce({
      id: "resp_r",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No puedo ayudar con eso" }] }],
      usage,
    });
    await runAgent(ctx);
    expect(h.send).not.toHaveBeenCalled();
    expect(writes("conversations", "update")[0].payload).toMatchObject({ bot_active: false, requires_human: true });
  });

  it("filtro de contenido (incomplete: content_filter): se trata como negativa", async () => {
    h.create.mockResolvedValueOnce({ id: "resp_f", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [], usage });
    await runAgent(ctx);
    expect(h.send).not.toHaveBeenCalled();
    expect(writes("conversations", "update")[0].payload).toMatchObject({ bot_active: false, requires_human: true });
  });

  it("si el agente falla, marca la conversación para un humano y no propaga el error", async () => {
    h.create.mockRejectedValueOnce(new Error("API caída"));
    await expect(runAgent(ctx)).resolves.toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(writes("conversations", "update")[0].payload).toMatchObject({ requires_human: true, handoff_reason: expect.stringContaining("API caída") });
  });

  it("respuesta cortada por max_output_tokens (incomplete): no envía media respuesta", async () => {
    h.create.mockResolvedValueOnce({
      id: "resp_i",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hola, te cue", annotations: [] }] }],
      usage,
    });
    await runAgent(ctx);
    expect(h.send).not.toHaveBeenCalled();
    expect(writes("conversations", "update")[0].payload).toMatchObject({ requires_human: true, handoff_reason: expect.stringContaining("max_output_tokens") });
  });

  it("respuesta fallida (status failed): no envía y marca para un humano", async () => {
    h.create.mockResolvedValueOnce({ id: "resp_x", status: "failed", error: { code: "server_error", message: "boom" }, output: [], usage });
    await runAgent(ctx);
    expect(h.send).not.toHaveBeenCalled();
    expect(writes("conversations", "update")[0].payload).toMatchObject({ requires_human: true, handoff_reason: expect.stringContaining("server_error") });
  });

  it("corta un bucle de herramientas infinito", async () => {
    h.create.mockImplementation(async () => callReply({ name: "get_availability" }));
    h.executeTool.mockResolvedValue({ content: "{}" });
    await runAgent(ctx);
    expect(h.create).toHaveBeenCalledTimes(8);
    expect(h.send).not.toHaveBeenCalled();
    expect(writes("conversations", "update")[0].payload).toMatchObject({ requires_human: true });
  });

  it("pide gpt-5.6-terra con razonamiento medio, una herramienta por vez y tope de tokens; la 1.ª vuelta no trae previous_response_id", async () => {
    process.env.BUSINESS_NAME = "Caddyf Centro Óptico";
    h.create.mockResolvedValueOnce(textReply("ok"));
    await runAgent(ctx);

    expect(params(0)).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "medium" },
      parallel_tool_calls: false,
      max_output_tokens: 8000,
    });
    expect(params(0)).not.toHaveProperty("previous_response_id");
    expect(params(0).input).toEqual([{ role: "user", content: "Hola, ¿cuánto cuesta un examen?" }]);
    expect(params(0).tools[0]).toMatchObject({ type: "function", name: "set_branch", strict: false });
    expect(params(0).instructions).toContain("Caddyf Centro Óptico");
    expect(params(0).instructions).toContain("Huánuco"); // sucursal detectada en el contexto
  });

  it("modelos que NO razonan (gpt-4o-mini, gpt-4.1…): no se envía `reasoning` (la API lo rechaza con 400) y el nombre se normaliza", async () => {
    process.env.OPENAI_MODEL = "GPT-4o-mini";
    h.create.mockResolvedValueOnce(textReply("ok"));
    await runAgent(ctx);
    expect(params(0).model).toBe("gpt-4o-mini");
    expect(params(0)).not.toHaveProperty("reasoning");
    // El resto de la petición sigue igual: herramientas, encadenado y tope de tokens.
    expect(params(0)).toMatchObject({ parallel_tool_calls: false, max_output_tokens: 8000 });

    for (const m of ["gpt-4.1", "gpt-4.1-mini", "gpt-5-chat-latest"]) {
      process.env.OPENAI_MODEL = m;
      h.create.mockClear().mockResolvedValueOnce(textReply("ok"));
      await runAgent(ctx);
      expect(params(0)).not.toHaveProperty("reasoning");
    }
  });

  it("modelos de razonamiento (gpt-5.x, gpt-6, serie o): sí se envía `reasoning`", async () => {
    for (const m of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "o4-mini"]) {
      process.env.OPENAI_MODEL = m;
      h.create.mockClear().mockResolvedValueOnce(textReply("ok"));
      await runAgent(ctx);
      expect(params(0).reasoning).toEqual({ effort: "medium" });
    }
  });

  it("el modelo y el esfuerzo de razonamiento se cambian por variables de entorno", async () => {
    process.env.OPENAI_MODEL = "gpt-5.6-luna";
    process.env.OPENAI_REASONING_EFFORT = "low";
    h.create.mockResolvedValueOnce(textReply("ok"));
    await runAgent(ctx);
    expect(params(0)).toMatchObject({ model: "gpt-5.6-luna", reasoning: { effort: "low" } });
  });
});

describe("elegir sucursal siempre con opciones tocables", () => {
  it("si el modelo escribe los nombres de las tiendas, se envían como lista y no como texto", async () => {
    h.state.branchId = null; // aún no sabemos su sucursal
    h.create.mockResolvedValueOnce(textReply("¿En qué sucursal te gustaría atenderte? Tenemos Huánuco, Tingo María y Uchiza."));
    await runAgent(ctx);

    expect(h.sendOptions).toHaveBeenCalledTimes(1);
    expect(h.sendOptions.mock.calls[0][2].map((o: { title: string }) => o.title)).toEqual(["Huánuco", "Tingo María", "Uchiza"]);
    expect(h.send).not.toHaveBeenCalled(); // no se manda además el texto
  });

  it("pedir las direcciones también va como lista: cada tienda lleva su dirección debajo", async () => {
    h.state.branchId = null;
    h.create.mockResolvedValueOnce(textReply("Estas son nuestras tiendas:\n\n*Huánuco*\nJr. 28 de Julio 1131\n\n*Tingo María*\nAv. Tito Jaime 343"));
    await runAgent(ctx);

    expect(h.sendOptions).toHaveBeenCalledTimes(1);
    const [, texto, opciones] = h.sendOptions.mock.calls[0];
    expect(texto).toBe("Estas son nuestras tiendas:");
    expect(opciones[0]).toEqual({ title: "Huánuco", description: "Jr. 28 de Julio 1131" });
    expect(h.send).not.toHaveBeenCalled();
  }, 20_000);

  it("aunque ya sepamos su sucursal, si enumera varias tiendas van como lista", async () => {
    h.create.mockResolvedValueOnce(textReply("Tenemos Huánuco y Tingo María, ¿cuál te queda mejor?"));
    await runAgent(ctx);

    expect(h.sendOptions).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  }, 20_000);

  it("si habla de UNA sola tienda, va como texto normal", async () => {
    h.create.mockResolvedValueOnce(textReply("Te esperamos en Huánuco, Jr. 28 de Julio 1131."));
    await runAgent(ctx);

    expect(h.sendOptions).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  }, 20_000);
});

describe("preguntar mañana o tarde", () => {
  it("la pregunta sale con botones, no en texto", async () => {
    h.create.mockResolvedValueOnce(textReply("Listo, sucursal Huánuco.\n\n¿Prefieres tu cita en la mañana o en la tarde? 😊"));
    await runAgent(ctx);

    expect(h.sendOptions).toHaveBeenCalledTimes(1);
    const [, texto, opciones] = h.sendOptions.mock.calls[0];
    expect(texto).toBe("¿Prefieres tu cita en la mañana o en la tarde? 😊");
    expect(opciones).toEqual(["En la mañana", "En la tarde"]);
    expect(h.send).not.toHaveBeenCalled();
  }, 20_000);

  it("hablar de «mañana» como día no dispara los botones", async () => {
    h.create.mockResolvedValueOnce(textReply("Tu cita quedó para mañana a las 10:00 am. ¡Te esperamos!"));
    await runAgent(ctx);

    expect(h.sendOptions).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  }, 20_000);
});
