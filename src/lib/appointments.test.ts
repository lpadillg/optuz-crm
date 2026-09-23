import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cuántas citas puede llegar a tener un mismo cliente. Se prueba contra una base simulada: lo que importa es
 * que el límite se aplique ANTES de tocar Google Calendar y de crear la fila, y que distinga los dos topes.
 */
const h = vi.hoisted(() => {
  const state = {
    /** Citas próximas del cliente (agendada/confirmada). */
    active: 0,
    /** Citas que creó hoy, en cualquier estado. */
    today: 0,
    inserted: [] as unknown[],
  };
  // Cliente de Supabase mínimo: solo lo que usa bookAppointment.
  function builder(table: string) {
    const q = { table, filters: [] as [string, unknown][], head: false };
    const b: Record<string, unknown> = {
      select: (_c?: string, opts?: { head?: boolean }) => ((q.head = Boolean(opts?.head)), b),
      insert: (payload: unknown) => (state.inserted.push(payload), b),
      update: () => b,
      delete: () => b,
      eq: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      in: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      gte: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      single: () => Promise.resolve(resolve(q)),
      maybeSingle: () => Promise.resolve(resolve(q)),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(q)).then(ok, bad),
    };
    return b;
  }
  function resolve(q: { table: string; filters: [string, unknown][]; head: boolean }) {
    if (q.table === "branches") {
      return { data: { id: "b1", nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131", google_calendar_id: "cal-1" }, error: null };
    }
    if (q.table === "leads") return { data: { id: "lead1", nombre: "Ana", phone: "+51999" }, error: null };
    if (q.table === "appointments") {
      // Las dos cuentas del límite se distinguen por el filtro de estado.
      if (q.head) {
        const byStatus = q.filters.some(([k]) => k === "status");
        return { data: null, error: null, count: byStatus ? state.active : state.today };
      }
      return { data: { id: "appt1" }, error: null };
    }
    return { data: null, error: null };
  }
  return { state, db: { from: builder }, getBusyIntervals: vi.fn(), createCalendarEvent: vi.fn(), deleteCalendarEvent: vi.fn(), scheduleAppointmentJobs: vi.fn(), syncStage: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/google/calendar", () => ({
  getBusyIntervals: h.getBusyIntervals,
  createCalendarEvent: h.createCalendarEvent,
  deleteCalendarEvent: h.deleteCalendarEvent,
}));
vi.mock("@/lib/appointment-ops", () => ({ scheduleAppointmentJobs: h.scheduleAppointmentJobs }));
// El tablero se recalcula aparte (src/lib/lead-stage.ts): aquí solo importa el límite de citas.
vi.mock("@/lib/lead-stage", () => ({ syncStageFromAppointments: h.syncStage }));

import { BookingError, bookAppointment } from "./appointments";

/** Un horario de atención seguro: el próximo lunes a las 10:00 de Lima. */
function nextMonday10(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (new Date(d.getTime() - 5 * 3_600_000).getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const day = new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
  return new Date(`${day}T10:00:00-05:00`);
}

const book = () => bookAppointment({ leadId: "lead1", branchId: "b1", startsAt: nextMonday10() });

beforeEach(() => {
  h.state.active = 0;
  h.state.today = 0;
  h.state.inserted = [];
  h.getBusyIntervals.mockReset().mockResolvedValue([]);
  h.createCalendarEvent.mockReset().mockResolvedValue("ev-1");
  h.scheduleAppointmentJobs.mockReset();
  h.syncStage.mockReset();
  vi.unstubAllEnvs();
});

describe("cuántas citas puede tener un mismo cliente", () => {
  it("con menos citas de las permitidas, agenda con normalidad", async () => {
    h.state.active = 2; // el tope por defecto es 3
    await expect(book()).resolves.toMatchObject({ appointmentId: "appt1" });
    expect(h.createCalendarEvent).toHaveBeenCalled();
  });

  it("al llegar al máximo de citas próximas, no agenda otra", async () => {
    h.state.active = 3;
    await expect(book()).rejects.toMatchObject({ code: "too_many_active" } satisfies Partial<BookingError>);
  });

  it("...y ni siquiera consulta Google ni crea la fila (el límite va antes)", async () => {
    h.state.active = 3;
    await expect(book()).rejects.toThrow();
    expect(h.getBusyIntervals).not.toHaveBeenCalled();
    expect(h.createCalendarEvent).not.toHaveBeenCalled();
    expect(h.state.inserted).toHaveLength(0);
  });

  it("el tope de citas del día frena a quien agenda y cancela en bucle", async () => {
    h.state.active = 0; // canceló las anteriores, así que «activas» no lo detiene
    h.state.today = 3;
    await expect(book()).rejects.toMatchObject({ code: "daily_limit" } satisfies Partial<BookingError>);
  });

  it("los dos topes se pueden configurar", async () => {
    vi.stubEnv("MAX_ACTIVE_APPOINTMENTS", "1");
    h.state.active = 1;
    await expect(book()).rejects.toMatchObject({ code: "too_many_active" });

    vi.stubEnv("MAX_ACTIVE_APPOINTMENTS", "5");
    await expect(book()).resolves.toBeTruthy();
  });

  it("el tope diario se puede desactivar con 0", async () => {
    vi.stubEnv("MAX_APPOINTMENTS_PER_DAY", "0");
    h.state.today = 99;
    await expect(book()).resolves.toBeTruthy();
  });

  it("el mensaje del error dice cuántas tiene, para que el bot se lo explique al cliente", async () => {
    h.state.active = 3;
    await expect(book()).rejects.toThrow(/3 cita\(s\) próxima\(s\)/);
  });
});
