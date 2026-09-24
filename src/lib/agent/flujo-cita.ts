import "server-only";
import { bookAppointment, BookingError, findNextSlots, getAvailableSlots } from "@/lib/appointments";
import { sendBotOptions, sendBotText } from "@/lib/outbound";
import { pareceNombreReal } from "@/lib/nombre";
import { createAdminClient } from "@/lib/supabase/admin";
import { cargarMensajes } from "./mensajes";
import { BUSINESS_HOURS } from "@/lib/google/slots";
import { addDays, formatLima, formatLimaTime, horaCorta, limaDateString } from "@/lib/time";

/**
 * El flujo de una cita, llevado por el código.
 *
 * Agendar tiene cinco datos y un orden: sucursal, día, franja, hora y a nombre de quién. No hay nada
 * creativo. Pedírselos al modelo y luego adivinar, leyendo su texto, en qué paso cree estar, obliga a
 * reconocer infinitas maneras de decir lo mismo: en una tarde falló por una tilde, por un signo de
 * interrogación que faltaba y por mencionar el día en la misma frase.
 *
 * Aquí el paso siguiente se decide mirando qué falta en el borrador, la pregunta sale siempre con botones y
 * las respuestas se reconocen porque son las opciones que ofrecimos nosotros. El cliente puede salirse cuando
 * quiera —preguntar por la garantía o los precios— y entonces contesta el modelo sin perder lo ya reunido.
 */

const normal = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Lo que llevamos reunido de la cita que se está armando. */
export interface Borrador {
  /** Cuándo se tocó por última vez, en ISO. Un borrador viejo no se retoma: se empieza de cero. */
  desde?: string;
  /** Dijo que quiere otra tienda distinta a la que tenía guardada: hay que enseñarle todas. */
  otraTienda?: boolean;
  sucursal?: string;
  /** "YYYY-MM-DD" en hora de Lima. */
  fecha?: string;
  franja?: "mañana" | "tarde";
  /** Inicio exacto, en ISO. */
  hora?: string;
  paciente?: string;
}

export interface Tienda {
  nombre: string;
  direccion: string;
}

export interface PromoVigente {
  titulo: string;
  enTodas: boolean;
}

/** Cuántos días se ofrecen para elegir. Tres botones es lo que cabe sin que WhatsApp los convierta en lista. */
const DIAS_OFRECIDOS = 3;

/**
 * Cuánto se guarda una cita a medias. Pasado ese rato, quien vuelve a escribir empieza de nuevo: retomar un
 * borrador de ayer hace que a un «buenas noches» se le conteste «¿qué día te viene bien?», como si la
 * conversación no hubiera parado nunca.
 */
const CADUCA_EN_MS = 3 * 60 * 60 * 1000;

const PIDE_CITA =
  /\b(quiero|necesito|deseo|quisiera|me gustaria|puedo|podria|queria)\b[^.?!]{0,40}\b(cita|agendar|reservar|separar|evaluacion|examen)\b|^\s*(agendar|cita|quiero mi cita|separar cita)\b/;
const MENCIONA_PROMO = /\b(2x1|2 x 1|promo|promocion|oferta|publicidad|anuncio|descuento)\b/;
/** Frases con las que alguien se baja del flujo: ya no está eligiendo, está preguntando otra cosa. */
const SE_SALE = /\?|\b(cuanto|precio|cuesta|garantia|reparar|direccion|donde|como llego|horario|abren|cierran)\b/;

/** «En otra tienda»: la opcion que se ofrece junto a la sucursal de siempre. */
const QUIERE_OTRA_TIENDA = /^(en otra tienda|otra tienda|en otra|otra|no|cambiar de tienda|otra sucursal)$/;

export const pideCita = (texto: string) => PIDE_CITA.test(normal(texto));
export const vinoPorLaPromo = (texto: string) => MENCIONA_PROMO.test(normal(texto));

/** Los próximos días con atención, con la etiqueta que verá el cliente. Domingo no se ofrece: está cerrado. */
export function proximosDias(desde = new Date(), cuantos = DIAS_OFRECIDOS): { fecha: string; etiqueta: string }[] {
  const hoy = limaDateString(desde);
  const dias: { fecha: string; etiqueta: string }[] = [];
  // Pasada la última hora a la que se puede empezar una cita, «Hoy» ya no es una opción: ofrecerlo lleva al
  // cliente a tocar un día en el que no le va a salir ni un horario.
  const horaLima = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", hour: "2-digit", hour12: false }).format(desde),
  );
  const desdeI = horaLima >= BUSINESS_HOURS.closeHour - 1 ? 1 : 0;
  for (let i = desdeI; dias.length < cuantos && i < 10 + desdeI; i++) {
    const fecha = addDays(hoy, i);
    const d = new Date(`${fecha}T12:00:00-05:00`);
    if (d.getUTCDay() === 0) continue; // domingo cerrado
    const nombre = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "short", day: "numeric" })
      .format(d)
      .replace(".", "");
    dias.push({ fecha, etiqueta: i === 0 ? "Hoy" : i === 1 ? "Mañana" : nombre });
  }
  return dias;
}

/** La tienda que el cliente nombró, si nombró alguna (tocando la opción o escribiéndola). */
export function tiendaNombrada(texto: string, tiendas: Tienda[]): Tienda | null {
  const t = normal(texto);
  return tiendas.find((s) => t.includes(normal(s.nombre))) ?? null;
}

/** El día que eligió, si es una de las opciones que le ofrecimos. */
export function diaElegido(texto: string, dias: { fecha: string; etiqueta: string }[]): string | null {
  const t = normal(texto);
  return dias.find((d) => t === normal(d.etiqueta) || t.includes(normal(d.etiqueta)))?.fecha ?? null;
}

export function franjaElegida(texto: string): "mañana" | "tarde" | null {
  const t = normal(texto);
  if (/\bmanana\b/.test(t) && /\ben la manana\b|^manana$|por la manana/.test(t)) return "mañana";
  if (/\btarde\b/.test(t)) return "tarde";
  return null;
}

/** La hora que eligió, si es uno de los horarios que le ofrecimos. */
export function horaElegida(texto: string, opciones: string[]): string | null {
  const t = normal(texto).replace(/\s+/g, " ");
  return opciones.find((iso) => t.includes(normal(formatLimaTime(new Date(iso))).replace(/\s+/g, " "))) ?? null;
}

/**
 * El borrador en curso, o null si no hay ninguno. La diferencia importa: un borrador VACÍO significa que la
 * cita ya empezó —se le acaba de preguntar la sucursal— y lo siguiente que escriba es su respuesta, no una
 * petición nueva. Confundir los dos casos dejaba al cliente respondiendo a una pregunta que nadie recogía.
 */
async function leerBorrador(conversationId: string): Promise<Borrador | null> {
  const { data } = await createAdminClient().from("conversations").select("cita").eq("id", conversationId).maybeSingle();
  return (data?.cita as Borrador | null) ?? null;
}

async function guardarBorrador(conversationId: string, cita: Borrador | null): Promise<void> {
  const conFecha = cita ? { ...cita, desde: new Date().toISOString() } : null;
  await createAdminClient().from("conversations").update({ cita: conFecha }).eq("id", conversationId);
}

export type Resultado = { atendido: true; detalle: string } | { atendido: false; detalle?: string };

export interface Entrada {
  conversationId: string;
  leadId: string;
  /** Sucursal guardada del lead (de otras veces). */
  branchId: string | null;
  branchNombre: string | null;
  texto: string;
  tiendas: Tienda[];
  nombreCliente?: string | null;
  promo?: PromoVigente | null;
}

/**
 * Lleva la cita un paso más. Devuelve `atendido: true` cuando ya respondió al cliente (y entonces no se llama
 * al modelo) y `false` cuando no le toca: o no está agendando, o el cliente preguntó otra cosa.
 */
export async function conducirCita(e: Entrada): Promise<Resultado> {
  const { conversationId, leadId, texto, tiendas } = e;
  if (tiendas.length === 0) return { atendido: false };

  const db = createAdminClient();
  // Los textos salen del panel: el tono con el que se le habla al cliente lo decide el negocio.
  const msg = await cargarMensajes();
  const guardado = await leerBorrador(conversationId);
  const vigente = guardado !== null && (!guardado.desde || Date.now() - new Date(guardado.desde).getTime() < CADUCA_EN_MS);
  const enMarcha = guardado !== null && vigente;
  let borrador: Borrador = enMarcha ? guardado! : {};
  if (guardado && !vigente) await guardarBorrador(conversationId, null); // caducó: se empieza de cero

  // ── ¿Empieza una cita? ──
  if (!enMarcha && !pideCita(texto)) return { atendido: false };

  // Un saludo no es una respuesta: quien escribe «buenas noches» no acaba de elegir nada. Avanzar el flujo
  // con eso le contestaba «¡Perfecto, te agendo en Tingo María! ¿Qué día te viene bien?» a alguien que solo
  // había saludado.
  if (enMarcha && esSaludoSuelto(texto)) return { atendido: false, detalle: "solo saludó: responde el modelo" };

  // Volver a pedir cita a medio armar es empezar de cero: puede querer otro día, otra tienda o que sea para
  // otra persona. Seguir reclamando el dato que faltaba es no leer lo que la persona acaba de escribir.
  if (enMarcha && pideCita(texto)) borrador = {};

  // ── Recoger lo que acaba de decir, si es una de nuestras opciones ──
  const tienda = tiendaNombrada(texto, tiendas);
  if (tienda) {
    borrador.sucursal = tienda.nombre;
    borrador.otraTienda = undefined;
  } else if (QUIERE_OTRA_TIENDA.test(normal(texto))) {
    // Tocó «En otra tienda»: no vale volver a proponerle la de siempre, hay que enseñarle todas. Sin esto se
    // quedaba en bucle, ofreciéndole una y otra vez la tienda que acababa de rechazar.
    borrador.otraTienda = true;
  }

  const dias = proximosDias();
  const dia = diaElegido(texto, dias);
  if (dia) borrador.fecha = dia;

  // «Mañana» es el día siguiente Y una parte del día. Si el cliente tocó el botón del día, eso es lo que
  // quiso decir: tomarlo por la franja le saltaba un paso y le ofrecía horarios de una parte del día que
  // nunca eligió.
  const tocoElDia = dia !== null && normal(texto) === normal(dias.find((d) => d.fecha === dia)!.etiqueta);
  const franja = tocoElDia ? null : franjaElegida(texto);
  if (franja) borrador.franja = franja;

  // ── Si preguntó otra cosa, se baja del guion: contesta el modelo y el borrador espera ──
  const eligioAlgo = !!tienda || !!dia || !!franja;
  if (!eligioAlgo && enMarcha && SE_SALE.test(normal(texto))) {
    await guardarBorrador(conversationId, borrador);
    return { atendido: false, detalle: "el cliente preguntó otra cosa: responde el modelo" };
  }

  // ── Paso 1: la sucursal ──
  if (!borrador.sucursal) {
    // La guardada de otras veces no vale sin confirmar: la gente se muda, viaja o pregunta por otra tienda.
    const nombre = e.nombreCliente?.trim().split(/\s+/)[0];
    const saludo = nombre ? msg("cita:saludo", { nombre }) : "¡Con gusto!";
    const porLaPromo =
      e.promo && vinoPorLaPromo(texto)
        ? ` ${msg("cita:promo", { promo: e.promo.titulo, alcance: e.promo.enTodas ? " en todas nuestras tiendas" : "" })}`
        : "";
    await guardarBorrador(conversationId, borrador);

    if (e.branchNombre && !borrador.otraTienda) {
      await sendBotOptions(
        conversationId,
        `${saludo}${porLaPromo}\n\n¿Te agendo en nuestra tienda de *${e.branchNombre}*?`,
        [`Sí, en ${e.branchNombre}`.slice(0, 20), "En otra tienda"],
        { kind: "cita:sucursal" },
      );
      return { atendido: true, detalle: "paso 1: confirmar sucursal" };
    }
    await sendBotOptions(
      conversationId,
      `${saludo}${porLaPromo}\n\n${msg("cita:sucursal")}`,
      tiendas.map((t) => ({ title: t.nombre, description: t.direccion })),
      { kind: "cita:sucursal" },
    );
    return { atendido: true, detalle: "paso 1: elegir sucursal" };
  }

  // A partir de aquí hace falta el id de la sucursal elegida.
  const { data: sede } = await db.from("branches").select("id").eq("nombre", borrador.sucursal).maybeSingle();
  const branchId = (sede?.id as string) ?? null;
  if (!branchId) {
    borrador = {};
    await guardarBorrador(conversationId, null);
    return { atendido: false, detalle: "la sucursal del borrador ya no existe" };
  }
  if (branchId !== e.branchId) await db.from("leads").update({ branch_id: branchId }).eq("id", leadId);

  // ── Paso 2: el día ──
  if (!borrador.fecha) {
    await guardarBorrador(conversationId, borrador);
    // Cada paso repite lo que el cliente acaba de elegir: así ve que quedó registrado y la conversación no
    // suena a formulario. Preguntar a secas «¿qué día?» es correcto y frío a la vez.
    // El «¡Perfecto, te agendo en X!» solo vale si ACABA de elegirla: dicho al retomar, le atribuye al cliente
    // una decisión que no tomó en ese mensaje.
    const clave = tienda ? "cita:dia" : "cita:dia-retomar";
    await sendBotOptions(conversationId, msg(clave, { sucursal: borrador.sucursal }), dias.map((d) => d.etiqueta), {
      kind: "cita:dia",
    });
    return { atendido: true, detalle: "paso 2: elegir día" };
  }

  // ── Paso 3: mañana o tarde ──
  if (!borrador.franja) {
    await guardarBorrador(conversationId, borrador);
    await sendBotOptions(
      conversationId,
      msg("cita:franja", { dia: diaLargo(borrador.fecha) }),
      ["En la mañana", "En la tarde"],
      { kind: "cita:franja" },
    );
    return { atendido: true, detalle: "paso 3: elegir franja" };
  }

  // ── Paso 4: la hora ──
  const libres = await getAvailableSlots(branchId, borrador.fecha, 30, borrador.franja);
  if (!borrador.hora) {
    const elegida = horaElegida(texto, libres);
    if (elegida) {
      borrador.hora = elegida;
    } else {
      await guardarBorrador(conversationId, borrador);
      if (libres.length === 0) {
        // Sin cupo ese día y franja: se ofrecen los siguientes huecos reales en vez de un «no hay».
        const proximos = await findNextSlots(branchId, addDays(borrador.fecha, 1), 3, 7, 30, borrador.franja);
        if (proximos.length === 0) {
          await sendBotText(
            conversationId,
            msg("cita:sin-cupo", { franja: borrador.franja }),
            { kind: "cita:sin-cupo" },
          );
          borrador.franja = undefined;
          await guardarBorrador(conversationId, borrador);
          return { atendido: true, detalle: "paso 4: sin cupo, se reabre la franja" };
        }
        borrador.fecha = limaDateString(new Date(proximos[0]));
        await guardarBorrador(conversationId, borrador);
        await sendBotOptions(
          conversationId,
          msg("cita:hora-otro-dia", { franja: borrador.franja }),
          proximos.map((s) => formatLimaTime(new Date(s))),
          { kind: "cita:hora" },
        );
        return { atendido: true, detalle: "paso 4: horarios de otro día" };
      }
      await sendBotOptions(
        conversationId,
        msg("cita:hora", { dia: diaLargo(borrador.fecha), franja: borrador.franja }),
        libres.slice(0, 3).map((s) => formatLimaTime(new Date(s))),
        { kind: "cita:hora" },
      );
      return { atendido: true, detalle: "paso 4: elegir hora" };
    }
  }

  // ── Paso 5: a nombre de quién ──
  if (!borrador.paciente) {
    const posible = texto.trim();
    if (pareceNombreReal(posible)) {
      borrador.paciente = posible;
    } else {
      await guardarBorrador(conversationId, borrador);
      const suyo = e.nombreCliente?.trim();
      if (suyo && pareceNombreReal(suyo)) {
        await sendBotOptions(
          conversationId,
          msg("cita:paciente-confirmar", { hora: horaCorta(formatLimaTime(new Date(borrador.hora!))), nombre: suyo }),
          [`Sí, ${suyo}`.slice(0, 20), "Es para otra persona"],
          { kind: "cita:paciente" },
        );
        return { atendido: true, detalle: "paso 5: confirmar paciente" };
      }
      await sendBotText(
        conversationId,
        msg("cita:paciente", { hora: horaCorta(formatLimaTime(new Date(borrador.hora!))) }),
        { kind: "cita:paciente" },
      );
      return { atendido: true, detalle: "paso 5: pedir nombre" };
    }
  }

  // ── Todo reunido: se agenda ──
  try {
    const cita = await bookAppointment({
      leadId,
      branchId,
      startsAt: new Date(borrador.hora!),
      pacienteNombre: borrador.paciente,
    });
    await guardarBorrador(conversationId, null);
    await sendBotText(
      conversationId,
      msg("cita:agendada", {
        cuando: formatLima(new Date(borrador.hora!)),
        sucursal: cita.branch.nombre,
        direccion: cita.branch.direccion,
        paciente: borrador.paciente,
      }),
      { kind: "cita:agendada", appointment_id: cita.appointmentId },
    );
    return { atendido: true, detalle: "cita agendada por el código" };
  } catch (err) {
    // Se suelta la hora para que pueda elegir otra; lo demás se conserva.
    borrador.hora = undefined;
    await guardarBorrador(conversationId, borrador);
    if (err instanceof BookingError) {
      await sendBotText(conversationId, `${err.message} ¿Quieres que busquemos otro horario?`, { kind: "cita:error" });
      return { atendido: true, detalle: `no se pudo agendar: ${err.code}` };
    }
    throw err;
  }
}

const diaLargo = (fecha: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${fecha}T12:00:00-05:00`),
  );

/** Un saludo y nada más: «hola», «buenas tardes», «buen día». */
const SALUDO_SUELTO = /^\s*(hola|buenas?|buen dia|buenos dias|buenas tardes|buenas noches|que tal|saludos|hey|holi)[\s!.,¡😊👋🙏]*$/;
export const esSaludoSuelto = (texto: string) => SALUDO_SUELTO.test(normal(texto));

/**
 * El primer mensaje a un cliente nuevo: quién le escribe y el aviso de datos, con PROMO y BAJA.
 *
 * Lo manda el código porque es obligatorio y el modelo se lo saltaba: a un «Hola» contestaba «¡Hola! Buenas
 * días 😊 ¿En qué puedo ayudarte?» —sin presentarse, sin el aviso y con una falta de concordancia—. Un
 * requisito legal no puede depender de que el modelo se acuerde.
 */
export async function darBienvenida(
  conversationId: string,
  opciones: { nombreCliente?: string | null; negocio: string },
): Promise<void> {
  const msg = await cargarMensajes();
  const nombre = opciones.nombreCliente?.trim().split(/\s+/)[0];
  await sendBotText(conversationId, msg("bienvenida", { nombre: nombre ? `, ${nombre}` : "", negocio: opciones.negocio }), {
    kind: "bienvenida",
  });
}

/** Empezar de cero: el cliente volvió a pedir cita y lo anterior ya no vale. */
export async function olvidarBorrador(conversationId: string): Promise<void> {
  await guardarBorrador(conversationId, null);
}
