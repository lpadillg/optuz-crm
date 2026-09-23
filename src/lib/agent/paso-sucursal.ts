import "server-only";
import { sendBotOptions } from "@/lib/outbound";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * El paso de la sucursal, llevado por el código.
 *
 * Elegir tienda no tiene nada de creativo: o la ha elegido en esta conversación o no. Pedírselo por escrito al
 * modelo y luego adivinar, leyendo su texto, si lo ha hecho, obliga a reconocer infinitas formas de decir lo
 * mismo — en una sola tarde falló por una tilde («Confírmame»), por un signo de interrogación que no estaba,
 * por mencionar el día en la misma frase y por decir «te gustaría agendar» en vez de «te agendo».
 *
 * Aquí se comprueba el hecho y se manda la pregunta con sus opciones tocables, siempre igual. El modelo se
 * queda con lo que sí hace bien: entender qué quiere el cliente y responder a todo lo demás.
 */

const normal = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Frases con las que alguien pide una cita. Solo lo inequívoco: preguntar una dirección no es pedir cita. */
const PIDE_CITA =
  /\b(quiero|necesito|deseo|quisiera|me gustaria|puedo|podria|como|quer[ií]a)\b[^.?!]{0,40}\b(cita|agendar|reservar|separar|evaluacion|examen)\b|^\s*(agendar|cita|quiero mi cita|separar cita)\b/;

export interface Tienda {
  nombre: string;
  direccion: string;
}

/** ¿Este mensaje del cliente pide una cita? */
export const pideCita = (texto: string) => PIDE_CITA.test(normal(texto));

/**
 * La tienda que el cliente nombró en su mensaje, si nombró alguna. Cubre tanto tocar una opción de la lista
 * («Huánuco») como responder a la confirmación («Sí, en Huánuco») o escribirlo a mano.
 */
export function tiendaNombrada(texto: string, tiendas: Tienda[]): Tienda | null {
  const t = normal(texto);
  return tiendas.find((s) => t.includes(normal(s.nombre))) ?? null;
}

/**
 * ¿Eligió tienda en esta conversación? La guardada puede ser de hace meses: la gente se muda, viaja o
 * pregunta por otra tienda, y mandarla a la equivocada es un viaje perdido.
 */
export async function eligioTiendaAhora(conversationId: string, tiendas: Tienda[]): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []).some((m) => !!tiendaNombrada((m.content as string) ?? "", tiendas));
}

export type Resultado = { atendido: true; detalle: string } | { atendido: false };

/**
 * Si al cliente le falta elegir tienda, se le pregunta aquí y el turno termina: no se llama al modelo.
 * Devuelve `atendido: false` cuando no toca, y entonces la conversación sigue su curso normal.
 */
export async function conducirSucursal(input: {
  conversationId: string;
  leadId: string;
  /** La sucursal guardada del lead, si tiene. */
  branchId: string | null;
  branchNombre: string | null;
  /** Lo último que escribió el cliente. */
  texto: string;
  tiendas: Tienda[];
}): Promise<Resultado> {
  const { conversationId, leadId, branchId, branchNombre, texto, tiendas } = input;
  if (tiendas.length < 2) return { atendido: false };

  // 1. ¿Acaba de elegirla? Se guarda aquí, sin depender de que el modelo llame a set_branch.
  const elegida = tiendaNombrada(texto, tiendas);
  if (elegida) {
    const db = createAdminClient();
    const { data: fila } = await db.from("branches").select("id").eq("nombre", elegida.nombre).maybeSingle();
    if (fila?.id && fila.id !== branchId) await db.from("leads").update({ branch_id: fila.id }).eq("id", leadId);
    return { atendido: false }; // ya está elegida: que siga el modelo con el día
  }

  // 2. Solo se interviene cuando pide cita. Quien pregunta por la garantía no debe recibir una lista de tiendas.
  if (!pideCita(texto)) return { atendido: false };

  // 3. Si ya la eligió antes en esta misma conversación, no se vuelve a preguntar.
  if (await eligioTiendaAhora(conversationId, tiendas)) return { atendido: false };

  // 4. Con tienda guardada de otra vez, se confirma; sin ella, se ofrecen todas.
  if (branchNombre) {
    await sendBotOptions(
      conversationId,
      `¡Con gusto! ¿Te agendo en nuestra tienda de *${branchNombre}*?`,
      [`Sí, en ${branchNombre}`.slice(0, 20), "En otra tienda"],
      { kind: "options" },
    );
    return { atendido: true, detalle: "sucursal confirmada por el código" };
  }

  await sendBotOptions(
    conversationId,
    "¡Con gusto! ¿Cuál sucursal te queda más cerca?",
    tiendas.map((t) => ({ title: t.nombre, description: t.direccion })),
    { kind: "options" },
  );
  return { atendido: true, detalle: "sucursal preguntada por el código" };
}
