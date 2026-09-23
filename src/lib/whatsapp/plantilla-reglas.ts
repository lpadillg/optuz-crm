/**
 * Lo que Meta exige de una plantilla, explicado en español.
 *
 * Meta rechaza plantillas con mensajes crípticos y en inglés, y cada rechazo cuesta horas de espera. Estas
 * reglas se comprueban antes de enviarla, y el mismo código corre en el formulario (avisa mientras escribes)
 * y en el servidor (que no se fía del formulario).
 */

export const CATEGORIAS = ["UTILITY", "MARKETING"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const CATEGORIA_LABEL: Record<Categoria, string> = {
  UTILITY: "Utilidad",
  MARKETING: "Marketing",
};

export const CATEGORIA_HINT: Record<Categoria, string> = {
  UTILITY:
    "Avisa de algo que el cliente ya pidió o ya tiene en marcha: su cita, su pedido, un cambio de horario. Se aprueba con más facilidad y es más barata.",
  MARKETING:
    "Ofrece, promociona o invita a volver. Meta la revisa con más dureza y el cliente puede darse de baja de este tipo de mensajes.",
};

/** Los números de variable que usa el texto, en el orden en que aparecen y sin repetidos. */
export function variablesDe(body: string): number[] {
  const vistas = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) vistas.add(Number(m[1]));
  return [...vistas].sort((a, b) => a - b);
}

export interface PlantillaPropuesta {
  name: string;
  category: Categoria;
  language: string;
  body: string;
  examples: string[];
}

/**
 * Devuelve los problemas que Meta rechazaría, en el orden en que conviene arreglarlos. Lista vacía = lista
 * para enviar (que no es lo mismo que aprobada: eso lo decide Meta después).
 */
export function revisarPlantilla(p: PlantillaPropuesta): string[] {
  const errores: string[] = [];
  const nombre = p.name.trim();

  if (!nombre) errores.push("Ponle un nombre.");
  else if (!/^[a-z0-9_]+$/.test(nombre)) errores.push("El nombre solo admite minúsculas, números y guiones bajos: «cliente_dormido», no «Cliente Dormido».");
  else if (nombre.length > 60) errores.push("El nombre es demasiado largo (máximo 60 caracteres).");

  const body = p.body.trim();
  if (!body) errores.push("Escribe el mensaje.");
  else if (body.length > 1024) errores.push(`El mensaje tiene ${body.length} caracteres y el máximo son 1.024.`);

  if (body) {
    const vars = variablesDe(body);
    const esperadas = vars.map((_, i) => i + 1);
    if (vars.join(",") !== esperadas.join(",")) {
      errores.push("Las variables tienen que ser {{1}}, {{2}}, {{3}}… en ese orden y sin saltarse ninguna.");
    }
    // Meta rechaza un texto que empieza o acaba en variable: sin nada alrededor no puede juzgar el mensaje.
    if (/^\s*\{\{\d+\}\}/.test(body)) errores.push("El mensaje no puede empezar por una variable: pon algo antes, aunque sea «Hola».");
    if (/\{\{\d+\}\}\s*$/.test(body)) errores.push("El mensaje no puede terminar en una variable: escribe algo después.");
    if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) errores.push("No pongas dos variables seguidas: separa con texto.");

    const faltan = vars.filter((n) => !p.examples[n - 1]?.trim());
    if (faltan.length) {
      errores.push(`Falta un ejemplo para ${faltan.map((n) => `{{${n}}}`).join(", ")}. Meta los exige para poder revisarla.`);
    }
  }

  if (!p.language.trim()) errores.push("Elige el idioma.");
  return errores;
}

/** Rellena {{1}}, {{2}}… para ver cómo le llegará al cliente. */
export function vistaPrevia(body: string, examples: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => examples[Number(n) - 1]?.trim() || `{{${n}}}`);
}
