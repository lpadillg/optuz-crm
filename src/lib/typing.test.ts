import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { humanPauseMs } from "./typing";

afterEach(() => vi.unstubAllEnvs());

/**
 * El aviso «escribiendo…» de WhatsApp no se puede acortar: se apaga al enviar el mensaje. Lo que se ajusta es
 * cuándo se envía, para que escribir una frase larga parezca costar más que responder «sí».
 */
describe("ritmo humano al responder", () => {
  it("una respuesta larga tarda más en salir que una corta", () => {
    const corta = humanPauseMs("Sí, claro.");
    const larga = humanPauseMs("Hola María, tu evaluación visual gratuita quedó para el martes 29 a las 3 de la tarde en nuestra sucursal de Tingo María.");
    expect(larga).toBeGreaterThan(corta);
  });

  it("nunca responde al instante, aunque sean dos palabras", () => {
    expect(humanPauseMs("Sí")).toBeGreaterThanOrEqual(1200);
  });

  it("ni hace esperar de más por un texto enorme", () => {
    expect(humanPauseMs("a".repeat(4000))).toBeLessThanOrEqual(7000);
  });

  it("lo que ya tardó el modelo cuenta como tiempo escribiendo y se descuenta", () => {
    const sinPensar = humanPauseMs("Una respuesta de tamaño medio para la prueba.");
    const pensando2s = humanPauseMs("Una respuesta de tamaño medio para la prueba.", 2000);
    expect(pensando2s).toBe(Math.max(0, sinPensar - 2000));
  });

  it("si el modelo tardó más de lo que costaría escribirla, se envía ya", () => {
    expect(humanPauseMs("Hola", 30_000)).toBe(0);
  });

  it("el ritmo se puede ajustar sin tocar código", () => {
    const texto = "Una respuesta de tamaño medio para la prueba.";
    vi.stubEnv("TYPING_CHARS_PER_SECOND", "5"); // teclea despacio
    const lento = humanPauseMs(texto);
    vi.stubEnv("TYPING_CHARS_PER_SECOND", "60"); // teclea rapidísimo
    const rapido = humanPauseMs(texto);
    expect(lento).toBeGreaterThan(rapido);
  });

  it("se puede desactivar del todo", () => {
    vi.stubEnv("TYPING_CHARS_PER_SECOND", "0");
    expect(humanPauseMs("Lo que sea")).toBe(0);
  });

  it("los tiempos son creíbles: un saludo sale en ~1,5 s y un párrafo en menos de 7", () => {
    const saludo = humanPauseMs("¡Hola! ¿En qué te ayudo?");
    const parrafo = humanPauseMs(
      "Claro que sí. Tenemos disponible el martes 29 a las 10:00, a las 11:30 y a las 3:00 de la tarde. ¿Cuál te viene mejor?",
    );
    expect(saludo).toBeGreaterThanOrEqual(1200);
    expect(saludo).toBeLessThanOrEqual(2200);
    expect(parrafo).toBeGreaterThan(saludo);
    expect(parrafo).toBeLessThanOrEqual(7000);
  });
});
