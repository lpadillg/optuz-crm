import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cuándo sale del tablero quien no vino a su cita.
 *
 * «No asistió» es una lista de trabajo, no un archivo: mientras nadie le haya escrito para ofrecerle otro
 * horario, el lead se queda a la vista por mucho tiempo que pase. Solo cuando ya se le escribió y aun así no
 * contestó deja de ser trabajo pendiente y pasa a «Sin respuesta», donde envejece y se archiva como el resto.
 * Es una regla sutil y fácil de romper sin darse cuenta, de ahí esta prueba.
 */
const h = vi.hoisted(() => {
  const state = {
    /** Respuestas que devuelve cada tabla, en orden de consulta. */
    respuestas: {} as Record<string, unknown[][]>,
    updates: [] as { table: string; payload: Record<string, unknown>; filters: [string, unknown][] }[],
  };

  function siguiente(table: string): unknown[] {
    const cola = state.respuestas[table];
    return (cola && cola.length ? cola.shift() : []) as unknown[];
  }

  function builder(table: string) {
    const q = { payload: {} as Record<string, unknown>, filters: [] as [string, unknown][], isUpdate: false };
    const resolver = () => {
      if (q.isUpdate) {
        state.updates.push({ table, payload: q.payload, filters: q.filters });
        // Una actualización devuelve las filas que cambió: aquí, las que se le pasaron en el filtro `in`.
        const enIn = q.filters.find(([k]) => k === "id")?.[1];
        return { data: Array.isArray(enIn) ? enIn.map((id) => ({ id })) : [], error: null };
      }
      return { data: siguiente(table), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => ((q.isUpdate = true), (q.payload = p), b),
      eq: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      is: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      in: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      lt: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      order: () => b,
      limit: () => Promise.resolve(resolver()),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok),
    };
    return b;
  }
  return { state, db: { from: builder } };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));

import { refreshLeadStages } from "./lead-stage";

/** Deja la base en un estado donde solo importa lo de «No asistió». */
function escenario(opts: { ausentes: string[]; calladas: { id: string; lead_id: string }[]; avisados: string[] }) {
  h.state.respuestas = {
    // 1) conversaciones calladas (el paso de «En seguimiento»), 2) las de los ausentes
    conversations: [[], opts.calladas],
    // 1) los leads en «No asistió», 2) las conversaciones viejas para archivar
    leads: [opts.ausentes.map((id) => ({ id }))],
    messages: [opts.avisados.map((conversation_id) => ({ conversation_id }))],
  };
}

const moviditos = () => h.state.updates.filter((u) => u.payload.stage === "sin_respuesta");

beforeEach(() => {
  h.state.respuestas = {};
  h.state.updates = [];
});

describe("quien no vino a su cita", () => {
  it("si ya se le escribió y no contestó, pasa a «Sin respuesta»", async () => {
    escenario({
      ausentes: ["lead1"],
      calladas: [{ id: "conv1", lead_id: "lead1" }],
      avisados: ["conv1"], // recibió el mensaje de recuperación
    });
    await refreshLeadStages();
    const u = moviditos().at(-1);
    expect(u?.filters).toContainEqual(["id", ["lead1"]]);
    expect(u?.filters).toContainEqual(["stage", "no_asistio"]);
  });

  it("si NADIE le ha escrito, se queda en la columna por mucho que pase el tiempo", async () => {
    escenario({
      ausentes: ["lead1"],
      calladas: [{ id: "conv1", lead_id: "lead1" }],
      avisados: [], // nadie le ofreció otro horario todavía: sigue siendo trabajo pendiente
    });
    await refreshLeadStages();
    expect(moviditos()).toHaveLength(0);
  });

  it("si la conversación no está callada (contestó), tampoco se toca", async () => {
    escenario({ ausentes: ["lead1"], calladas: [], avisados: ["conv1"] });
    await refreshLeadStages();
    expect(moviditos()).toHaveLength(0);
  });

  it("sin nadie en la columna, no consulta mensajes ni actualiza nada", async () => {
    escenario({ ausentes: [], calladas: [], avisados: [] });
    await refreshLeadStages();
    expect(moviditos()).toHaveLength(0);
  });
});
