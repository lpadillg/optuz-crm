import { describe, expect, it } from "vitest";
import { computeFreeSlots, enFranja, isWithinBusinessHours, soloEnPuntoSalvoOcupado } from "./slots";

const lima = (s: string) => new Date(`${s}-05:00`);
const longAgo = new Date("2026-01-01T00:00:00Z");
const hhmm = (d: Date) => new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(11, 16);

describe("computeFreeSlots", () => {
  it("un lunes libre: 8:00–12:30 y 14:00–19:30, sin refrigerio (22 huecos)", () => {
    const slots = computeFreeSlots("2026-09-21", [], 30, longAgo).map(hhmm);
    expect(slots).toHaveLength(22);
    expect(slots[0]).toBe("08:00");
    expect(slots.at(-1)).toBe("19:30");
    expect(slots).toContain("12:30");
    expect(slots).not.toContain("13:00");
    expect(slots).not.toContain("13:30");
    expect(slots).toContain("14:00");
  });

  it("el sábado atiende y el domingo no", () => {
    expect(computeFreeSlots("2026-09-19", [], 30, longAgo)).toHaveLength(22);
    expect(computeFreeSlots("2026-09-20", [], 30, longAgo)).toHaveLength(0);
  });

  it("quita los huecos que se cruzan con eventos ocupados", () => {
    const busy = [{ start: lima("2026-09-21T09:00:00"), end: lima("2026-09-21T10:00:00") }];
    const slots = computeFreeSlots("2026-09-21", busy, 30, longAgo).map(hhmm);
    expect(slots).toContain("08:30");
    expect(slots).not.toContain("09:00");
    expect(slots).not.toContain("09:30");
    expect(slots).toContain("10:00");
  });

  it("no ofrece horarios pasados", () => {
    const now = lima("2026-09-21T15:10:00");
    const slots = computeFreeSlots("2026-09-21", [], 30, now).map(hhmm);
    expect(slots[0]).toBe("15:30");
  });

  it("una cita larga no puede cruzar el refrigerio ni el cierre", () => {
    const slots = computeFreeSlots("2026-09-21", [], 60, longAgo).map(hhmm);
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
  const ofrecidos = (busy: { start: Date; end: Date }[] = []) =>
    soloEnPuntoSalvoOcupado(computeFreeSlots("2026-09-21", busy, 30, longAgo)).map(hhmm);

  it("con la agenda vacía ofrece solo horas en punto (11, no 22)", () => {
    const s = ofrecidos();
    expect(s).toHaveLength(11);
    expect(s).toContain("08:00");
    expect(s).toContain("19:00");
    expect(s.some((h) => h.endsWith(":30"))).toBe(false);
  });

  it("si una hora en punto se ocupa, recién aparece su media hora", () => {
    const s = ofrecidos([{ start: lima("2026-09-21T15:00:00"), end: lima("2026-09-21T15:30:00") }]);
    expect(s).not.toContain("15:00");
    expect(s).toContain("15:30");
    // Las demás horas siguen ofreciéndose en punto.
    expect(s).toContain("16:00");
    expect(s).not.toContain("16:30");
  });

  it("la franja acota a mañana o tarde", () => {
    const libres = soloEnPuntoSalvoOcupado(computeFreeSlots("2026-09-21", [], 30, longAgo));
    expect(libres.filter((d) => enFranja(d, "mañana")).map(hhmm)).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00"]);
    expect(libres.filter((d) => enFranja(d, "tarde")).map(hhmm)).toEqual(["14:00", "15:00", "16:00", "17:00", "18:00", "19:00"]);
  });
});
