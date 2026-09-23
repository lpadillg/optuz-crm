import { describe, expect, it } from "vitest";
import { buildInteractive } from "./interactive";

describe("buildInteractive", () => {
  it("hasta 3 opciones → botones de respuesta (título ≤ 20)", () => {
    const r = buildInteractive("¿Aceptas?", ["Sí, acepto", "No, gracias"]);
    expect(r.interactive.type).toBe("button");
    if (r.interactive.type === "button") expect(r.interactive.action.buttons.map((b) => b.reply.title)).toEqual(["Sí, acepto", "No, gracias"]);
    expect(r.preview).toBe("¿Aceptas?\n\n▫ Sí, acepto\n▫ No, gracias");
  });

  it("de 4 a 10 opciones → lista (título ≤ 24, botón «Ver opciones»)", () => {
    const r = buildInteractive("¿Qué sucursal?", ["Huánuco", "Tingo María", "Aucayacu", "Tocache", "Uchiza"]);
    expect(r.interactive.type).toBe("list");
    if (r.interactive.type === "list") {
      expect(r.interactive.action.button).toBe("Ver opciones");
      expect(r.interactive.action.sections[0].rows).toHaveLength(5);
      expect(r.interactive.action.sections[0].rows[0]).toEqual({ id: "opt_1", title: "Huánuco" });
    }
  });

  it("recorta los títulos largos al máximo de WhatsApp, con «…»", () => {
    const b = buildInteractive("x", ["sábado 19, 10:00 a. m. (Huánuco)", "domingo 20, 11:00 a. m. (Huánuco)"]);
    if (b.interactive.type === "button") for (const btn of b.interactive.action.buttons) expect(btn.reply.title.length).toBeLessThanOrEqual(20);
    const l = buildInteractive("x", Array.from({ length: 5 }, (_, i) => `opción número ${i} con un nombre larguísimo`));
    if (l.interactive.type === "list") for (const row of l.interactive.action.sections[0].rows) expect(row.title.length).toBeLessThanOrEqual(24);
  });

  it("quita repetidas y vacías; limita a 10; exige al menos 2", () => {
    expect(buildInteractive("x", ["A", "a", " ", "B"]).options).toEqual(["A", "B"]);
    expect(buildInteractive("x", Array.from({ length: 15 }, (_, i) => `Op${i}`)).options).toHaveLength(10);
    expect(() => buildInteractive("x", ["A", "a"])).toThrow(/al menos 2/);
    expect(() => buildInteractive("", ["A", "B"])).toThrow(/texto/);
  });

  it("recorta el cuerpo a 1024 caracteres", () => {
    const r = buildInteractive("z".repeat(2000), ["A", "B"]);
    expect(r.interactive.body.text.length).toBeLessThanOrEqual(1024);
  });
});
