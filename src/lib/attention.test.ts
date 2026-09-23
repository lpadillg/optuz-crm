import { describe, expect, it } from "vitest";
import { attentionInfo } from "./attention";

// Lima = UTC−5 fijo. Sábado 19/09/2026 (semana de referencia del proyecto).
const lima = (iso: string) => new Date(`${iso}-05:00`);

describe("attentionInfo", () => {
  it("dentro del horario: abierto y «en breve»", () => {
    const r = attentionInfo(lima("2026-09-19T10:30:00"));
    expect(r.open).toBe(true);
    expect(r.message).toMatch(/en breve/);
  });

  it("en el refrigerio (13:00–14:00): cerrado, retoma hoy a las 2:00 p. m.", () => {
    const r = attentionInfo(lima("2026-09-19T13:20:00"));
    expect(r.open).toBe(false);
    expect(r.nextOpen.toISOString()).toBe(lima("2026-09-19T14:00:00").toISOString());
    expect(r.message).toMatch(/hoy desde las 2:00/);
  });

  it("de noche (22:15): cerrado, retoma mañana a las 8:00", () => {
    const r = attentionInfo(lima("2026-09-17T22:15:00")); // jueves
    expect(r.open).toBe(false);
    expect(r.nextOpen.toISOString()).toBe(lima("2026-09-18T08:00:00").toISOString());
    expect(r.message).toMatch(/mañana desde las 8:00/);
  });

  it("madrugada del mismo día: retoma hoy a las 8:00", () => {
    const r = attentionInfo(lima("2026-09-17T06:00:00"));
    expect(r.message).toMatch(/hoy desde las 8:00/);
  });

  it("sábado tarde después de las 20:00: salta el domingo y retoma el lunes", () => {
    const r = attentionInfo(lima("2026-09-19T20:30:00"));
    expect(r.open).toBe(false);
    expect(r.nextOpen.toISOString()).toBe(lima("2026-09-21T08:00:00").toISOString());
    expect(r.message).toMatch(/lunes desde las 8:00/);
  });

  it("domingo: cerrado todo el día; el lunes es «mañana»", () => {
    const r = attentionInfo(lima("2026-09-20T11:00:00"));
    expect(r.open).toBe(false);
    expect(r.nextOpen.toISOString()).toBe(lima("2026-09-21T08:00:00").toISOString());
    expect(r.message).toMatch(/mañana desde las 8:00/);
  });
});
