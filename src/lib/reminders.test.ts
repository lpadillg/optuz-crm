import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Qué pasa cuando el cliente responde a un recordatorio de cita.
 *
 * Confirmar y cancelar no pueden costar lo mismo: confirmar es reversible y cancelar no —borra el evento del
 * calendario y suelta el cupo, que otro cliente puede tomar en minutos—, y el botón de cancelar está justo al
 * lado de los otros dos. De ahí que cancelar se pregunte antes.
 */
const h = vi.hoisted(() => {
  const state = {
    /** Lo que decía el último mensaje nuestro (su `meta`). */
    ultimoMeta: null as Record<string, unknown> | null,
    appt: { id: "appt1", status: "agendada", scheduled_at: "" } as Record<string, unknown> | null,
    enviados: [] as { tipo: "texto" | "botones"; texto: string; opciones?: string[]; meta?: Record<string, unknown> }[],
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      maybeSingle: () => Promise.resolve({ data: table === "appointments" ? state.appt : null, error: null }),
      limit: () => Promise.resolve({ data: state.ultimoMeta ? [{ meta: state.ultimoMeta }] : [], error: null }),
    };
    return b;
  }
  return {
    state,
    db: { from: builder },
    cancelAppointment: vi.fn(),
    confirmAppointment: vi.fn(),
    sendBotText: vi.fn(async (_c: string, texto: string, meta?: Record<string, unknown>) => {
      state.enviados.push({ tipo: "texto", texto, meta });
    }),
    sendBotOptions: vi.fn(async (_c: string, texto: string, opciones: string[], meta?: Record<string, unknown>) => {
      state.enviados.push({ tipo: "botones", texto, opciones, meta });
    }),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/appointment-ops", () => ({ cancelAppointment: h.cancelAppointment, confirmAppointment: h.confirmAppointment }));
vi.mock("@/lib/outbound", () => ({ sendBotText: h.sendBotText, sendBotOptions: h.sendBotOptions, sendBotTemplate: vi.fn() }));

import { handleReminderReply } from "./reminders";

const result = { conversationId: "conv1", botActive: true } as never;
const ultimo = () => h.state.enviados.at(-1);

beforeEach(() => {
  h.state.ultimoMeta = { kind: "reminder", appointment_id: "appt1" };
  h.state.appt = { id: "appt1", status: "agendada", scheduled_at: new Date(Date.now() + 48 * 3_600_000).toISOString() };
  h.state.enviados = [];
  h.cancelAppointment.mockReset();
  h.confirmAppointment.mockReset();
});

describe("responder a un recordatorio", () => {
  it("«Confirmar» se aplica en el acto: no hay nada que perder", async () => {
    expect(await handleReminderReply(result, "Confirmar")).toBe(true);
    expect(h.confirmAppointment).toHaveBeenCalledWith("appt1");
    expect(ultimo()?.tipo).toBe("texto");
  });

  it("«Cancelar» NO cancela todavía: pregunta antes, con botones", async () => {
    expect(await handleReminderReply(result, "Cancelar")).toBe(true);
    expect(h.cancelAppointment).not.toHaveBeenCalled();
    expect(ultimo()?.tipo).toBe("botones");
    expect(ultimo()?.opciones).toEqual(["Sí, cancelar", "Mantener la cita"]);
  });

  it("...y la pregunta dice qué cita es, para que se note el toque por error", async () => {
    await handleReminderReply(result, "Cancelar");
    expect(ultimo()?.texto).toMatch(/Cancelo tu cita del .+ a las /);
  });

  it("solo cancela de verdad cuando lo confirma", async () => {
    h.state.ultimoMeta = { kind: "cancel_confirm", appointment_id: "appt1" };
    expect(await handleReminderReply(result, "Sí, cancelar")).toBe(true);
    expect(h.cancelAppointment).toHaveBeenCalledWith("appt1");
  });

  it("si dice que la mantiene, la cita se queda y no se toca nada", async () => {
    h.state.ultimoMeta = { kind: "cancel_confirm", appointment_id: "appt1" };
    expect(await handleReminderReply(result, "Mantener la cita")).toBe(true);
    expect(h.cancelAppointment).not.toHaveBeenCalled();
    expect(ultimo()?.texto).toMatch(/sigue en pie/);
  });

  it("un «no» suelto ante la pregunta también mantiene la cita", async () => {
    h.state.ultimoMeta = { kind: "cancel_confirm", appointment_id: "appt1" };
    await handleReminderReply(result, "no");
    expect(h.cancelAppointment).not.toHaveBeenCalled();
  });

  it("si contesta otra cosa a la pregunta, lo lleva el agente en vez de adivinar", async () => {
    h.state.ultimoMeta = { kind: "cancel_confirm", appointment_id: "appt1" };
    expect(await handleReminderReply(result, "mejor cámbiala al viernes")).toBe(false);
    expect(h.cancelAppointment).not.toHaveBeenCalled();
  });

  it("«Reagendar» no se resuelve aquí: buscar horario es una conversación", async () => {
    expect(await handleReminderReply(result, "Reagendar")).toBe(false);
    expect(h.cancelAppointment).not.toHaveBeenCalled();
    expect(h.confirmAppointment).not.toHaveBeenCalled();
  });

  it("si el último mensaje nuestro no era un recordatorio, no se toca la cita", async () => {
    h.state.ultimoMeta = { kind: "reply" };
    expect(await handleReminderReply(result, "Cancelar")).toBe(false);
  });

  it("una cita ya pasada o cancelada no se vuelve a tocar", async () => {
    h.state.appt = { id: "appt1", status: "cancelada", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() };
    expect(await handleReminderReply(result, "Confirmar")).toBe(false);
  });
});
