// Comportamiento del agente con el modelo REAL en los casos que el negocio reclamó: formato de los mensajes
// y asesorar antes de ofrecer la cita. Corre con `npm run test:live`; escribe las respuestas en un archivo
// (SALIDA_REVISION) para poder leerlas completas cuando algo falle.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executeTool: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./tools", async (orig) => ({ ...(await orig<typeof import("./tools")>()), executeTool: h.executeTool }));

import { toTurns } from "./history";
import { converse } from "./llm";
import { dynamicContext, staticSystemPrompt } from "./prompt";

const SALIDA = process.env.SALIDA_REVISION ?? "";

const BRANCHES = [
  { nombre: "Aucayacu", direccion: "Jr. Grau 180, costado de Mifarma" },
  { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131, frente al Ministerio Público" },
  { nombre: "Tingo María", direccion: "Av. Tito Jaime 343, costado de FerroHogar" },
  { nombre: "Tocache", direccion: "Jr. Freddy Aliaga 754, frente a residencial Bolívar" },
  { nombre: "Uchiza", direccion: "Av. Leoncio Prado 615, Plaza de Armas" },
];

// Extracto del conocimiento real que el negocio tiene cargado, para que el caso sea el de verdad.
const KNOWLEDGE = [
  {
    titulo: "Lentes de contacto",
    contenido:
      "Manejamos lentes de contacto estéticos y con medida; en ese caso solo esféricos, no trabajamos tóricos ni multifocales. Todos van por pedido y llegan entre 2 y 5 días hábiles. Antes necesitas una evaluación con nuestro optómetra, que además te enseña a ponértelos y retirarlos.",
  },
  {
    titulo: "La evaluación visual",
    contenido:
      "La evaluación visual es *gratuita y sin compromiso*: incluye medida de vista computarizada, prueba de agudeza visual, revisión de tu receta anterior y prueba con lunas de muestra. Dura entre 20 y 30 minutos y te atiende nuestro optómetra.",
  },
];

const instrucciones = (branch: (typeof BRANCHES)[number] | null) =>
  [
    staticSystemPrompt("Caddyf Centro Óptico", "cercano y amable, con pocos emojis y mensajes cortos", BRANCHES, KNOWLEDGE),
    dynamicContext({ nowLima: "martes 22 de septiembre de 2026, 18:40", leadName: "Luis", branch, isFirstBotReply: false, hasPhone: true }),
  ].join("\n\n");

h.executeTool.mockImplementation(async () => ({ content: "{}" }));

async function responder(titulo: string, branch: (typeof BRANCHES)[number] | null, ...mensajes: string[]) {
  const out = await converse(instrucciones(branch), toTurns(mensajes.map((content) => ({ direction: "in", content, attachments: [] }))), {
    leadId: "l1",
    conversationId: "c1",
    branchId: null,
    handedOff: false,
  });
  // Si respondió con botones, en producción el texto final se descarta: lo que «dice» es el mensaje de las
  // opciones. Mirar solo el texto penalizaba a los modelos que SÍ usan las herramientas.
  const conOpciones = h.executeTool.mock.calls
    .filter((c) => c[0] === "send_options")
    .map((c) => JSON.stringify(c[1]))
    .join(" ");
  const texto = (out.kind === "reply" ? out.text : `(${out.kind})`).trim() || conOpciones;
  if (SALIDA) fs.appendFileSync(SALIDA, `\n══ ${titulo}\n[cliente] ${mensajes.at(-1)}\n[bot]\n${texto}\n`);
  return texto;
}

/**
 * Lo que el negocio no quiere: que el mensaje CIERRE proponiendo la cita. Mencionar que hace falta una
 * evaluación es información; rematar con «¿agendamos?» es la prisa por vender que pidió quitar.
 */
const cierraProponiendoCita = (t: string) => {
  const ultima = t.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  return /(agend|reserv|cita)/i.test(ultima) && ultima.includes("?");
};

describe("formato de los mensajes (en vivo)", () => {
  it("las direcciones van una por línea, con la sucursal en negrita y sin markdown", async () => {
    const t = await responder("Pide todas las direcciones", null, "Hola, ¿dónde están ubicados?");
    // El nombre en negrita, en su propia línea (da igual si escribe «*Huánuco*» o «*Sucursal Huánuco*»).
    expect(t.split("\n").some((l) => /^\*[^*]*Huánuco[^*]*\*\s*$/.test(l))).toBe(true);
    expect(t).toContain("Jr. 28 de Julio 1131");
    expect(t).not.toContain("**");
    // Cada dirección en su línea: ninguna línea trae dos sucursales.
    expect(t.split("\n").some((l) => l.includes("Aucayacu") && l.includes("Huánuco"))).toBe(false);
  }, 60_000);
});

describe("asesora antes de agendar (en vivo)", () => {
  it("«¿venden lentes de contacto?»: responde, explica y pregunta, sin saltar a la cita", async () => {
    const t = await responder("Pregunta por lentes de contacto", BRANCHES[2], "¿venden lentes de contacto?");
    expect(t.toLowerCase()).toMatch(/s[ií]/);
    expect(t).toContain("?");
    expect(cierraProponiendoCita(t)).toBe(false);
  }, 60_000);

  it("una molestia: pregunta para entender el caso antes de proponer la cita", async () => {
    const t = await responder("Cuenta una molestia", BRANCHES[1], "Hola, últimamente me cuesta leer de cerca");
    expect(t).toContain("?");
    expect(cierraProponiendoCita(t)).toBe(false);
  }, 60_000);

  it("si el cliente pide agendar, no lo interroga: va a la cita", async () => {
    const t = await responder("Pide cita directamente", BRANCHES[1], "Hola, quiero agendar mi evaluación para mañana en la mañana");
    expect(/agend|cita|horario|disponib/i.test(t)).toBe(true);
  }, 60_000);
});

describe("elegir horario (en vivo)", () => {
  /** Cuántas horas distintas ("10:00", "3:30 p. m.") aparecen en un texto: sirve para detectar el muro de horarios. */
  const cuentaHoras = (t: string) => (t.match(/\d{1,2}:\d{2}/g) ?? []).length;

  it("pide cita sin decir hora: pregunta mañana o tarde con botones, sin listar horarios", async () => {
    h.executeTool.mockClear();
    // Si el modelo consultara la agenda igual, devolvemos un día entero libre: el muro de horas que el negocio no quiere ver.
    h.executeTool.mockImplementation(async (name: string) => {
      if (name === "get_availability")
        return { content: JSON.stringify({ fecha: "2026-09-23", horarios_libres: ["8:00 a. m.", "9:00 a. m.", "10:00 a. m.", "11:00 a. m.", "12:00 p. m.", "2:00 p. m."] }) };
      // Los botones se envían de verdad en producción: el simulacro responde como si hubieran salido.
      if (name === "send_options") return { content: JSON.stringify({ enviado: true }) };
      return { content: "{}" };
    });

    const t = await responder("Pide cita sin decir hora", BRANCHES[1], "Hola, quiero agendar mi evaluación para mañana", "Sí, en Huánuco");
    const llamadas = h.executeTool.mock.calls.map((c) => ({ nombre: c[0] as string, args: JSON.stringify(c[1]) }));
    const opciones = llamadas.find((c) => c.nombre === "send_options")?.args ?? "";
    const preguntaFranja = /ma[ñn]ana/i.test(opciones) && /tarde/i.test(opciones);
    const preguntaEnTexto = /tarde/i.test(t) && /\?/.test(t);

    expect(preguntaFranja || preguntaEnTexto).toBe(true);
    expect(cuentaHoras(t)).toBeLessThanOrEqual(3);
  }, 60_000);
});

describe("preguntar por una hora concreta (en vivo)", () => {
  it("«¿a las 6 pm hay?»: lo comprueba y no da la agenda por cerrada", async () => {
    h.executeTool.mockClear();
    // La tarde está libre hasta las 7: la hora que pide SÍ existe, aunque no estuviera entre los 3 botones.
    // La herramienta responde por el código: «esa hora está libre». El modelo solo tiene que transmitirlo.
    h.executeTool.mockImplementation(async (name: string, input: { hora?: string }) => {
      if (name !== "get_availability") return { content: "{}" };
      return input?.hora
        ? { content: JSON.stringify({ hora: input.hora, disponible: true, siguiente_paso: "SÍ está libre: díselo y agenda esa hora con book_appointment." }) }
        : { content: JSON.stringify({ fecha: "2026-09-23", horarios_libres: ["2:00 pm", "3:00 pm", "4:00 pm", "5:00 pm", "6:00 pm", "7:00 pm"] }) };
    });

    const t = await responder(
      "Pregunta por una hora suelta",
      BRANCHES[1],
      "Quiero cita para mañana en la tarde",
      "Sí, en Huánuco",
      "Para las 6pm no hay?",
    );
    // Tiene que preguntar POR ESA HORA (no deducirla de una lista) y no negarla.
    expect(h.executeTool.mock.calls.some((c) => c[0] === "get_availability" && !!(c[1] as { hora?: string })?.hora)).toBe(true);
    expect(/no hay|no tenemos|no est[áa] disponible|ocupad/i.test(t)).toBe(false);
  }, 60_000);
});

describe("cliente que solo quiere cotizar (en vivo)", () => {
  it("si ya tiene su medida, lo pasa a un asesor en vez de insistir con la evaluación", async () => {
    h.executeTool.mockClear();
    h.executeTool.mockImplementation(async (name: string) =>
      name === "handoff_to_human"
        ? { content: JSON.stringify({ derivada: true, siguiente_paso: "Avísale que un asesor lo atenderá." }) }
        : { content: "{}" },
    );

    const t = await responder(
      "Ya tiene su medida y quiere cotizar",
      BRANCHES[1],
      "A cuánto están los lentes? yo uso filtro azul",
      "Ya tengo mi medida, estoy cotizando",
    );
    expect(h.executeTool.mock.calls.some((c) => c[0] === "handoff_to_human")).toBe(true);
    // Y no le repite que se haga la evaluación, que es justo lo que no necesita.
    expect(/evaluaci[óo]n (visual )?(gratuita)?/i.test(t.split("\n").at(-1) ?? "")).toBe(false);
  }, 60_000);
});

describe("pregunta por su pedido (en vivo)", () => {
  it("«¿ya están mis lentes?»: lo pasa a una persona, sin mirar sus citas", async () => {
    h.executeTool.mockClear();
    h.executeTool.mockImplementation(async (name: string) =>
      name === "handoff_to_human"
        ? { content: JSON.stringify({ derivada: true, siguiente_paso: "Avísale que un asesor lo atenderá." }) }
        : { content: JSON.stringify({ citas: [] }) },
    );

    const t = await responder("Pregunta si sus lentes están listos", BRANCHES[1], "Quisiera saber si ya están mis lentes");
    const usadas = h.executeTool.mock.calls.map((c) => c[0]);
    expect(usadas).toContain("handoff_to_human");
    expect(usadas).not.toContain("my_appointments");
    // Y no lo manda a la tienda a averiguar por su cuenta.
    expect(/acércate|acercate|consulta (directamente )?en la (sucursal|tienda)/i.test(t)).toBe(false);
  }, 60_000);
});

describe("dice que le prometieron algo (en vivo)", () => {
  it("no lo contradice ni le recita la política: lo pasa a una persona", async () => {
    h.executeTool.mockClear();
    h.executeTool.mockImplementation(async (name: string) =>
      name === "handoff_to_human"
        ? { content: JSON.stringify({ derivada: true, siguiente_paso: "Avísale que un asesor lo atenderá." }) }
        : { content: "{}" },
    );

    const t = await responder(
      "Dice que el asesor le prometió cobertura",
      BRANCHES[1],
      "Se me rompió la montura",
      "Cuando compré mis lentes el asesor me dijo que también cubría ruptura de montura",
    );
    expect(h.executeTool.mock.calls.map((c) => c[0])).toContain("handoff_to_human");
    // Nada de «no cubre daños por mal uso»: eso es discutirle sin saber qué le dijeron en la tienda.
    expect(/mal uso|no cubre/i.test(t)).toBe(false);
  }, 60_000);
});

describe("reclamo del cliente (en vivo)", () => {
  it("«los lentes no sirven»: deriva de verdad y no supone el género", async () => {
    h.executeTool.mockClear();
    h.executeTool.mockImplementation(async (name: string) =>
      name === "handoff_to_human"
        ? { content: JSON.stringify({ derivada: true, hayAsesores: false, siguiente_paso: "Avísale que un asesor lo atenderá mañana." }) }
        : { content: "{}" },
    );

    const t = await responder("Reclama por el producto", BRANCHES[1], "Los lentes que vendes no sirven");
    // Decir que un asesor lo verá SIN llamar a la herramienta deja el reclamo sin avisar a nadie.
    expect(h.executeTool.mock.calls.map((c) => c[0])).toContain("handoff_to_human");
    expect(/frustrada|preocupada|molesta\b|frustrado|preocupado|molesto\b/i.test(t)).toBe(false);
  }, 60_000);
});
