import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    branches: [
      { id: "b-hco", nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" },
      { id: "b-uch", nombre: "Uchiza", direccion: "Av. Leoncio Prado 615, Plaza de Armas" },
    ] as { id: string; nombre: string; direccion: string }[],
    writes: [] as { table: string; op: string; payload: unknown; filters: [string, unknown][] }[],
    /** Fila de `messages` que devuelve maybeSingle (el mensaje del cliente que sirve de evidencia). */
    messageRow: null as { content: string; wa_message_id: string } | null,
    /** Fila de `conversations` que devuelve maybeSingle (p. ej. {bot_active:true}). */
    convRow: null as { bot_active: boolean } | null,
    /** Fila de `leads` que devuelve maybeSingle (p. ej. {tags:[]}). */
    leadRow: null as { tags: string[] } | null,
    /** Mensajes del chat, de lo más nuevo a lo más viejo: de ahí sale si el cliente dio su nombre o la tienda. */
    historial: [] as { direction: string; content: string }[],
  };

  function resolve(q: { table: string; op: string; filters: [string, unknown][]; payload: unknown }) {
    if (q.op !== "select") {
      state.writes.push({ table: q.table, op: q.op, payload: q.payload, filters: q.filters });
      return { data: null, error: null };
    }
    if (q.table === "branches") return { data: state.branches, error: null };
    if (q.table === "messages") return { data: state.historial, error: null };
    return { data: [], error: null };
  }
  function builder(table: string) {
    const q = { table, op: "select", filters: [] as [string, unknown][], payload: undefined as unknown };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
      insert: (p: unknown) => ((q.op = "insert"), (q.payload = p), b),
      maybeSingle: () => Promise.resolve({ data: q.table === "messages" ? state.messageRow : q.table === "conversations" ? state.convRow : q.table === "leads" ? state.leadRow : null, error: null }),
      eq: (k: string, v: unknown) => (q.filters.push([k, v]), b),
      order: () => b,
      limit: () => b,
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(q)).then(ok, bad),
    };
    return b;
  }
  class FakeBookingError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return { state, sendBotOptions: vi.fn(), listUpcoming: vi.fn(), cancelAppt: vi.fn(), db: { from: builder }, FakeBookingError, getAvailableSlots: vi.fn(), bookAppointment: vi.fn(), findNextSlots: vi.fn() };
});

const FakeBookingError = h.FakeBookingError;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/outbound", () => ({ sendBotOptions: h.sendBotOptions }));
vi.mock("@/lib/appointment-ops", () => ({ listUpcomingAppointments: h.listUpcoming, cancelAppointment: h.cancelAppt }));
vi.mock("@/lib/appointments", () => ({
  BookingError: h.FakeBookingError,
  getAvailableSlots: h.getAvailableSlots,
  bookAppointment: h.bookAppointment,
  findNextSlots: h.findNextSlots,
}));

import { executeTool, type ToolContext } from "./tools";

const mkCtx = (over: Partial<ToolContext> = {}): ToolContext => ({ leadId: "lead1", conversationId: "conv1", branchId: null, handedOff: false, ...over });
const writes = (table: string, op = "update") => h.state.writes.filter((w) => w.table === table && w.op === op);

beforeEach(() => {
  h.state.writes = [];
  h.state.historial = [{ direction: "in", content: "Soy Ana Pérez, quiero mi cita" }];
  h.state.messageRow = null;
  h.state.convRow = null;
  h.state.leadRow = null;
  h.sendBotOptions.mockReset();
  h.listUpcoming.mockReset();
  h.cancelAppt.mockReset();
  h.state.branches = [
    { id: "b-hco", nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" },
    { id: "b-uch", nombre: "Uchiza", direccion: "Av. Leoncio Prado 615, Plaza de Armas" },
  ];
  h.getAvailableSlots.mockReset();
  h.bookAppointment.mockReset();
  h.findNextSlots.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("set_branch (sucursales desde la base)", () => {
  it("acepta el nombre sin tildes, en mayúsculas o con espacios: 'huanuco ' → Huánuco", async () => {
    const ctx = mkCtx();
    const r = await executeTool("set_branch", { branch: " HUANUCO " }, ctx);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content)).toEqual({ sucursal: "Huánuco", direccion: "Jr. 28 de Julio 1131" });
    expect(ctx.branchId).toBe("b-hco");
    expect(writes("leads")[0]).toMatchObject({ payload: { branch_id: "b-hco" }, filters: [["id", "lead1"]] });
  });

  it("una sucursal registrada después en el panel funciona sin cambiar código", async () => {
    h.state.branches.push({ id: "b-puc", nombre: "Pucallpa", direccion: "Jr. Tarapacá 123" });
    const ctx = mkCtx();
    const r = await executeTool("set_branch", { branch: "pucallpa" }, ctx);
    expect(JSON.parse(r.content).sucursal).toBe("Pucallpa");
    expect(ctx.branchId).toBe("b-puc");
  });

  it("si no existe, error que lista las opciones reales y no toca al lead", async () => {
    const ctx = mkCtx();
    const r = await executeTool("set_branch", { branch: "Lima" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Huánuco, Uchiza");
    expect(ctx.branchId).toBeNull();
    expect(writes("leads")).toHaveLength(0);
  });

  it("entrada inválida → error claro", async () => {
    expect((await executeTool("set_branch", {}, mkCtx())).isError).toBe(true);
    expect((await executeTool("set_branch", null, mkCtx())).isError).toBe(true);
  });
});

describe("derivación automática cuando falla el calendario", () => {
  it("sin calendario configurado: deriva por código (bot pausado + 'Requiere humano' con el motivo) y le dice al modelo qué escribir", async () => {
    h.getAvailableSlots.mockRejectedValueOnce(new FakeBookingError("no_calendar", "La sucursal Huánuco no tiene calendario configurado"));
    const ctx = mkCtx({ branchId: "b-hco" });
    const r = await executeTool("get_availability", { date: "2026-09-21" }, ctx);

    expect(ctx.handedOff).toBe(true);
    expect(writes("conversations")[0]).toMatchObject({
      payload: { bot_active: false, requires_human: true, handoff_reason: expect.stringContaining("Huánuco") },
      filters: [["id", "conv1"]],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Ya derivé la conversación");
  });

  it("Google caído (error inesperado): también deriva y el cliente no queda esperando a nadie", async () => {
    h.findNextSlots.mockRejectedValueOnce(new Error("ECONNRESET"));
    const ctx = mkCtx({ branchId: "b-hco" });
    const r = await executeTool("next_available_slots", {}, ctx);
    expect(ctx.handedOff).toBe(true);
    expect(writes("conversations")[0].payload).toMatchObject({ requires_human: true, handoff_reason: expect.stringContaining("Google Calendar") });
    expect(r.content).toContain("Ya derivé");
  });

  it("al agendar sin calendario, deriva igual", async () => {
    h.bookAppointment.mockRejectedValueOnce(new FakeBookingError("no_calendar", "La sucursal Uchiza no tiene calendario configurado"));
    const ctx = mkCtx({ branchId: "b-uch" });
    const r = await executeTool("book_appointment", { full_name: "Ana Pérez", starts_at: "2099-01-05T15:00" }, ctx);
    expect(ctx.handedOff).toBe(true);
    expect(r.content).toContain("Ya derivé");
  });

  it("errores normales de agenda (cupo ocupado, fuera de horario) NO derivan: el modelo ofrece otra opción", async () => {
    for (const code of ["slot_taken", "outside_hours", "invalid_promotion"]) {
      h.bookAppointment.mockRejectedValueOnce(new FakeBookingError(code, "Ese horario ya no está disponible"));
      const ctx = mkCtx({ branchId: "b-hco" });
      const r = await executeTool("book_appointment", { full_name: "Ana Pérez", starts_at: "2099-01-05T15:00" }, ctx);
      expect(r).toEqual({ content: "Ese horario ya no está disponible", isError: true });
      expect(ctx.handedOff).toBe(false);
    }
    expect(writes("conversations")).toHaveLength(0);
  });

  it("con calendario funcionando no se deriva nada", async () => {
    h.getAvailableSlots.mockResolvedValueOnce(["2026-09-21T13:00:00.000Z"]);
    const ctx = mkCtx({ branchId: "b-hco" });
    const r = await executeTool("get_availability", { date: "2026-09-21" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content).horarios_libres).toEqual(["8:00 am"]); // los mensajes al cliente van en 12 h
    expect(ctx.handedOff).toBe(false);
    expect(writes("conversations")).toHaveLength(0);
  });
});

describe("handoff_to_human", () => {
  it("pausa el bot, marca 'Requiere humano' con el motivo y activa handedOff", async () => {
    const ctx = mkCtx();
    const r = await executeTool("handoff_to_human", { reason: "Reclamo por garantía" }, ctx);
    expect(ctx.handedOff).toBe(true);
    expect(writes("conversations")[0].payload).toEqual({ bot_active: false, requires_human: true, handoff_reason: "Reclamo por garantía" });
    expect(JSON.parse(r.content).derivada).toBe(true);
  });

  it("sin motivo válido igual deriva", async () => {
    const ctx = mkCtx();
    await executeTool("handoff_to_human", {}, ctx);
    expect(writes("conversations")[0].payload).toMatchObject({ handoff_reason: "Sin motivo indicado" });
  });
});

describe("consentimientos", () => {
  const consentRows = () => writes("consent_log", "insert").map((w) => w.payload as Record<string, unknown>);

  it("opt_out (BAJA): marca la baja, revoca las promociones y deja constancia de ambas", async () => {
    h.state.messageRow = { content: "baja por favor", wa_message_id: "wamid.X1" };
    const r = await executeTool("opt_out", {}, mkCtx({ messageId: "m1" }));
    expect(r.isError).toBeFalsy();
    expect(writes("leads")[0].payload).toEqual({ opt_out: true, promo_consent: false });
    const rows = consentRows();
    expect(rows.map((x) => [x.kind, x.action, x.channel])).toEqual([
      ["atencion", "revocado", "whatsapp"],
      ["promociones", "revocado", "whatsapp"],
    ]);
    expect(rows[0]).toMatchObject({ lead_id: "lead1", evidence: "baja por favor", wa_message_id: "wamid.X1", text_version: "v2" });
    expect(r.content).toContain("ALTA"); // le indica cómo volver
  });

  it("promotions_optin: registra la aceptación explícita de promociones (y solo eso)", async () => {
    h.state.messageRow = { content: "PROMO", wa_message_id: "wamid.X2" };
    await executeTool("promotions_optin", {}, mkCtx({ messageId: "m2" }));
    expect(writes("leads")[0].payload).toEqual({ promo_consent: true });
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0]).toMatchObject({ kind: "promociones", action: "otorgado", evidence: "PROMO" });
  });

  it("sin id de mensaje igual deja constancia, sin evidencia", async () => {
    await executeTool("opt_out", {}, mkCtx());
    expect(consentRows()[0]).toMatchObject({ evidence: null, wa_message_id: null });
  });
});

describe("handoff_to_human y el horario de atención", () => {
  const mk = () => mkCtx();
  it("con asesores atendiendo: pide avisar «en breve»", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T15:00:00Z")); // martes 10:00 Lima
    try {
      const r = await executeTool("handoff_to_human", { reason: "reclamo" }, mk());
      const out = JSON.parse(r.content);
      expect(out.atencion).toMatch(/atendiendo ahora/);
      expect(out.siguiente_paso).toMatch(/en breve/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fuera de horario (domingo): NO dice «en breve» y da la hora de retoma", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T15:00:00Z")); // domingo 10:00 Lima
    try {
      const r = await executeTool("handoff_to_human", { reason: "reclamo" }, mk());
      const out = JSON.parse(r.content);
      expect(out.atencion).toMatch(/NO hay asesores/);
      expect(out.siguiente_paso).toMatch(/mañana desde las 8:00/);
      expect(out.siguiente_paso).toMatch(/No digas «en breve»/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("citas: consultar y cancelar por chat", () => {
  const appt = { id: "a1", scheduled_at: "2026-09-21T15:00:00.000Z", status: "agendada", branch: { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" } };

  it("my_appointments devuelve el id, la fecha en hora de Lima y la sucursal", async () => {
    h.listUpcoming.mockResolvedValue([appt]);
    const out = JSON.parse((await executeTool("my_appointments", {}, mkCtx())).content);
    expect(out.citas[0]).toMatchObject({ appointment_id: "a1", sucursal: "Huánuco", estado: "agendada" });
    expect(out.citas[0].cuando).toMatch(/10:00/); // 15:00Z = 10:00 en Lima
  });

  it("sin citas lo dice", async () => {
    h.listUpcoming.mockResolvedValue([]);
    expect(JSON.parse((await executeTool("my_appointments", {}, mkCtx())).content).citas).toEqual([]);
  });

  it("cancel_appointment cancela una cita PROPIA", async () => {
    h.listUpcoming.mockResolvedValue([appt]);
    const r = await executeTool("cancel_appointment", { appointment_id: "a1" }, mkCtx());
    expect(r.isError).toBeFalsy();
    expect(h.cancelAppt).toHaveBeenCalledWith("a1");
  });

  it("cancel_appointment NO cancela una cita que no es del cliente (el id lo manda el modelo)", async () => {
    h.listUpcoming.mockResolvedValue([appt]);
    const r = await executeTool("cancel_appointment", { appointment_id: "ajena" }, mkCtx());
    expect(r.isError).toBe(true);
    expect(h.cancelAppt).not.toHaveBeenCalled();
  });

  it("cancel_appointment sin id → error claro", async () => {
    expect((await executeTool("cancel_appointment", {}, mkCtx())).isError).toBe(true);
  });
});

describe("tag_lead (etiquetas automáticas)", () => {
  it("agrega solo etiquetas de la lista y conserva las que ya tenía", async () => {
    h.state.leadRow = { tags: ["vip"] };
    const r = await executeTool("tag_lead", { tags: ["quiere monturas", "para un niño"] }, mkCtx());
    expect(r.isError).toBeFalsy();
    expect(writes("leads")[0].payload).toEqual({ tags: ["vip", "quiere monturas", "para un niño"] });
  });

  it("ignora las que no están en la lista (el modelo no inventa etiquetas ni anota datos de salud)", async () => {
    h.state.leadRow = { tags: [] };
    const r = await executeTool("tag_lead", { tags: ["miopía severa", "quiere monturas"] }, mkCtx());
    expect(r.isError).toBeFalsy();
    expect(writes("leads")[0].payload).toEqual({ tags: ["quiere monturas"] });
    const bad = await executeTool("tag_lead", { tags: ["diabetes"] }, mkCtx());
    expect(bad.isError).toBe(true);
  });

  it("no repite una etiqueta que ya tiene ni escribe de más", async () => {
    h.state.leadRow = { tags: ["quiere monturas"] };
    await executeTool("tag_lead", { tags: ["quiere monturas"] }, mkCtx());
    expect(writes("leads")).toHaveLength(0);
  });

  it("máximo 3 por vez y al menos 1", async () => {
    expect((await executeTool("tag_lead", { tags: [] }, mkCtx())).isError).toBe(true);
    expect((await executeTool("tag_lead", { tags: ["a", "b", "c", "d"] }, mkCtx())).isError).toBe(true);
  });
});

describe("send_options", () => {
  it("envía la lista/botones, marca la respuesta como enviada y le dice al modelo que no escriba más", async () => {
    h.state.convRow = { bot_active: true };
    const ctx = mkCtx();
    const r = await executeTool("send_options", { text: "¿Qué sucursal?", options: ["Huánuco", "Uchiza"] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(h.sendBotOptions).toHaveBeenCalledWith("conv1", "¿Qué sucursal?", ["Huánuco", "Uchiza"], { kind: "options" });
    expect(ctx.sentReply).toBe(true);
    expect(r.content).toMatch(/NO escribas más texto/);
  });

  it("rechaza menos de 2 opciones", async () => {
    h.state.convRow = { bot_active: true };
    const ctx = mkCtx();
    expect((await executeTool("send_options", { text: "x", options: ["solo una"] }, ctx)).isError).toBe(true);
    expect(ctx.sentReply).toBeFalsy();
  });

  it("si un asesor tomó el chat, no envía nada", async () => {
    h.state.convRow = { bot_active: false };
    const ctx = mkCtx();
    expect((await executeTool("send_options", { text: "x", options: ["A", "B"] }, ctx)).isError).toBe(true);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
  });

  it("si Meta rechaza el envío, le dice al modelo que escriba las opciones como texto", async () => {
    h.state.convRow = { bot_active: true };
    h.sendBotOptions.mockRejectedValue(new Error("WhatsApp API 400"));
    const ctx = mkCtx();
    const r = await executeTool("send_options", { text: "x", options: ["A", "B"] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/como texto normal/);
    expect(ctx.sentReply).toBeFalsy();
  });
});

describe("un solo mensaje con opciones por turno", () => {
  it("si la disponibilidad ya envió los botones, send_options no los repite", async () => {
    const ctx = { leadId: "l1", conversationId: "c1", branchId: "b1", handedOff: false, sentReply: true };
    const r = await executeTool("send_options", { text: "¿Cuál te acomoda?", options: ["8:00 am", "9:00 am"] }, ctx);
    expect(JSON.parse(r.content).enviado).toBe(false);
  });
});

describe("consultar una hora concreta", () => {
  it("acepta «12:00» (una validación rota la rechazaba y el agente creía que no había cupo)", async () => {
    const ctx = { leadId: "l1", conversationId: "c1", branchId: "b1", handedOff: false };
    const r = await executeTool("get_availability", { date: "2026-09-23", hora: "12:00" }, ctx);
    expect(r.content).not.toContain("Fecha inválida");
    expect(r.content).not.toContain("Hora inválida");
  });

  it("una hora con formato raro se rechaza diciendo que es la HORA, no la fecha", async () => {
    const ctx = { leadId: "l1", conversationId: "c1", branchId: "b1", handedOff: false };
    const r = await executeTool("get_availability", { date: "2026-09-23", hora: "mediodía" }, ctx);
    expect(r.content).toContain("Hora inválida");
  });
});

describe("los campos opcionales aceptan null", () => {
  it("«promotion_id: null» no rompe el agendamiento (el modelo lo manda así)", async () => {
    const ctx = { leadId: "l1", conversationId: "c1", branchId: "b1", handedOff: false };
    const r = await executeTool("book_appointment", { full_name: "Ana Pérez", starts_at: "2099-01-05T15:00", promotion_id: null, contact_phone: null }, ctx);
    expect(r.content).not.toContain("Faltan datos");
  });

  it("«franja: null» al consultar la agenda tampoco", async () => {
    const ctx = { leadId: "l1", conversationId: "c1", branchId: "b1", handedOff: false };
    const r = await executeTool("get_availability", { date: "2099-01-05", franja: null, hora: null }, ctx);
    expect(r.content).not.toContain("Fecha inválida");
  });
});

describe("el nombre de la cita lo confirma el cliente", () => {
  it("no agenda con un nombre que el cliente nunca dijo", async () => {
    h.state.historial = [{ direction: "in", content: "quiero una cita" }];
    const ctx = { leadId: "l1", conversationId: "c1", branchId: "b1", handedOff: false };
    const r = await executeTool("book_appointment", { full_name: "Nombre Inventado", starts_at: "2099-01-05T15:00" }, ctx);
    expect(r.content).toMatch(/pregúntale a nombre de quién|confirme el nombre|preguntado/i);
  });
});
