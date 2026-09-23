import { describe, expect, it } from "vitest";
import { toTurns } from "./history";

const row = (direction: "in" | "out", content: string, attachments: unknown[] = []) => ({ direction, content, attachments });

describe("toTurns", () => {
  it("alterna user/assistant y trata bot y humano como assistant", () => {
    const turns = toTurns([row("in", "Hola"), row("out", "¡Hola! ¿Qué sucursal?"), row("in", "Tocache")]);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  it("une mensajes consecutivos del mismo rol", () => {
    const turns = toTurns([row("in", "Hola"), row("in", "¿Están abiertos?"), row("out", "Sí")]);
    expect(turns).toHaveLength(2);
    expect(turns[0].content).toBe("Hola\n¿Están abiertos?");
  });

  it("descarta mensajes del asistente al inicio (la conversación empieza por el cliente)", () => {
    const turns = toTurns([row("out", "Bienvenido"), row("in", "Hola")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("user");
  });

  it("un adjunto sin texto se cuenta como mensaje del cliente, diciendo qué envió", () => {
    expect(toTurns([row("in", "", [{ type: "image" }])])[0].content).toBe("[El cliente envió una imagen]");
    expect(toTurns([row("in", "", [{ type: "document" }])])[0].content).toBe("[El cliente envió un documento]");
    expect(toTurns([row("in", "", [{ type: "audio" }])])[0].content).toBe("[El cliente envió una nota de voz]");
    expect(toTurns([row("in", "", [{ foo: 1 }])])[0].content).toContain("archivo adjunto");
  });

  it("ignora mensajes vacíos sin adjuntos y devuelve [] si no queda ninguno del cliente", () => {
    expect(toTurns([row("in", "")])).toEqual([]);
    expect(toTurns([row("out", "Hola")])).toEqual([]);
  });
});
