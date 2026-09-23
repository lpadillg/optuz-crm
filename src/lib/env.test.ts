import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";

const OPTIONAL = ["BUSINESS_NAME", "BRAND_TONE", "OPENAI_MODEL", "OPENAI_REASONING_EFFORT", "OPENAI_BASE_URL", "META_GRAPH_VERSION", "META_GRAPH_BASE_URL", "GOOGLE_CALENDAR_TIMEZONE"];
const saved = Object.fromEntries(OPTIONAL.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of OPTIONAL) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("variables opcionales", () => {
  it("sin definir o en blanco (`NOMBRE=`) usan el valor por defecto", () => {
    for (const blank of [undefined, "", "   ".trim()]) {
      for (const k of OPTIONAL) {
        if (blank === undefined) delete process.env[k];
        else process.env[k] = blank;
      }
      expect(env.businessName).toBe("Optuz");
      expect(env.brandTone).toContain("cercano");
      expect(env.openaiModel).toBe("gpt-5.6-terra");
      expect(env.openaiReasoningEffort).toBe("medium");
      expect(env.openaiBaseUrl).toBeUndefined();
      expect(env.graphVersion).toBe("v25.0");
      expect(env.graphBaseUrl).toBe("https://graph.facebook.com");
      expect(env.googleCalendarTimezone).toBe("America/Lima");
    }
  });

  it("si se definen, se respetan (y la URL de la Graph API pierde la barra final)", () => {
    process.env.BUSINESS_NAME = "Caddyf Centro Óptico";
    process.env.META_GRAPH_BASE_URL = "http://127.0.0.1:4010/";
    process.env.OPENAI_MODEL = "gpt-5.6-luna";
    process.env.OPENAI_REASONING_EFFORT = "low";
    expect(env.businessName).toBe("Caddyf Centro Óptico");
    expect(env.graphBaseUrl).toBe("http://127.0.0.1:4010");
    expect(env.openaiModel).toBe("gpt-5.6-luna");
    expect(env.openaiReasoningEffort).toBe("low");
  });

  it("un esfuerzo de razonamiento inválido cae al valor por defecto (no rompe la petición)", () => {
    process.env.OPENAI_REASONING_EFFORT = "ultra";
    expect(env.openaiReasoningEffort).toBe("medium");
  });
});

describe("variables obligatorias", () => {
  it("faltantes o en blanco lanzan un error que dice cuál es", () => {
    const saved = process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "";
    expect(() => env.whatsappAccessToken).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    if (saved === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = saved;
  });
});
