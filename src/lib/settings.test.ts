import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El interruptor general del agente. Lo más importante aquí no es que apague, sino que un fallo de la base
 * NUNCA deje al bot mudo: quedarse sin responder a los clientes es peor que responder de más.
 */
const h = vi.hoisted(() => {
  const state = { row: { agent_enabled: true, agent_paused_at: null as string | null, agent_pause_reason: null as string | null, users: null as { nombre: string } | null }, fail: false, reads: 0, updates: [] as Record<string, unknown>[] };
  function builder() {
    const q = { payload: null as Record<string, unknown> | null };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => ((q.payload = p), b),
      eq: () => b,
      maybeSingle: () => {
        state.reads++;
        if (state.fail) return Promise.resolve({ data: null, error: { message: "base caída" } });
        return Promise.resolve({ data: state.row, error: null });
      },
      then: (ok: (v: unknown) => unknown) => {
        if (q.payload) state.updates.push(q.payload);
        return Promise.resolve({ data: null, error: null }).then(ok);
      },
    };
    return b;
  }
  return { state, db: { from: builder } };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));

import { getAgentSwitch, isAgentEnabled, setAgentEnabled } from "./settings";

beforeEach(async () => {
  h.state.row = { agent_enabled: true, agent_paused_at: null, agent_pause_reason: null, users: null };
  h.state.fail = false;
  h.state.reads = 0;
  h.state.updates = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setAgentEnabled(true, "user1");
  h.state.updates = [];
});

describe("interruptor general del agente", () => {
  it("encendido, el agente puede responder", async () => {
    expect(await isAgentEnabled()).toBe(true);
  });

  it("apagado, no puede", async () => {
    h.state.row.agent_enabled = false;
    await setAgentEnabled(false, "user1"); // limpia la caché
    expect(await isAgentEnabled()).toBe(false);
  });

  it("si la base falla, el bot SIGUE respondiendo (quedarse mudo es peor)", async () => {
    h.state.fail = true;
    expect(await isAgentEnabled()).toBe(true);
  });

  it("lee el estado de verdad en cada consulta (sin caché que se quede atrás)", async () => {
    await isAgentEnabled();
    h.state.row.agent_enabled = false; // lo cambió otra instancia del servidor
    expect(await isAgentEnabled()).toBe(false);
  });

  it("al apagarlo, el cambio se nota de inmediato (no espera a que caduque la caché)", async () => {
    await isAgentEnabled(); // deja algo en caché
    h.state.row.agent_enabled = false;
    await setAgentEnabled(false, "user1");
    expect(await isAgentEnabled()).toBe(false);
  });

  it("guarda quién lo apagó y por qué, para avisar al equipo", async () => {
    await setAgentEnabled(false, "user1", "  Responde mal los precios  ");
    expect(h.state.updates.at(-1)).toMatchObject({
      agent_enabled: false,
      agent_paused_by: "user1",
      agent_pause_reason: "Responde mal los precios",
    });
    expect(h.state.updates.at(-1)?.agent_paused_at).toBeTruthy();
  });

  it("al encenderlo se limpian el motivo y quién lo apagó", async () => {
    await setAgentEnabled(true, "user1");
    expect(h.state.updates.at(-1)).toMatchObject({
      agent_enabled: true,
      agent_paused_at: null,
      agent_paused_by: null,
      agent_pause_reason: null,
    });
  });

  it("el aviso del panel puede decir quién lo apagó", async () => {
    h.state.row = { agent_enabled: false, agent_paused_at: "2026-09-22T10:00:00Z", agent_pause_reason: "prueba", users: { nombre: "Luis" } };
    await setAgentEnabled(false, "user1");
    const sw = await getAgentSwitch();
    expect(sw).toMatchObject({ enabled: false, pausedBy: "Luis", reason: "prueba" });
  });
});
