// Textos y detectores del ciclo de consentimiento por WhatsApp (BAJA → ALTA / re-consentimiento, y PROMO).
// Los mensajes son FIJOS (no los redacta el modelo): son los que constan como «versión del texto» en el registro.

/** Palabra que un cliente dado de baja escribe para volver a ser atendido (se la indica el bot al darlo de baja). */
export const OPT_IN_KEYWORD = "ALTA";
/** Palabra con la que el cliente pide, además, recibir promociones (consentimiento aparte de la atención). */
export const PROMO_KEYWORD = "PROMO";

/** Lo que el bot responde cuando alguien vuelve con la palabra clave. */
export const OPT_IN_REPLY = "¡Listo! Volveremos a atenderte por aquí. ¿En qué podemos ayudarte?";

/**
 * Cuando alguien dado de baja escribe por su cuenta, esta es la ÚNICA respuesta automática que recibe:
 * pide su autorización expresa y separa la atención de las promociones.
 */
export const REOPT_QUESTION =
  "Habías pedido no recibir mensajes de nuestra parte. Para ayudarte con tu consulta necesito tu autorización para escribirte por aquí. ¿Aceptas? Responde *SÍ* para continuar.\n\nLas promociones solo te las enviaremos si además nos lo pides escribiendo *PROMO*.";

/** Confirmación al pedir promociones. */
export const PROMO_REPLY = "¡Gracias! Desde ahora también podremos enviarte promociones. Puedes dejar de recibirlas cuando quieras escribiendo *BAJA*.";

/** Motivo con el que queda marcado, para el equipo, el chat de alguien dado de baja que escribe y no acepta ni rechaza. */
export const OPTED_OUT_WROTE_REASON =
  "Cliente dado de baja volvió a escribir. El bot no le responde; usa «Reactivar atención» si el cliente lo pidió.";

/** Cuánto tiempo, tras una baja, el bot NO vuelve a preguntar (evita insistirle a quien acaba de pedir que paremos). */
export const REASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ¿El mensaje es, entero, una petición de volver a recibir mensajes? Deliberadamente estricto: solo la palabra
 * clave o frases inequívocas, porque una frase suelta como «alta calidad» o «no quiero volver» no debe reactivar.
 */
export function isOptInMessage(text: string): boolean {
  return /^(alta|dar de alta|dame de alta|reactivar|reactivame|reactivarme|suscribirme|volver a recibir( mensajes| informacion)?|quiero volver a recibir( mensajes| informacion)?)$/.test(
    norm(text),
  );
}

/** «PROMO» (o equivalentes inequívocos): acepta recibir promociones. */
export function isPromoOptInMessage(text: string): boolean {
  return /^(promo|promos|promocion|promociones|quiero promociones|quiero recibir promociones|si quiero promociones)$/.test(norm(text));
}

/** Respuesta afirmativa a la pregunta de re-consentimiento. Solo vale justo después de esa pregunta. */
export function isAffirmative(text: string): boolean {
  return /^(si|si acepto|acepto|si claro|claro|si quiero|quiero|ok|okay|dale|de acuerdo|por supuesto|si gracias|si por favor|si continuar|continuar|adelante)$/.test(norm(text));
}

/** Respuesta negativa a la pregunta de re-consentimiento. */
export function isNegative(text: string): boolean {
  return /^(no|no gracias|no acepto|no quiero|nunca|no continuar|no por favor)$/.test(norm(text));
}

/** Simple acuse de recibo («gracias», «ok») que no merece que nadie lo atienda. */
export function isAcknowledgement(text: string): boolean {
  return /^(gracias|muchas gracias|ok|okay|listo|vale|perfecto|entendido|de nada|buenas noches|buen dia|buenos dias|buenas tardes|chau|adios)$/.test(norm(text));
}
