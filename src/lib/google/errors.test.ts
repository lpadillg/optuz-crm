import { describe, expect, it } from "vitest";
import { explainGoogleError } from "./errors";

const SA = "crm@proyecto.iam.gserviceaccount.com";

describe("explainGoogleError", () => {
  it("404 → calendario mal copiado o no compartido, nombrando la cuenta de servicio", () => {
    const m = explainGoogleError({ response: { status: 404 }, message: "Not Found" }, SA);
    expect(m).toMatch(/No encuentro ese calendario/);
    expect(m).toContain(SA);
  });

  it("freebusy con notFound (llega como texto) también es «no compartido»", () => {
    expect(explainGoogleError(new Error("freebusy abc@group.calendar.google.com: notFound"), SA)).toMatch(/No encuentro ese calendario/);
  });

  it("403 de escritura → hay que dar permiso «Hacer cambios en eventos»", () => {
    const m = explainGoogleError({ response: { status: 403, data: { error: { message: "Forbidden", errors: [{ reason: "forbiddenForNonOrganizer" }] } } } }, SA);
    expect(m).toMatch(/Hacer cambios en eventos/);
    expect(explainGoogleError({ message: "Write access required", response: { status: 403 } }, SA)).toMatch(/Hacer cambios en eventos/);
  });

  it("API sin habilitar → indica cómo habilitarla", () => {
    const m = explainGoogleError({ response: { status: 403, data: { error: { message: "Google Calendar API has not been used in project 123 before or it is disabled." } } } });
    expect(m).toMatch(/Habilitar/);
  });

  it("credenciales inválidas → pide una clave nueva", () => {
    expect(explainGoogleError({ message: "invalid_grant: Invalid JWT Signature." })).toMatch(/clave/);
    expect(explainGoogleError({ message: "error:1E08010C:DECODER routines::unsupported" })).toMatch(/clave/);
    expect(explainGoogleError({ response: { status: 401 } })).toMatch(/rechaz/);
  });

  it("errores de red", () => {
    expect(explainGoogleError({ message: "getaddrinfo ENOTFOUND www.googleapis.com" })).toMatch(/conectar con Google/);
  });

  it("lo desconocido conserva el mensaje original", () => {
    expect(explainGoogleError(new Error("algo raro"))).toContain("algo raro");
  });
});
