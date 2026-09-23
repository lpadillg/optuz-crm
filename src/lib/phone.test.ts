import { describe, expect, it } from "vitest";
import { csvCell, normalizePhone, parseTags } from "./phone";

describe("normalizePhone", () => {
  it("añade +51 a un celular peruano de 9 dígitos", () => {
    expect(normalizePhone("987 654 321")).toBe("+51987654321");
  });
  it("respeta el prefijo de país", () => {
    expect(normalizePhone("+51 987-654-321")).toBe("+51987654321");
    expect(normalizePhone("0051987654321")).toBe("+51987654321");
    expect(normalizePhone("+1 (415) 555-2671")).toBe("+14155552671");
  });
  it("rechaza lo que no parece un número", () => {
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("parseTags", () => {
  it("normaliza, deduplica y limita", () => {
    expect(parseTags("VIP, vip ,  Promo  verano,\nlentes")).toEqual(["vip", "promo verano", "lentes"]);
    expect(parseTags("x".repeat(31))).toEqual([]);
  });
});

describe("csvCell", () => {
  it("escapa comillas y comas", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
  });
  it("neutraliza fórmulas de Excel", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+51987654321")).toBe("'+51987654321");
  });
  it("tolera nulos", () => {
    expect(csvCell(null)).toBe("");
  });
});
