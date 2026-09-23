// Prueba EN VIVO del comportamiento del agente con el modelo real de OpenAI (herramientas simuladas, sin base de datos).
// Uso:  npm run test:live        (usa OPENAI_API_KEY y OPENAI_MODEL de .env.local; OPENAI_MODEL=gpt-5.6-luna para probar otro)
// Sirve para detectar regresiones de comportamiento al cambiar el prompt o el modelo. Cuesta una fracción de centavo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executeTool: vi.fn() }));
vi.mock("server-only", () => ({}));
// Herramientas reales (los esquemas que ve el modelo), pero sin ejecutar nada contra la base de datos.
vi.mock("./tools", async (orig) => ({ ...(await orig<typeof import("./tools")>()), executeTool: h.executeTool }));

import { toTurns } from "./history";
import { AUTO_TAGS } from "./tools";
import { converse } from "./llm";
import { dynamicContext, staticSystemPrompt } from "./prompt";

// Las 5 sucursales reales (supabase/seed.sql).
const BRANCHES = [
  { nombre: "Aucayacu", direccion: "Jr. Grau 180, costado de Mifarma" },
  { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131, frente al Ministerio Público" },
  { nombre: "Tingo María", direccion: "Av. Tito Jaime 343, costado de FerroHogar" },
  { nombre: "Tocache", direccion: "Jr. Freddy Aliaga 754, frente a residencial Bolívar" },
  { nombre: "Uchiza", direccion: "Av. Leoncio Prado 615, Plaza de Armas" },
];

const instructionsFor = (branch: (typeof BRANCHES)[number] | null, firstReply = false) =>
  [
    staticSystemPrompt("Caddyf Centro Óptico", "cercano y amable, con pocos emojis y mensajes cortos", BRANCHES),
    dynamicContext({ nowLima: "sábado 19 de septiembre de 2026, 15:40", leadName: "Cliente", branch, isFirstBotReply: firstReply, hasPhone: true }),
  ].join("\n\n");

const ctx = () => ({ leadId: "l1", conversationId: "c1", branchId: null as string | null, handedOff: false });
const say = (...texts: string[]) => toTurns(texts.map((content) => ({ direction: "in", content, attachments: [] })));

async function ask(instructions: string, turns: ReturnType<typeof say>) {
  const out = await converse(instructions, turns, ctx());
  expect(out.kind).toBe("reply");
  const text = out.kind === "reply" ? out.text : "";
  // LIVE_VERBOSE=1 muestra qué respondió el modelo y qué herramientas llamó (para depurar un caso que falla).
  if (process.env.LIVE_VERBOSE) console.log(`\n[cliente] ${turns.at(-1)?.content}\n[herramientas] ${h.executeTool.mock.calls.map((c) => c[0]).join(", ") || "(ninguna)"}\n[bot] ${text}`);
  return text;
}

beforeEach(() => {
  h.executeTool.mockReset();
  h.executeTool.mockImplementation(async (name: string, input: { branch?: string }) => {
    if (name === "set_branch") {
      const b = BRANCHES.find((x) => x.nombre.toLowerCase() === String(input?.branch).toLowerCase());
      return b ? { content: JSON.stringify({ sucursal: b.nombre, direccion: b.direccion }) } : { content: "No existe esa sucursal", isError: true };
    }
    if (name === "get_active_promotions") return { content: JSON.stringify({ promociones: [] }) };
    if (name === "my_appointments") return { content: JSON.stringify({ citas: [{ appointment_id: "apt-1", cuando: "lunes 21 de septiembre, 10:00", sucursal: "Huánuco", direccion: BRANCHES[1].direccion, estado: "agendada" }] }) };
    if (name === "cancel_appointment") return { content: JSON.stringify({ cancelada: true, siguiente_paso: "Confírmaselo y ofrécele reprogramar." }) };
    if (name === "handoff_to_human") return { content: JSON.stringify({ derivada: true, siguiente_paso: "Escribe un mensaje breve avisando que un asesor lo atenderá." }) };
    return { content: "{}" };
  });
});

describe("citas y etiquetas (en vivo)", () => {
  it("pide cancelar su cita: consulta sus citas y cancela con el id exacto", async () => {
    const text = await ask(instructionsFor(BRANCHES[1]), say("Hola, quiero cancelar mi cita"));
    const calls = h.executeTool.mock.calls;
    expect(calls.map((c) => c[0])).toContain("my_appointments");
    expect(calls.find((c) => c[0] === "cancel_appointment")?.[1]).toMatchObject({ appointment_id: "apt-1" });
    expect(text.length).toBeGreaterThan(0);
  });

  it("dice qué busca: si etiqueta, usa solo etiquetas de la lista y no se lo dice al cliente", async () => {
    const text = await ask(instructionsFor(BRANCHES[1]), say("Busco lentes de contacto y una montura para mi hijo, ¿tienen?"));
    for (const c of h.executeTool.mock.calls.filter((x) => x[0] === "tag_lead")) {
      for (const t of (c[1] as { tags: string[] }).tags) expect(AUTO_TAGS as readonly string[]).toContain(t);
    }
    expect(text).not.toMatch(/etiquet/i);
  });
});

describe(`agente con ${process.env.OPENAI_MODEL || "el modelo por defecto"} (en vivo)`, () => {
  it("dirección de una sucursal sin haber elegido la suya: da la real, no inventa (fallo que ocurrió con gpt-4o-mini)", async () => {
    const text = await ask(instructionsFor(null), say("Dirección en Uchiza"));
    expect(text).toContain("Leoncio Prado 615");
    expect(text).not.toMatch(/Mariscal|Cáceres/i);
  });

  it("dirección de OTRA sucursal estando en la suya: la da (antes se negaba con 'no puedo proporcionarte información')", async () => {
    const text = await ask(instructionsFor(BRANCHES[2]), say("DIRECCION UCHIZA"));
    expect(text).toContain("Leoncio Prado 615");
    expect(text).not.toMatch(/no puedo proporcion|lamentablemente/i);
  });

  it("dirección de la sucursal propia: la exacta", async () => {
    const text = await ask(instructionsFor(BRANCHES[1]), say("¿Dónde queda Huánuco?"));
    expect(text).toContain("28 de Julio 1131");
  });

  it("dirección de una sucursal que NO existe: no inventa una calle", async () => {
    const text = await ask(instructionsFor(null), say("¿Cuál es la dirección de la sucursal de Lima?"));
    expect(text).not.toMatch(/Lima\s*[:,-]?\s*(Jr\.|Av\.|Calle)/i);
  });

  it("precio: usa el mensaje modelo y no da ninguna cifra", async () => {
    const text = await ask(instructionsFor(BRANCHES[1]), say("¿Cuánto cuestan los lentes?"));
    expect(text).toMatch(/evaluación visual gratuita/i);
    expect(text).not.toMatch(/S\/\s?\d|\$\s?\d|\d+\s?soles/i);
  });

  it("pide hablar con una persona: llama a handoff_to_human (no solo lo promete)", async () => {
    await ask(instructionsFor(BRANCHES[1]), say("Quiero hablar con una persona"));
    const called = h.executeTool.mock.calls.map((c) => c[0]);
    expect(called).toContain("handoff_to_human");
  });

  it("promociones: consulta la herramienta y, si no hay, no inventa ninguna", async () => {
    const text = await ask(instructionsFor(BRANCHES[1]), say("¿Tienen alguna promoción?"));
    expect(h.executeTool.mock.calls.map((c) => c[0])).toContain("get_active_promotions");
    expect(text).not.toMatch(/\d+\s?%|2x1|descuento de/i);
  });

  it("elige sucursal escribiendo sin tilde ('Huanuco'): llama set_branch y confirma con la dirección", async () => {
    const text = await ask(instructionsFor(null), say("Huanuco"));
    expect(h.executeTool.mock.calls.some((c) => c[0] === "set_branch")).toBe(true);
    expect(text).toContain("28 de Julio 1131");
  });
});
