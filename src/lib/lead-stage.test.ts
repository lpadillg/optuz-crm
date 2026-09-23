import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A qué etapa del tablero vuelve un cliente según lo que pase con sus citas. El tablero mide una sola cosa
 * —llegar a la cita—, así que una vez que llega solo sale si la cita desaparece.
 */
const h = vi.hoisted(() => {
  const state = {
    appts: [] as { status: string; scheduled_at: string }[],
    updates: [] as { payload: Record<string, unknown>; filters: [string, unknown][] }[],
  };
  function builder(table: string) {
    const q = { table, payload: {} as Record<string, unknown>, filters: [] as [string, unknown][], isUpdate: false };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => ((q.isUpdate = true), (q.payload = p), b),
      eq: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      is: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      in: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      order: () => b,
      limit: () => Promise.resolve({ data: state.appts, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (q.isUpdate) state.updates.push({ payload: q.payload, filters: q.filters });
        return Promise.resolve({ data: q.table === "appointments" ? state.appts : null, error: null }).then(ok);
      },
    };
    return b;
  }
  return { state, db: { from: builder } };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));

import { syncStageFromAppointments } from "./lead-stage";

const enHoras = (h_: number) => new Date(Date.now() + h_ * 3_600_000).toISOString();
const lastUpdate = () => h.state.updates.at(-1)?.payload ?? {};

beforeEach(() => {
  h.state.appts = [];
  h.state.updates = [];
});

describe("a qué etapa vuelve el cliente según sus citas", () => {
  it("con una cita por delante queda en «Cita agendada»", async () => {
    h.state.appts = [{ status: "agendada", scheduled_at: enHoras(48) }];
    await syncStageFromAppointments("lead1");
    expect(lastUpdate()).toMatchObject({ stage: "cita_agendada" });
  });

  it("si reprogramó (cancela una pero le queda otra), NO pierde «Cita agendada»", async () => {
    h.state.appts = [
      { status: "cancelada", scheduled_at: enHoras(24) },
      { status: "confirmada", scheduled_at: enHoras(72) },
    ];
    await syncStageFromAppointments("lead1");
    expect(lastUpdate()).toMatchObject({ stage: "cita_agendada" });
  });

  it("canceló y no le queda ninguna: vuelve al embudo para conseguir otra", async () => {
    h.state.appts = [{ status: "cancelada", scheduled_at: enHoras(24) }];
    await syncStageFromAppointments("lead1");
    expect(lastUpdate()).toMatchObject({ stage: "seguimiento" });
  });

  it("vino a su cita: sale del tablero, el canal cumplió del todo", async () => {
    h.state.appts = [{ status: "atendida", scheduled_at: enHoras(-24) }];
    await syncStageFromAppointments("lead1");
    expect(lastUpdate()).toMatchObject({ archive_reason: "atendido" });
    expect(lastUpdate().archived_at).toBeTruthy();
  });

  it("no asistió: pasa a su propia columna para que alguien le escriba, no se pierde", async () => {
    h.state.appts = [{ status: "no_show", scheduled_at: enHoras(-24) }];
    await syncStageFromAppointments("lead1");
    expect(lastUpdate()).toMatchObject({ stage: "no_asistio", archived_at: null });
  });

  it("una cita ya pasada sin marcar no cuenta como cita por delante", async () => {
    h.state.appts = [{ status: "agendada", scheduled_at: enHoras(-3) }];
    await syncStageFromAppointments("lead1");
    expect(lastUpdate()).toMatchObject({ stage: "seguimiento" });
  });
});
