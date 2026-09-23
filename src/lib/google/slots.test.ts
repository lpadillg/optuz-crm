import { describe, expect, it } from "vitest";
import { computeFreeSlots, enFranja, isWithinBusinessHours, prioridadEnPunto } from "./slots";

const lima = (s: string) => new Date(`${s}-05:00`);
const longAgo = new Date("2026-01-01T00:00:00Z");
const hhmm = (d: Date) => new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(11, 16);

/** Agenda de una sucursal donde caben 3 citas a la vez y no hay nada anotado. */
const vacia = (durationMinutes = 30) => ({ bloqueos: [], ocupacion: new Map<number, number>(), capacidad: 3, durationMinutes, now: longAgo });

/** `ocupacion` a partir de pares hora → cuántas citas ya tiene. */
const conCitas = (pares: [string, number][], durationMinutes = 30) => ({
  bloqueos: [],
  ocupacion: new Map(pares.map(([h, n]) => [lima(`2026-09-21T${h}:00`).getTime(), n])),
  capacidad: 3,
  durationMinutes,
  now: longAgo,
});

describe("computeFreeSlots", () => {
  it("un lunes libre: 8:00–12:30 y 14:00–19:30, sin refrigerio (22 huecos)", () => {
    const slots = computeFreeSlots("2026-09-21", vacia()).map(hhmm);
    expect(slots).toHaveLength(22);
    expect(slots[0]).toBe("08:00");
    expect(slots.at(-1)).toBe("19:30");
    expect(slots).toContain("12:30");
    expect(slots).not.toContain("13:00");
    expect(slots).not.toContain("13:30");
    expect(slots).toContain("14:00");
  });

  it("el sábado atiende y el domingo no", () => {
    expect(computeFreeSlots("2026-09-19", vacia())).toHaveLength(22);
    expect(computeFreeSlots("2026-09-20", vacia())).toHaveLength(0);
  });

  it("un evento puesto a mano en el calendario cierra el horario entero", () => {
    const bloqueos = [{ start: lima("2026-09-21T09:00:00"), end: lima("2026-09-21T10:00:00") }];
    const slots = computeFreeSlots("2026-09-21", { ...vacia(), bloqueos }).map(hhmm);
    expect(slots).toContain("08:30");
    expect(slots).not.toContain("09:00");
    expect(slots).not.toContain("09:30");
    expect(slots).toContain("10:00");
  });

  it("una hora con citas sigue disponible hasta llegar al tope de 3", () => {
    const slots = computeFreeSlots("2026-09-21", conCitas([["15", 2], ["16", 3]])).map(hhmm);
    expect(slots).toContain("15:00"); // 2 de 3: queda un cupo
    expect(slots).not.toContain("16:00"); // 3 de 3: lleno
  });

  it("no ofrece horarios pasados", () => {
    const now = lima("2026-09-21T15:10:00");
    const slots = computeFreeSlots("2026-09-21", { ...vacia(), now }).map(hhmm);
    expect(slots[0]).toBe("15:30");
  });

  it("una cita larga no puede cruzar el refrigerio ni el cierre", () => {
    const slots = computeFreeSlots("2026-09-21", vacia(60)).map(hhmm);
    expect(slots).not.toContain("12:30");
    expect(slots).toContain("12:00");
    expect(slots.at(-1)).toBe("19:00");
  });
});

describe("isWithinBusinessHours", () => {
  it("valida apertura, cierre, refrigerio y domingo", () => {
    expect(isWithinBusinessHours(lima("2026-09-21T07:30:00"), 30)).toBe(false);
    expect(isWithinBusinessHours(lima("2026-09-21T08:00:00"), 30)).toBe(true);
    expect(isWithinBusinessHours(lima("2026-09-21T12:45:00"), 60)).toBe(false);
    expect(isWithinBusinessHours(lima("2026-09-21T13:00:00"), 30)).toBe(false);
    expect(isWithinBusinessHours(lima("2026-09-21T19:30:00"), 30)).toBe(true);
    expect(isWithinBusinessHours(lima("2026-09-21T19:45:00"), 30)).toBe(false);
    expect(isWithinBusinessHours(lima("2026-09-20T10:00:00"), 30)).toBe(false);
  });
});

describe("qué horarios se ofrecen", () => {
  it("con la agenda vacía ofrece solo horas en punto (11, no 22)", () => {
    const s = prioridadEnPunto(computeFreeSlots("2026-09-21", vacia())).map(hhmm);
    expect(s).toHaveLength(11);
    expect(s).toContain("08:00");
    expect(s).toContain("19:00");
    expect(s.some((h) => h.endsWith(":30"))).toBe(false);
  });

  it("una hora en punto medio llena se sigue ofreciendo: el objetivo es llenarla", () => {
    const s = prioridadEnPunto(computeFreeSlots("2026-09-21", conCitas([["15", 2]]))).map(hhmm);
    expect(s).toContain("15:00");
    expect(s).not.toContain("15:30");
  });

  it("las medias horas recién aparecen cuando ya no queda ninguna hora en punto con cupo", () => {
    const todasLlenas: [string, number][] = ["08", "09", "10", "11", "12", "14", "15", "16", "17", "18", "19"].map((h) => [h, 3]);
    const s = prioridadEnPunto(computeFreeSlots("2026-09-21", conCitas(todasLlenas))).map(hhmm);
    expect(s.every((h) => h.endsWith(":30"))).toBe(true);
    expect(s).toContain("08:30");
  });

  it("la franja acota a mañana o tarde", () => {
    const libres = computeFreeSlots("2026-09-21", vacia());
    expect(prioridadEnPunto(libres.filter((d) => enFranja(d, "mañana"))).map(hhmm)).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00"]);
    expect(prioridadEnPunto(libres.filter((d) => enFranja(d, "tarde"))).map(hhmm)).toEqual(["14:00", "15:00", "16:00", "17:00", "18:00", "19:00"]);
  });
});
