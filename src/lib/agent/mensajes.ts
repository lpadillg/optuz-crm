import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Los textos que el agente envía durante una cita, editables desde el panel.
 *
 * Los pasos los manda el código para que salgan siempre igual, pero eso no puede significar que el tono sea
 * intocable: cómo le hablas a tus clientes es del negocio, no del programador. Aquí está lo que el sistema
 * trae de fábrica; lo que se edite en «Agente IA» manda sobre esto.
 */

export interface MensajeDef {
  clave: string;
  /** Para qué sirve, en la pantalla de edición. */
  cuando: string;
  texto: string;
  /** Huecos que se rellenan al enviarlo. */
  huecos: string[];
}

export const MENSAJES: MensajeDef[] = [
  {
    clave: "cita:saludo",
    cuando: "Al empezar una cita, antes de ofrecer las tiendas",
    texto: "¡Hola, {{nombre}}!",
    huecos: ["nombre"],
  },
  {
    clave: "cita:promo",
    cuando: "Se añade al saludo cuando el cliente escribe por una promoción",
    texto: " Sí, la promoción *{{promo}}* está vigente{{alcance}}.",
    huecos: ["promo", "alcance"],
  },
  {
    clave: "cita:sucursal",
    cuando: "Para elegir tienda, cuando no sabemos cuál le queda cerca",
    texto: "¿Cuál sucursal te queda más cerca?",
    huecos: [],
  },
  {
    clave: "cita:sucursal-confirmar",
    cuando: "Para confirmar la tienda de siempre",
    texto: "¿Te agendo en nuestra tienda de *{{sucursal}}*?",
    huecos: ["sucursal"],
  },
  {
    clave: "cita:dia",
    cuando: "Para elegir el día, ya con la tienda elegida",
    texto: "¡Perfecto, te agendo en *{{sucursal}}*! ¿Qué día te viene bien?",
    huecos: ["sucursal"],
  },
  {
    clave: "cita:franja",
    cuando: "Para elegir mañana o tarde, ya con el día elegido",
    texto: "Anotado, el *{{dia}}*. ¿Lo prefieres en la mañana o en la tarde?",
    huecos: ["dia"],
  },
  {
    clave: "cita:hora",
    cuando: "Al ofrecer los horarios libres",
    texto: "El {{dia}} por la {{franja}} tengo estos horarios:",
    huecos: ["dia", "franja"],
  },
  {
    clave: "cita:hora-otro-dia",
    cuando: "Cuando ese día ya no tiene cupo y se ofrecen los siguientes",
    texto: "Ese día ya no me queda cupo por la {{franja}}. Estos son los más próximos:",
    huecos: ["franja"],
  },
  {
    clave: "cita:sin-cupo",
    cuando: "Cuando no queda nada en esa parte del día",
    texto: "No me queda cupo por la {{franja}} esos días. ¿Te busco en la otra parte del día?",
    huecos: ["franja"],
  },
  {
    clave: "cita:paciente-confirmar",
    cuando: "Para saber si la cita es para el cliente o para otra persona",
    texto: "¡Listo, {{hora}}! ¿La cita es para ti, *{{nombre}}*, o para otra persona?",
    huecos: ["hora", "nombre"],
  },
  {
    clave: "cita:paciente",
    cuando: "Para pedir el nombre de quien viene, cuando no lo sabemos",
    texto: "¡Listo, {{hora}}! Solo me falta un dato: ¿a nombre de quién la agendo? Dime *nombre y apellido*, por favor 😊",
    huecos: ["hora"],
  },
  {
    clave: "cita:agendada",
    cuando: "Al quedar agendada la cita",
    texto:
      "¡Listo! Tu evaluación visual queda para el *{{cuando}}* en {{sucursal}} ({{direccion}}).\n\nVa a nombre de *{{paciente}}*. Si necesitas cambiarla, escríbeme y la movemos. ¡Te esperamos! 😊",
    huecos: ["cuando", "sucursal", "direccion", "paciente"],
  },
];

const PORDEFECTO = new Map(MENSAJES.map((m) => [m.clave, m.texto]));

/** Rellena {{hueco}} con lo que toque; lo que no se pase se queda vacío, no se imprime el hueco. */
export function rellenar(texto: string, valores: Record<string, string | undefined>): string {
  return texto.replace(/\{\{(\w+)\}\}/g, (_, k: string) => valores[k] ?? "").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Los textos a usar ahora: los editados en el panel, y para el resto los de fábrica. Se leen de una vez
 * porque un mismo turno puede enviar más de uno.
 */
export async function cargarMensajes(): Promise<(clave: string, valores?: Record<string, string | undefined>) => string> {
  let editados = new Map<string, string>();
  try {
    const { data } = await createAdminClient().from("agent_messages").select("clave, texto");
    editados = new Map((data ?? []).map((m) => [m.clave as string, m.texto as string]));
  } catch (err) {
    // Si no se pueden leer, se usan los de fábrica: el cliente no puede quedarse sin respuesta por esto.
    console.error("[agente] no se pudieron leer los mensajes editados", err);
  }
  return (clave, valores = {}) => rellenar(editados.get(clave) ?? PORDEFECTO.get(clave) ?? "", valores);
}
