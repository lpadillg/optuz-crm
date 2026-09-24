import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El flujo de la cita, paso a paso y sin modelo de por medio.
 *
 * Lo que se fija aquí es lo que antes fallaba por la redacción: que cada paso salga SIEMPRE igual, que las
 * respuestas del cliente se reconozcan porque son las opciones que ofrecimos, y que quien pregunta otra cosa
 * no quede atrapado en el guion.
 */
const h = vi.hoisted(() => {
  const state = {
    borrador: null as Record<string, unknown> | null,
    branchRow: { id: "b-huanuco" } as { id: string } | null,
    libres: [] as string[],
    proximos: [] as string[],
    guardados: [] as (Record<string, unknown> | null)[],
  };
  function builder(table: string) {
    const q = { table, op: "select", payload: undefined as unknown };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => {
        q.op = "update";
        q.payload = p;
        if (table === "conversations" && "cita" in p) state.guardados.push(p.cita as Record<string, unknown> | null);
        return b;
      },
      eq: () => b,
      maybeSingle: () =>
        Promise.resolve({
          data: table === "conversations" ? { cita: state.borrador } : table === "branches" ? state.branchRow : null,
          error: null,
        }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
    };
    return b;
  }
  return {
    state,
    db: { from: builder },
    sendBotOptions: vi.fn(),
    sendBotText: vi.fn(),
    bookAppointment: vi.fn(async () => ({ appointmentId: "a1", branch: { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" } })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/outbound", () => ({ sendBotOptions: h.sendBotOptions, sendBotText: h.sendBotText }));
vi.mock("@/lib/appointments", () => ({
  bookAppointment: h.bookAppointment,
  BookingError: class extends Error { constructor(public code: string, m: string) { super(m); } },
  getAvailableSlots: async () => h.state.libres,
  findNextSlots: async () => h.state.proximos,
}));

import { conducirCita, diaElegido, franjaElegida, horaElegida, horaPedida, pideCita, proximosDias, tiendaNombrada } from "./flujo-cita";

const TIENDAS = [
  { nombre: "Huánuco", direccion: "Jr. 28 de Julio 1131" },
  { nombre: "Tingo María", direccion: "Av. Tito Jaime 343" },
];

const conducir = (texto: string, extra: Record<string, unknown> = {}) =>
  conducirCita({
    conversationId: "c1",
    leadId: "l1",
    branchId: null,
    branchNombre: null,
    texto,
    tiendas: TIENDAS,
    ...extra,
  });

const ultimasOpciones = () => h.sendBotOptions.mock.calls.at(-1);
const ultimoTexto = () => h.sendBotText.mock.calls.at(-1);

beforeEach(() => {
  h.state.borrador = null;
  h.state.branchRow = { id: "b-huanuco" };
  h.state.libres = [];
  h.state.proximos = [];
  h.state.guardados = [];
  h.sendBotOptions.mockReset();
  h.sendBotText.mockReset();
  h.bookAppointment.mockClear();
});

describe("reconocer lo que dice el cliente", () => {
  it("sabe cuándo alguien pide cita y cuándo pregunta otra cosa", () => {
    expect(pideCita("quiero una cita")).toBe(true);
    expect(pideCita("necesito agendar")).toBe(true);
    expect(pideCita("¿cuánto cuesta?")).toBe(false);
    expect(pideCita("¿dónde están?")).toBe(false);
  });

  it("reconoce la tienda tocada, escrita o sin tildes", () => {
    expect(tiendaNombrada("Huánuco", TIENDAS)?.nombre).toBe("Huánuco");
    expect(tiendaNombrada("Sí, en Huánuco", TIENDAS)?.nombre).toBe("Huánuco");
    expect(tiendaNombrada("huanuco", TIENDAS)?.nombre).toBe("Huánuco");
  });

  it("los días que ofrece son los suyos, y nunca un domingo", () => {
    const dias = proximosDias(new Date("2026-09-25T12:00:00-05:00")); // viernes
    expect(dias.map((d) => d.etiqueta)).toEqual(["Hoy", "Mañana", "Lunes 28"]); // el domingo 27 se salta
    // Los botones de WhatsApp admiten 20 caracteres: el día escrito entero cabe de sobra.
    expect(Math.max(...dias.map((d) => d.etiqueta.length))).toBeLessThanOrEqual(20);
    expect(diaElegido("Mañana", dias)).toBe("2026-09-26");
    expect(diaElegido("el jueves que viene", dias)).toBeNull();
  });

  it("pasada la hora de cierre, «Hoy» deja de ofrecerse", async () => {
    // A las 21:00 no queda ni un horario: ofrecerlo lleva a tocar un día vacío.
    const tarde = proximosDias(new Date("2026-09-23T21:00:00-05:00"));
    expect(tarde[0].etiqueta).toBe("Mañana");
    // Y en horario de atención sí se ofrece.
    const media = proximosDias(new Date("2026-09-23T10:00:00-05:00"));
    expect(media[0].etiqueta).toBe("Hoy");
  });

  it("«Mañana» tocando el botón del día es el DÍA, no la parte del día", async () => {
    // Las dos cosas se llaman igual en español. Confundirlas le saltaba un paso al cliente y le ofrecía
    // horarios de una franja que nunca eligió.
    h.state.borrador = { sucursal: "Huánuco" };
    h.state.libres = ["2026-09-26T13:00:00.000Z"];
    await conducir("Mañana");
    expect(ultimasOpciones()?.[2]).toEqual(["En la mañana", "En la tarde"]);
  });

  it("distingue la franja", () => {
    expect(franjaElegida("En la mañana")).toBe("mañana");
    expect(franjaElegida("En la tarde")).toBe("tarde");
    expect(franjaElegida("mejor el jueves")).toBeNull();
  });

  it("reconoce la hora solo si es una de las ofrecidas", () => {
    const opciones = ["2026-09-26T13:00:00.000Z", "2026-09-26T14:00:00.000Z"]; // 8 y 9 am en Lima
    expect(horaElegida("8:00 am", opciones)).toBe(opciones[0]);
    expect(horaElegida("a las 11", opciones)).toBeNull();
  });
});

describe("los cinco pasos, en orden", () => {
  it("1) pedir cita saca la lista de tiendas", async () => {
    const r = await conducir("Hola, quiero una cita");
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[1]).toContain("¿Cuál sucursal te queda más cerca?");
  });

  it("2) elegida la tienda, pregunta el día", async () => {
    h.state.borrador = {};
    const r = await conducir("Huánuco");
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[1]).toContain("¿Qué día te viene bien?");
  });

  it("3) elegido el día, pregunta mañana o tarde", async () => {
    h.state.borrador = { sucursal: "Huánuco" };
    const dias = proximosDias();
    const r = await conducir(dias[1].etiqueta);
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[2]).toEqual(["En la mañana", "En la tarde"]);
  });

  it("4) elegida la franja, ofrece los horarios reales", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26" };
    h.state.libres = ["2026-09-26T13:00:00.000Z", "2026-09-26T14:00:00.000Z"];
    const r = await conducir("En la mañana");
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[2]).toHaveLength(2);
  });

  it("5) elegida la hora, pregunta a nombre de quién", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "mañana" };
    h.state.libres = ["2026-09-26T13:00:00.000Z"];
    const r = await conducir("8:00 am", { nombreCliente: "Luis Padilla" });
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[1]).toContain("¿La cita es para ti");
  });

  it("6) con el nombre, la agenda y lo confirma", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "mañana", hora: "2026-09-26T13:00:00.000Z" };
    const r = await conducir("Rosa Quispe Flores");
    expect(r.atendido).toBe(true);
    expect(h.bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ pacienteNombre: "Rosa Quispe Flores" }));
    expect(ultimoTexto()?.[1]).toContain("¡Listo!");
    // El borrador se borra: la cita ya no se está armando.
    expect(h.state.guardados.at(-1)).toBeNull();
  });
});

describe("salirse del guion", () => {
  it("una pregunta a media cita la responde el modelo, sin perder lo reunido", async () => {
    h.state.borrador = { sucursal: "Huánuco" };
    const r = await conducir("¿la evaluación tiene costo?");
    expect(r.atendido).toBe(false);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
    expect(h.state.guardados.at(-1)).toMatchObject({ sucursal: "Huánuco" });
  });

  it("quien no está agendando no entra al flujo", async () => {
    const r = await conducir("¿atienden los domingos?");
    expect(r.atendido).toBe(false);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
  });
});

describe("cuando no hay cupo", () => {
  it("no dice «no hay»: ofrece los horarios reales de los días siguientes", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "tarde" };
    h.state.libres = [];
    h.state.proximos = ["2026-09-28T19:00:00.000Z"];
    const r = await conducir("En la tarde");
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[1]).toContain("más próximos");
  });

  it("si tampoco hay en los días siguientes, propone la otra parte del día", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "tarde" };
    h.state.libres = [];
    h.state.proximos = [];
    const r = await conducir("En la tarde");
    expect(r.atendido).toBe(true);
    expect(ultimoTexto()?.[1]).toContain("otra parte del día");
  });
});

describe("volver a empezar", () => {
  it("pedir cita otra vez a medio armar olvida lo anterior y vuelve a la sucursal", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "mañana" };
    const r = await conducir("Quiero una cita");
    expect(r.atendido).toBe(true);
    expect(ultimasOpciones()?.[1]).toContain("¿Cuál sucursal te queda más cerca?");
  });
});

/**
 * Que los mensajes los escriba el código no los condena a sonar a formulario. Cada paso repite lo que el
 * cliente acaba de elegir: así ve que quedó registrado y la conversación sigue pareciendo una conversación.
 */
describe("los pasos reconocen lo que el cliente eligió", () => {
  it("al preguntar el día, nombra la tienda que acaba de elegir", async () => {
    h.state.borrador = {};
    await conducir("Huánuco");
    expect(ultimasOpciones()?.[1]).toContain("Huánuco");
  });

  it("al preguntar la franja, nombra el día", async () => {
    h.state.borrador = { sucursal: "Huánuco" };
    const dias = proximosDias();
    await conducir(dias[1].etiqueta);
    const texto = ultimasOpciones()?.[1] as string;
    expect(texto).toMatch(/Anotado, el/);
  });

  it("al pedir el nombre, dice la hora que acaba de elegir", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "mañana" };
    h.state.libres = ["2026-09-26T13:00:00.000Z"];
    await conducir("8:00 am", { nombreCliente: "Luis Padilla" });
    expect(ultimasOpciones()?.[1]).toContain("8:00 am");
  });
});

/**
 * Lo que rompía la conversación: un saludo tomado por una respuesta. Alguien escribía «buenas noches» y se le
 * contestaba «¡Perfecto, te agendo en Tingo María! ¿Qué día te viene bien?», retomando una cita de horas
 * antes que él ya no tenía en la cabeza.
 */
describe("saludar no es responder", () => {
  it("un saludo a media cita no avanza el flujo: contesta el modelo", async () => {
    h.state.borrador = { sucursal: "Tingo María", desde: new Date().toISOString() };
    const r = await conducir("Buenas noches");
    expect(r.atendido).toBe(false);
    expect(h.sendBotOptions).not.toHaveBeenCalled();
  });

  it("un borrador de hace horas caduca: no se retoma", async () => {
    h.state.borrador = { sucursal: "Tingo María", desde: new Date(Date.now() - 5 * 3600_000).toISOString() };
    const r = await conducir("¿cuánto cuesta el examen?");
    expect(r.atendido).toBe(false);
    // Y se limpia, para que el siguiente mensaje empiece de cero.
    expect(h.state.guardados.at(-1)).toBeNull();
  });

  it("al retomar no se le atribuye una elección que no hizo", async () => {
    h.state.borrador = { sucursal: "Tingo María", desde: new Date().toISOString() };
    await conducir("quiero agendar");
    // Vuelve a empezar por la sucursal, sin el «¡Perfecto, te agendo en…!».
    expect(h.sendBotOptions.mock.calls.at(-1)?.[1]).toContain("¿Cuál sucursal te queda más cerca?");
  });
});

describe("«En otra tienda»", () => {
  it("no vuelve a proponer la misma: enseña todas", async () => {
    // Sin esto se quedaba en bucle, ofreciendo una y otra vez la tienda que el cliente acababa de rechazar.
    h.state.borrador = { desde: new Date().toISOString() };
    const r = await conducir("En otra tienda", { branchNombre: "Tingo María", branchId: "b-tingo" });
    expect(r.atendido).toBe(true);
    const [, texto, opciones] = h.sendBotOptions.mock.calls.at(-1)!;
    expect(texto).toContain("¿Cuál sucursal te queda más cerca?");
    expect((opciones as { title: string }[]).length).toBe(TIENDAS.length);
  });

  it("y si luego elige una, se queda con esa", async () => {
    h.state.borrador = { desde: new Date().toISOString(), otraTienda: true };
    await conducir("Huánuco", { branchNombre: "Tingo María", branchId: "b-tingo" });
    expect(h.sendBotOptions.mock.calls.at(-1)?.[1]).toContain("¿Qué día te viene bien?");
  });
});

/**
 * Solo se enseñan tres botones aunque haya más huecos, así que quien quiere otra hora la escribe a mano. Si no
 * se reconoce, se le repite la misma lista y se queda pulsando sin que nadie conteste a lo que preguntó.
 */
describe("la hora escrita a mano", () => {
  it("se entiende como la escriba", () => {
    const seisTarde = 18 * 60;
    expect(horaPedida("6pm")).toBe(seisTarde);
    expect(horaPedida("plan 6pm")).toBe(seisTarde);
    expect(horaPedida("a las 6")).toBe(seisTarde);
    expect(horaPedida("18:00")).toBe(seisTarde);
    expect(horaPedida("6 de la tarde")).toBe(seisTarde);
    expect(horaPedida("6:30 pm")).toBe(18 * 60 + 30);
    expect(horaPedida("9 am")).toBe(9 * 60);
    expect(horaPedida("el sábado")).toBeNull();
  });

  it("si esa hora está libre, se toma aunque no fuera uno de los botones", async () => {
    // 2, 3 y 4 pm se ofrecen; las 6 existe pero no se mostró.
    const libres = ["2026-09-26T19:00:00.000Z", "2026-09-26T23:00:00.000Z"]; // 2 pm y 6 pm en Lima
    expect(horaElegida("plan 6pm", libres)).toBe(libres[1]);
  });

  it("si no hay cupo a esa hora, se dice en vez de repetir la lista", async () => {
    h.state.borrador = { sucursal: "Huánuco", fecha: "2026-09-26", franja: "tarde", desde: new Date().toISOString() };
    h.state.libres = ["2026-09-26T19:00:00.000Z"]; // solo las 2 pm
    await conducir("plan 6pm");
    expect(h.sendBotOptions.mock.calls.at(-1)?.[1]).toContain("ya no me queda cupo");
  });
});
