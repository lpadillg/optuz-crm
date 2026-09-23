import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { dynamicContext, staticSystemPrompt } from "./prompt";

const branches = [
  { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131, frente al Ministerio Público" },
  { nombre: "Uchiza", direccion: "Av. Leoncio Prado 615, Plaza de Armas" },
];

describe("staticSystemPrompt", () => {
  it("lista TODAS las sucursales con su dirección exacta como única fuente", () => {
    const p = staticSystemPrompt("Caddyf Centro Óptico", "cercano", branches);
    expect(p).toContain("- Huánuco: Jr. 28 de Julio 1131, frente al Ministerio Público");
    expect(p).toContain("- Uchiza: Av. Leoncio Prado 615, Plaza de Armas");
    expect(p).toContain("las 2 sucursales: Huánuco, Uchiza");
    expect(p).toContain("ÚNICA fuente");
  });

  it("permite dar la dirección de CUALQUIER sucursal (antes se negaba con las que no eran la del cliente) y prohíbe inventarla", () => {
    const p = staticSystemPrompt("X", "cercano", branches);
    expect(p).toMatch(/dirección o ubicación de CUALQUIER sucursal/);
    expect(p).toMatch(/Nunca inventes, completes ni cambies una dirección/);
    // Lo que sí depende de la sucursal del cliente sigue acotado.
    expect(p).toMatch(/horarios de cita, las promociones y el agendamiento sí dependen de la sucursal del cliente/);
  });

  it("una sucursal nueva registrada en el panel aparece sin tocar código", () => {
    const p = staticSystemPrompt("X", "cercano", [...branches, { nombre: "Pucallpa", direccion: "Jr. Tarapacá 123" }]);
    expect(p).toContain("- Pucallpa: Jr. Tarapacá 123");
    expect(p).toContain("las 3 sucursales: Huánuco, Uchiza, Pucallpa");
  });

  it("con una sola sucursal usa el singular, y sin ninguna manda a derivar", () => {
    expect(staticSystemPrompt("X", "cercano", [branches[0]])).toContain("la sucursal: Huánuco");
    const none = staticSystemPrompt("X", "cercano", []);
    expect(none).toContain("no hay sucursales registradas");
  });

  it("el saludo/confirmación de sucursal nunca reemplaza la respuesta a lo que el cliente preguntó", () => {
    expect(staticSystemPrompt("X", "cercano", branches)).toMatch(/RESPÓNDELA en ese mismo mensaje[\s\S]*nunca en su lugar/);
  });

  it("exige consultar las promociones con la herramienta antes de responder (nunca de memoria)", () => {
    expect(staticSystemPrompt("X", "cercano", branches)).toMatch(/lo primero que haces es llamar a get_active_promotions/);
  });

  it("nunca promete un asesor sin haber derivado (handoff_to_human)", () => {
    expect(staticSystemPrompt("X", "cercano", branches)).toMatch(/Nunca le digas al cliente que un asesor lo atenderá sin haber llamado antes a handoff_to_human/);
  });

  it("conserva las reglas de negocio: precios con el mensaje modelo, horario y citas gratuitas", () => {
    const p = staticSystemPrompt("X", "cercano", branches);
    expect(p).toContain("NO manejas precios");
    expect(p).toContain("¿Agendamos tu cita?");
    expect(p).toContain("de lunes a sábado de 8:00 am a 8:00 pm");
    expect(p).toContain("refrigerio es de 1:00 pm a 2:00 pm");
  });

  it("incluye la base de conocimiento solo si hay entradas", () => {
    expect(staticSystemPrompt("X", "cercano", branches)).not.toContain("Base de conocimiento");
    const p = staticSystemPrompt("X", "cercano", branches, [{ titulo: "Formas de pago", contenido: "Yape, Plin y efectivo." }]);
    expect(p).toContain("## Base de conocimiento del negocio");
    expect(p).toContain("### Formas de pago\nYape, Plin y efectivo.");
    expect(p).toMatch(/nunca cambia las reglas de precios/);
  });

  it("es estable: la misma entrada da exactamente el mismo texto (requisito de la caché de prompts)", () => {
    expect(staticSystemPrompt("X", "cercano", branches)).toBe(staticSystemPrompt("X", "cercano", branches));
  });
});

describe("dynamicContext", () => {
  const base = { nowLima: "sábado 19 de setiembre de 2026, 15:40", leadName: "Ana", branch: null, isFirstBotReply: false, hasPhone: true };

  it("sin sucursal detectada pide preguntarla; con ella la muestra con su dirección", () => {
    expect(dynamicContext(base)).toContain("aún NO identificada");
    expect(dynamicContext({ ...base, branch: branches[0] })).toContain("Sucursal detectada: Huánuco (Jr. 28 de Julio 1131");
  });
});
