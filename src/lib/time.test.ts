import { describe, expect, it } from "vitest";
import { addDays, limaDateString, parseLimaLocal, textoEn12h, limpiaMarkdown } from "./time";

describe("time (hora de Lima)", () => {
  it("parseLimaLocal interpreta la hora local como UTC-5", () => {
    expect(parseLimaLocal("2026-09-21T09:00")?.toISOString()).toBe("2026-09-21T14:00:00.000Z");
  });

  it("parseLimaLocal rechaza formatos inválidos", () => {
    expect(parseLimaLocal("2026-09-21 09:00")).toBeNull();
    expect(parseLimaLocal("mañana")).toBeNull();
    expect(parseLimaLocal("2026-13-40T09:00")).toBeNull();
  });

  it("limaDateString respeta el cambio de día por el desfase", () => {
    // 02:00 UTC del 21 = 21:00 del 20 en Lima
    expect(limaDateString(new Date("2026-09-21T02:00:00Z"))).toBe("2026-09-20");
    expect(limaDateString(new Date("2026-09-21T05:00:00Z"))).toBe("2026-09-21");
  });

  it("addDays cruza fin de mes y de año", () => {
    expect(addDays("2026-09-28", 5)).toBe("2026-10-03");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("textoEn12h", () => {
  it("convierte las horas de 24 h que el agente arrastra de mensajes anteriores", () => {
    expect(textoEn12h("Atendemos de 8:00 a 20:00.")).toBe("Atendemos de 8:00 am a 8:00 pm.");
    expect(textoEn12h("Tu cita es a las 15:30.")).toBe("Tu cita es a las 3:30 pm.");
    expect(textoEn12h("Abrimos 00:30")).toBe("Abrimos 12:30 am");
  });

  it("no toca lo que ya está bien ni las horas ambiguas", () => {
    expect(textoEn12h("Te esperamos a las 9:00 am")).toBe("Te esperamos a las 9:00 am");
    expect(textoEn12h("Elige 8:00, 9:00 o 10:00")).toBe("Elige 8:00, 9:00 o 10:00");
    expect(textoEn12h("Son 3:30 pm")).toBe("Son 3:30 pm");
  });
});

describe("limpiaMarkdown", () => {
  it("deja la negrita como la entiende WhatsApp y quita títulos", () => {
    expect(limpiaMarkdown("**Fecha:** lunes")).toBe("*Fecha:* lunes");
    expect(limpiaMarkdown("### Horarios\nlibre")).toBe("Horarios\nlibre");
    expect(limpiaMarkdown("- 8:00 am\n- 9:00 am")).toBe("• 8:00 am\n• 9:00 am");
  });

  it("no toca la negrita que ya es correcta", () => {
    expect(limpiaMarkdown("*Huánuco*\nJr. 28 de Julio")).toBe("*Huánuco*\nJr. 28 de Julio");
  });
});
