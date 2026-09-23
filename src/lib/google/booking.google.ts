// Prueba REAL contra Google Calendar de todo el camino de una cita: horarios libres, agendar, evento en Google,
// doble reserva rechazada y limpieza. Usa las credenciales y los calendarios de .env.local y la base local.
// Uso:  npm run test:google     (crea y BORRA una cita de prueba en Huánuco; no toca datos reales de clientes)
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Se lee .env.local a mano: `node --env-file` cortaría la clave privada (interpreta sus "\n").
beforeAll(() => {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
});

import { google } from "googleapis";
import { cancelAppointment, capiKey, reminderKey } from "@/lib/appointment-ops";
import { BookingError, bookAppointment, findNextSlots, getAvailableSlots } from "@/lib/appointments";
import { isWithinBusinessHours } from "@/lib/google/slots";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, limaDateString } from "@/lib/time";
import { deleteCalendarEvent, getBusyIntervals } from "./calendar";

const TEST_PHONE = "+51000000777";

function googleCalendar() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

describe("Google Calendar real", () => {
  const db = () => createAdminClient();
  let branches: { id: string; nombre: string; google_calendar_id: string }[] = [];
  const created = { leadId: null as string | null, calendarId: null as string | null, eventId: null as string | null };

  beforeAll(async () => {
    const { data, error } = await db().from("branches").select("id, nombre, google_calendar_id").eq("activa", true).order("nombre");
    if (error) throw error;
    branches = (data ?? []).filter((b) => b.google_calendar_id) as typeof branches;
  });

  // Pase lo que pase, no queda nada de la prueba: ni el evento en Google, ni la cita, ni el lead.
  afterAll(async () => {
    if (created.calendarId && created.eventId) await deleteCalendarEvent(created.calendarId, created.eventId).catch(() => {});
    if (created.leadId) {
      const { data: appts } = await db().from("appointments").select("id").eq("lead_id", created.leadId);
      for (const a of appts ?? []) await db().from("jobs").delete().in("dedupe_key", [reminderKey(a.id as string, "24h"), reminderKey(a.id as string, "2h"), capiKey(a.id as string, "schedule")]);
      await db().from("appointments").delete().eq("lead_id", created.leadId);
      await db().from("conversations").delete().eq("lead_id", created.leadId);
      await db().from("leads").delete().eq("id", created.leadId);
    }
    await db().from("leads").delete().eq("phone", TEST_PHONE); // resto de una corrida interrumpida
  });

  const from = () => {
    // Desde mañana (Lima), saltando el domingo si hace falta: siempre hay días de atención en los próximos 7.
    return addDays(limaDateString(new Date()), 1);
  };

  it("las 5 sucursales tienen calendario y devuelven horarios libres dentro del horario de atención", async () => {
    expect(branches.length).toBe(5);
    for (const b of branches) {
      const slots = await findNextSlots(b.id, from(), 3, 7);
      expect(slots.length, `${b.nombre} sin horarios`).toBe(3);
      for (const iso of slots) expect(isWithinBusinessHours(new Date(iso), 30), `${b.nombre} ${iso} fuera de horario`).toBe(true);
    }
  });

  it("agenda una cita real: se guarda, crea el evento en Google y ese hueco deja de ofrecerse", async () => {
    const hco = branches.find((b) => b.nombre === "Huánuco")!;
    const [target] = await findNextSlots(hco.id, from(), 1, 7);
    const startsAt = new Date(target);

    const { data: lead, error } = await db()
      .from("leads")
      .insert({ nombre: "Prueba Google (se borra)", phone: TEST_PHONE, branch_id: hco.id })
      .select("id")
      .single();
    if (error) throw error;
    created.leadId = lead.id as string;

    const res = await bookAppointment({ leadId: lead.id as string, branchId: hco.id, startsAt });
    created.calendarId = hco.google_calendar_id;
    created.eventId = res.googleEventId;
    expect(res.googleEventId).toBeTruthy();

    // 1) El evento existe de verdad en Google, con el título, lugar y hora correctos
    const ev = (await googleCalendar().events.get({ calendarId: hco.google_calendar_id, eventId: res.googleEventId })).data;
    expect(ev.summary).toContain("Prueba Google");
    expect(ev.location).toContain("Huánuco");
    expect(new Date(ev.start!.dateTime!).getTime()).toBe(startsAt.getTime());
    expect(ev.description).toContain(TEST_PHONE);

    // 2) La cita quedó en la base, enlazada al evento, y el lead pasó a «cita_agendada»
    const { data: appt } = await db().from("appointments").select("google_event_id, status, scheduled_at").eq("id", res.appointmentId).single();
    expect(appt?.google_event_id).toBe(res.googleEventId);
    expect(appt?.status).toBe("agendada");
    const { data: after } = await db().from("leads").select("stage").eq("id", lead.id).single();
    expect(after?.stage).toBe("cita_agendada");

    // 2b) Se programaron el recordatorio de 2 h y el aviso de conversión a Meta (el de 24 h solo si aún falta más de un día)
    const keys = [reminderKey(res.appointmentId, "2h"), capiKey(res.appointmentId, "schedule")];
    const { data: jobs } = await db().from("jobs").select("dedupe_key, status").in("dedupe_key", keys);
    expect((jobs ?? []).map((j) => j.dedupe_key).sort()).toEqual([...keys].sort());
    expect((jobs ?? []).every((j) => j.status === "pending")).toBe(true);

    // 3) Google ya ve ese hueco ocupado y el sistema deja de ofrecerlo
    const busy = await getBusyIntervals(hco.google_calendar_id, startsAt, new Date(startsAt.getTime() + 30 * 60_000));
    expect(busy.some((b) => b.start <= startsAt && b.end > startsAt)).toBe(true);
    const day = limaDateString(startsAt);
    expect(await getAvailableSlots(hco.id, day)).not.toContain(startsAt.toISOString());
  });

  it("no permite reservar dos veces el mismo hueco", async () => {
    const hco = branches.find((b) => b.nombre === "Huánuco")!;
    const { data: appt } = await db().from("appointments").select("scheduled_at").eq("lead_id", created.leadId!).single();
    await expect(bookAppointment({ leadId: created.leadId!, branchId: hco.id, startsAt: new Date(appt!.scheduled_at as string) })).rejects.toMatchObject({
      code: "slot_taken",
    } satisfies Partial<BookingError>);
  });

  it("al borrar el evento (cancelar), el hueco vuelve a estar libre", async () => {
    const hco = branches.find((b) => b.nombre === "Huánuco")!;
    const { data: appt } = await db().from("appointments").select("id, scheduled_at").eq("lead_id", created.leadId!).single();
    const startsAt = new Date(appt!.scheduled_at as string);
    // La operación real de cancelar: borra el evento en Google, marca la cita y quita sus recordatorios pendientes.
    await cancelAppointment(appt!.id as string);
    created.eventId = null;
    const { data: after } = await db().from("appointments").select("status").eq("id", appt!.id).single();
    expect(after?.status).toBe("cancelada");
    const { data: left } = await db().from("jobs").select("id").in("dedupe_key", [reminderKey(appt!.id as string, "24h"), reminderKey(appt!.id as string, "2h")]).eq("status", "pending");
    expect(left ?? []).toHaveLength(0);
    expect(await getAvailableSlots(hco.id, limaDateString(startsAt))).toContain(startsAt.toISOString());
  });

  it("fuera de horario (domingo) no se agenda", async () => {
    const hco = branches.find((b) => b.nombre === "Huánuco")!;
    // Próximo domingo a las 10:00 Lima
    let d = from();
    while (new Date(`${d}T12:00:00-05:00`).getUTCDay() !== 0) d = addDays(d, 1);
    await expect(bookAppointment({ leadId: created.leadId!, branchId: hco.id, startsAt: new Date(`${d}T10:00:00-05:00`) })).rejects.toMatchObject({ code: "outside_hours" });
  });
});
