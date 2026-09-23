import { describe, expect, it } from "vitest";
import { revisarPlantilla, variablesDe, vistaPrevia } from "./plantilla-reglas";

/**
 * Las reglas que Meta aplica a una plantilla. Importan más de lo que parece: cuando Meta rechaza, lo hace
 * horas después, en inglés y sin decir qué arreglar, así que cada regla comprobada aquí es una espera que el
 * negocio se ahorra.
 */
const base = {
  name: "cliente_dormido",
  category: "UTILITY" as const,
  language: "es",
  body: "Hola {{1}} 👋 Seguimos por aquí si quieres retomar tu evaluación visual.",
  examples: ["María"],
};

const problemas = (p: Partial<typeof base>) => revisarPlantilla({ ...base, ...p });

describe("revisarPlantilla", () => {
  it("una plantilla correcta no tiene nada que arreglar", () => {
    expect(problemas({})).toEqual([]);
  });

  it("el nombre solo admite minúsculas, números y guiones bajos", () => {
    expect(problemas({ name: "Cliente Dormido" })[0]).toMatch(/minúsculas/);
    expect(problemas({ name: "cliente-dormido" })[0]).toMatch(/minúsculas/);
    expect(problemas({ name: "cliente_dormido_2" })).toEqual([]);
  });

  it("las variables van 1, 2, 3… sin saltos", () => {
    expect(problemas({ body: "Hola {{1}}, tu cita es el {{3}} por la tarde.", examples: ["María", "", "lunes"] })[0]).toMatch(/en ese orden/);
    expect(problemas({ body: "Hola {{2}}, ¿seguimos?", examples: ["", "María"] })[0]).toMatch(/en ese orden/);
  });

  it("no puede empezar ni terminar en variable, ni llevar dos seguidas", () => {
    expect(problemas({ body: "{{1}}, ¿retomamos tu evaluación?", examples: ["María"] })[0]).toMatch(/empezar/);
    expect(problemas({ body: "Tu cita es el {{1}}", examples: ["lunes"] })[0]).toMatch(/terminar/);
    expect(problemas({ body: "Hola {{1}} {{2}}, te esperamos.", examples: ["María", "Pérez"] })[0]).toMatch(/dos variables seguidas/);
  });

  it("cada variable necesita su ejemplo, y dice cuál falta", () => {
    const e = problemas({ body: "Hola {{1}}, tu cita es el {{2}} a las {{3}}.", examples: ["María", "", "10:00"] });
    expect(e[0]).toMatch(/\{\{2\}\}/);
    expect(e[0]).not.toMatch(/\{\{1\}\}/);
  });

  it("el mensaje no puede pasar de 1.024 caracteres", () => {
    expect(problemas({ body: `Hola ${"a".repeat(1100)}`, examples: [] })[0]).toMatch(/1\.024/);
  });

  it("un mensaje sin variables es válido: no todas necesitan huecos", () => {
    expect(problemas({ body: "Seguimos atendiendo de lunes a sábado. ¡Te esperamos!", examples: [] })).toEqual([]);
  });
});

describe("variablesDe", () => {
  it("las devuelve ordenadas y sin repetir", () => {
    expect(variablesDe("Hola {{2}}, {{1}} y otra vez {{2}}.")).toEqual([1, 2]);
    expect(variablesDe("Sin variables")).toEqual([]);
  });
});

describe("vistaPrevia", () => {
  it("rellena con los ejemplos y deja la variable a la vista si falta", () => {
    expect(vistaPrevia("Hola {{1}}, el {{2}}.", ["María"])).toBe("Hola María, el {{2}}.");
  });
});

describe("botones", () => {
  it("hasta tres, y con eso basta", () => {
    expect(problemas({ buttons: ["Confirmar", "Reagendar", "Cancelar"] })).toEqual([]);
    expect(problemas({ buttons: ["Uno", "Dos", "Tres", "Cuatro"] })[0]).toMatch(/3 botones/);
  });

  it("ninguno pasa de 25 caracteres, y dice cuál se pasa", () => {
    const e = problemas({ buttons: ["Confirmar mi cita del sábado por la tarde"] });
    expect(e[0]).toMatch(/25 caracteres/);
    expect(e[0]).toMatch(/Confirmar mi cita/);
  });

  it("no puede haber dos iguales", () => {
    expect(problemas({ buttons: ["Confirmar", "confirmar"] })[0]).toMatch(/mismo texto/);
  });

  it("sin botones también vale: son opcionales", () => {
    expect(problemas({ buttons: [] })).toEqual([]);
  });
});
