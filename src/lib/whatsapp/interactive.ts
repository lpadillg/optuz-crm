/**
 * Mensajes interactivos de WhatsApp (botones y listas). Límites de la Cloud API:
 *  - botones de respuesta: hasta 3, título de hasta 20 caracteres;
 *  - lista: hasta 10 filas, título de hasta 24 caracteres, descripción de hasta 72, texto del botón de hasta 20;
 *  - cuerpo de hasta 1024 caracteres.
 * Al tocar una opción, el cliente envía un mensaje con el título elegido (lo lee el agente como cualquier texto).
 */
export type Interactive =
  | { type: "button"; body: { text: string }; action: { buttons: { type: "reply"; reply: { id: string; title: string } }[] } }
  | { type: "list"; body: { text: string }; action: { button: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] } };

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export interface BuiltInteractive {
  interactive: Interactive;
  /** Cómo se ve en el inbox: el cuerpo y las opciones. */
  preview: string;
  /** Opciones tal como las verá el cliente (ya recortadas y sin repetidas). */
  options: string[];
}

/** Una opción: solo su texto, o con una línea debajo (la dirección de la tienda). La línea solo se ve en las listas. */
export type Option = string | { title: string; description?: string };

const titleOf = (o: Option) => (typeof o === "string" ? o : o.title);
const descOf = (o: Option) => (typeof o === "string" ? undefined : o.description);

/** Botones si hay hasta 3 opciones; lista si hay de 4 a 10. Lanza si no hay al menos 2 opciones válidas. */
export function buildInteractive(body: string, rawOptions: Option[]): BuiltInteractive {
  const text = clip(body.trim(), 1024);
  if (!text) throw new Error("El mensaje con opciones necesita un texto");

  const asButtons = rawOptions.filter((o) => titleOf(o).trim()).length <= 3;
  const max = asButtons ? 20 : 24;
  const seen = new Set<string>();
  const options: string[] = [];
  const descriptions: (string | undefined)[] = [];
  for (const raw of rawOptions) {
    const title = clip(titleOf(raw).replace(/\s+/g, " ").trim(), max);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    options.push(title);
    const d = descOf(raw)?.replace(/\s+/g, " ").trim();
    descriptions.push(d ? clip(d, 72) : undefined);
  }
  if (options.length < 2) throw new Error("Se necesitan al menos 2 opciones distintas");
  if (options.length > 10) options.length = 10;

  const rows = options.map((title, i) => ({ id: `opt_${i + 1}`, title, ...(descriptions[i] && { description: descriptions[i] }) }));
  const preview = `${text}\n\n${options.map((o, i) => `▫ ${o}${descriptions[i] ? ` — ${descriptions[i]}` : ""}`).join("\n")}`;
  if (options.length <= 3) {
    return { interactive: { type: "button", body: { text }, action: { buttons: rows.map((reply) => ({ type: "reply" as const, reply })) } }, preview, options };
  }
  return { interactive: { type: "list", body: { text }, action: { button: "Ver opciones", sections: [{ title: "Opciones", rows }] } }, preview, options };
}
