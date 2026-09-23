import { describe, expect, it } from "vitest";
import { pareceNombreReal } from "./nombre";

describe("pareceNombreReal", () => {
  it("acepta un nombre y un apellido", () => {
    expect(pareceNombreReal("Luis Padilla")).toBe(true);
    expect(pareceNombreReal("María del Carmen Ríos")).toBe(true);
  });

  it("rechaza lo que la gente pone en su perfil de WhatsApp", () => {
    expect(pareceNombreReal("Luchito 😎")).toBe(false);
    expect(pareceNombreReal("Kimberly")).toBe(false); // solo el nombre: no sirve para buscarlo
    expect(pareceNombreReal("Mototaxi 24h")).toBe(false);
    expect(pareceNombreReal("*.*")).toBe(false);
    expect(pareceNombreReal(null)).toBe(false);
    expect(pareceNombreReal("")).toBe(false);
  });
});
