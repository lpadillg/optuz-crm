import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El paso de la sucursal lo lleva el código. Estas pruebas fijan las dos mitades del trato: que la pregunta
 * salga SIEMPRE cuando falta la tienda —sin depender de cómo redacte el modelo— y que no salga cuando el
 * cliente estaba preguntando otra cosa, que es el riesgo de adelantarse.
 */
const h = vi.hoisted(() => {
  const state = {
    /** Mensajes del cliente en la conversación, del más reciente al más antiguo. */
    entrantes: [] as { direction: string; content: string }[],
    branchRow: null as { id: string } | null,
    updates: [] as Record<string, unknown>[],
  };
  function builder(table: string) {
    const q = { table, op: "select", payload: undefined as unknown };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
      eq: () => b,
      order: () => b,
      limit: () => Promise.resolve({ data: state.entrantes, error: null }),
      maybeSingle: () => Promise.resolve({ data: table === "branches" ? state.branchRow : null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (q.op === "update") state.updates.push(q.payload as Record<string, unknown>);
        return Promise.resolve({ data: null, error: null }).then(ok);
      },
    };
    return b;
  }
  return { state, db: { from: builder }, sendBotOptions: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/outbound", () => ({ sendBotOptions: h.sendBotOptions }));

import { conducirSucursal, pideCita, tiendaNombrada, vinoPorLaPromo } from "./paso-sucursal";

const TIENDAS = [
  { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" },
  { nombre: "Tingo María", direccion: "Av. Tito Jaime 343" },
  { nombre: "Uchiza", direccion: "Av. Leoncio Prado 615" },
];

const conducir = (texto: string, branchNombre: string | null = null, extra: Record<string, unknown> = {}) =>
  conducirSucursal({ conversationId: "c1", leadId: "l1", branchId: branchNombre ? "b1" : null, branchNombre, texto, tiendas: TIENDAS, ...extra });

beforeEach(() => {
  h.state.entrantes = [];
  h.state.branchRow = { id: "b-huanuco" };
  h.state.updates = [];
  h.sendBotOptions.mockReset();
});

describe("cuándo se considera que alguien pide cita", () => {
  it("reconoce las formas normales de pedirla", () => {
    for (const t of ["quiero una cita", "Necesito agendar", "quisiera una evaluación", "me gustaría reservar una cita", "agendar"]) {
      expect(pideCita(t), t).toBe(true);
    }
  });

  it("no confunde con quien pregunta otra cosa", () => {
    for (const t of ["¿cuál es la dirección?", "¿la cita es gratis?", "¿tienen lentes de contacto?", "gracias", "¿atienden domingos?"]) {
      expect(pideCita(t), t).toBe(false);
    }
  });
});

describe("reconocer la tienda que nombra el cliente", () => {
  it("vale tocar la opción, responder a la confirmación o escribirlo sin tildes", () => {
    expect(tiendaNombrada("Huánuco", TIENDAS)?.nombre).toBe("Huánuco");
    expect(tiendaNombrada("Sí, en Huánuco", TIENDAS)?.nombre).toBe("Huánuco");
    expect(tiendaNombrada("huanuco porfa", TIENDAS)?.nombre).toBe("Huánuco");
    expect(tiendaNombrada("el sábado", TIENDAS)).toBeNull();
  });
});

describe("conducir el paso de la sucursal", () => {
  it("sin tienda conocida, pedir cita saca la lista de las cinco, con sus direcciones", async () => {
    const r = await conducir("Hola, quiero una cita");
    expect(r.atendido).toBe(true);
    const [, texto, opciones] = h.sendBotOptions.mock.calls[0];
    expect(texto).toContain("¿Cuál sucursal te queda más cerca?");
    expect(opciones).toEqual(TIENDAS.map((t) => ({ title: t.nombre, description: t.direccion })));
  });

  it("con tienda guardada de otra vez, se confirma con dos botones", async () => {
    const r = await conducir("quiero agendar", "Huánuco");
    expect(r.atendido).toBe(true);
    const [, texto, opciones] = h.sendBotOptions.mock.calls[0];
    expect(texto).toContain("Huánuco");
    expect(opciones).toEqual(["Sí, en Huánuco", "En otra tienda"]);
  });

  it("si nombra la tienda, se guarda y el turno sigue con el modelo", async () => {
    const r = await conducir("Huánuco");
    expect(r.atendido).toBe(false); // no se corta: toca hablar del día
    expect(h.state.updates).toContainEqual({ branch_id: "b-huanuco" });
  });

  it("si ya la eligió antes en esta conversación, no se vuelve a preguntar", async () => {
    h.state.entrantes = [{ direction: "in", content: "Huánuco" }];
    const r = await conducir("quiero una cita");
    expect(r.atendido).toBe(false);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
  });

  it("quien pregunta otra cosa no recibe una lista de tiendas", async () => {
    const r = await conducir("¿la evaluación tiene costo?");
    expect(r.atendido).toBe(false);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
  });

  it("con una sola tienda no hay nada que elegir", async () => {
    const r = await conducirSucursal({
      conversationId: "c1",
      leadId: "l1",
      branchId: null,
      branchNombre: null,
      texto: "quiero una cita",
      tiendas: [TIENDAS[0]],
    });
    expect(r.atendido).toBe(false);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
  });
});

/**
 * Que el mensaje lo escriba el código no significa que tenga que sonar a formulario: el nombre del cliente y
 * la promoción vigente ya los tenemos, y quien viene del anuncio espera que se lo reconozcan.
 */
describe("el mensaje saluda y reconoce por qué vino", () => {
  const PROMO = { titulo: "2x1: el segundo par completo, gratis", enTodas: true };

  it("saluda por su nombre cuando lo sabemos", async () => {
    await conducir("quiero una cita", null, { nombreCliente: "Luis Padilla" });
    expect(h.sendBotOptions.mock.calls[0][1]).toContain("¡Hola, Luis!");
  });

  it("si vino por la promoción, se la reconoce antes de preguntar nada", async () => {
    await conducir("Hola, vi la publicidad del 2x1, quiero agendar", null, { nombreCliente: "Luis", promo: PROMO });
    const texto = h.sendBotOptions.mock.calls[0][1] as string;
    expect(texto).toContain("2x1: el segundo par completo, gratis");
    expect(texto).toContain("todas nuestras tiendas");
    expect(texto).toContain("¿Cuál sucursal te queda más cerca?");
  });

  it("si no la mencionó, no se le suelta la promoción sin venir a cuento", async () => {
    await conducir("quiero una cita", null, { promo: PROMO });
    expect(h.sendBotOptions.mock.calls[0][1]).not.toContain("2x1");
  });

  it("sin nombre ni promoción, el saludo sigue siendo cordial", async () => {
    await conducir("quiero una cita");
    expect(h.sendBotOptions.mock.calls[0][1]).toContain("¡Con gusto!");
  });
});

describe("reconocer que viene por una promoción", () => {
  it("da igual cómo lo escriba", () => {
    for (const t of ["vi el 2x1", "vi la publicidad", "por la promo", "la oferta de lentes", "vi su anuncio"]) {
      expect(vinoPorLaPromo(t), t).toBe(true);
    }
    expect(vinoPorLaPromo("quiero una cita")).toBe(false);
  });
});
