import { describe, expect, it } from "vitest";
import { isAcknowledgement, isAffirmative, isNegative, isOptInMessage, isPromoOptInMessage, OPT_IN_KEYWORD, PROMO_KEYWORD, REOPT_QUESTION } from "./opt-in";

describe("isOptInMessage (ALTA)", () => {
  it("acepta la palabra clave en cualquier formato", () => {
    for (const t of ["ALTA", "alta", " Alta ", "ALTA.", "¡alta!"]) expect(isOptInMessage(t), t).toBe(true);
    expect(isOptInMessage(OPT_IN_KEYWORD)).toBe(true);
  });

  it("acepta frases inequívocas de volver a recibir mensajes", () => {
    for (const t of ["Reactivar", "quiero volver a recibir mensajes", "Volver a recibir información", "dar de alta", "suscribirme"]) {
      expect(isOptInMessage(t), t).toBe(true);
    }
  });

  it("NO reactiva con frases que solo contienen la palabra", () => {
    for (const t of ["alta calidad", "no quiero volver", "no me den de alta", "hola", "quiero una cita", "dar de baja", "baja", "stop", "", "   "]) {
      expect(isOptInMessage(t), t).toBe(false);
    }
  });
});

describe("isPromoOptInMessage (PROMO)", () => {
  it("acepta la palabra clave y equivalentes inequívocos", () => {
    for (const t of [PROMO_KEYWORD, "promo", " Promociones ", "quiero recibir promociones", "¡PROMO!"]) expect(isPromoOptInMessage(t), t).toBe(true);
  });
  it("no confunde una pregunta con aceptar", () => {
    for (const t of ["hay promociones?", "promo de lentes", "no quiero promociones", "cuál es la promo", "hola"]) expect(isPromoOptInMessage(t), t).toBe(false);
  });
});

describe("respuesta a la pregunta de re-consentimiento", () => {
  it("«sí» y variantes cuentan como aceptar", () => {
    for (const t of ["Sí", "si", "SI.", "Sí, acepto", "acepto", "claro", "dale", "de acuerdo", "Sí, gracias"]) expect(isAffirmative(t), t).toBe(true);
  });
  it("no toma como «sí» una frase que solo lo contiene", () => {
    for (const t of ["no", "sí pero no quiero promociones", "quiero una cita", "no acepto", "hola", ""]) expect(isAffirmative(t), t).toBe(false);
  });
  it("«no» y variantes cuentan como rechazar", () => {
    for (const t of ["No", "no gracias", "NO ACEPTO", "no quiero"]) expect(isNegative(t), t).toBe(true);
    for (const t of ["si", "no sé", "hola"]) expect(isNegative(t), t).toBe(false);
  });
});

describe("isAcknowledgement", () => {
  it("reconoce acuses simples", () => {
    for (const t of ["gracias", "Muchas gracias!", "ok", "listo", "Buenas noches"]) expect(isAcknowledgement(t), t).toBe(true);
    for (const t of ["quiero una cita", "gracias, y el horario?"]) expect(isAcknowledgement(t), t).toBe(false);
  });
});

describe("REOPT_QUESTION", () => {
  it("pide autorización expresa y separa las promociones", () => {
    expect(REOPT_QUESTION).toContain("SÍ");
    expect(REOPT_QUESTION).toContain("PROMO");
    expect(REOPT_QUESTION).toMatch(/autorizaci[oó]n/);
  });
});
