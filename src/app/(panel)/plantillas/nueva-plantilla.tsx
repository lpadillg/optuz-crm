"use client";
import { useMemo, useState } from "react";
import { crearPlantilla } from "@/app/(panel)/crm-actions";
import { Icon } from "@/components/icons";
import { CATEGORIAS, CATEGORIA_HINT, CATEGORIA_LABEL, revisarPlantilla, variablesDe, vistaPrevia, type Categoria } from "@/lib/whatsapp/plantilla-reglas";

/**
 * Escribir una plantilla y mandarla a Meta.
 *
 * Meta tarda horas en revisar y, cuando rechaza, lo hace en inglés y sin decir qué arreglar. Por eso el
 * formulario comprueba sus reglas mientras se escribe, detecta solo las variables del texto y enseña cómo le
 * llegará el mensaje al cliente: casi todos los rechazos se evitan antes de enviar.
 */
export function NuevaPlantilla() {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Categoria>("UTILITY");
  const [body, setBody] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);

  const vars = useMemo(() => variablesDe(body), [body]);
  const problemas = useMemo(
    () => revisarPlantilla({ name, category, language: "es", body, examples }),
    [name, category, body, examples],
  );
  // Mientras el formulario está vacío no se regaña a nadie.
  const tocado = name.trim() !== "" || body.trim() !== "";

  const setEjemplo = (i: number, v: string) =>
    setExamples((cur) => {
      const next = [...cur];
      next[i] = v;
      return next;
    });

  return (
    <details className="card wide nueva-plantilla">
      <summary>
        <Icon name="mas" size={16} /> Escribir una plantilla nueva
      </summary>

      <p className="hint" style={{ marginTop: 12 }}>
        Sirve para escribirle a un cliente <strong>pasadas 24 horas</strong> desde su último mensaje, que es cuando WhatsApp no
        deja mandar texto libre. Meta revisa cada plantilla antes de permitirla: suele tardar de minutos a unas horas.
      </p>

      <form action={crearPlantilla} className="form-grid" onSubmit={() => setEnviando(true)}>
        <label>
          Nombre
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
            placeholder="cliente_dormido"
            maxLength={60}
            required
          />
          <span className="hint">Solo para identificarla aquí dentro; el cliente no lo ve. Minúsculas y guiones bajos.</span>
        </label>

        <label>
          Tipo
          <select name="category" value={category} onChange={(e) => setCategory(e.target.value as Categoria)}>
            {CATEGORIAS.map((c) => (
              <option key={c} value={c}>
                {CATEGORIA_LABEL[c]}
              </option>
            ))}
          </select>
          <span className="hint">{CATEGORIA_HINT[category]}</span>
        </label>

        <input type="hidden" name="language" value="es" />

        <label className="ancho">
          Mensaje
          <textarea
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={1024}
            placeholder="Hola {{1}} 👋 Seguimos por aquí si quieres retomar tu evaluación visual gratuita. ¿Te busco un horario?"
            required
          />
          <span className="hint">
            Escribe <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code>… donde vaya algo que cambia en cada envío, como el nombre.
            {body.length > 0 && ` · ${body.length} de 1.024 caracteres`}
          </span>
        </label>

        {vars.length > 0 && (
          <div className="ancho ejemplos">
            <strong>Un ejemplo por variable</strong>
            <p className="hint">Meta los exige para entender qué pones en cada hueco. No se envían al cliente.</p>
            {vars.map((n, i) => (
              <label key={n} className="ejemplo">
                <code>{`{{${n}}}`}</code>
                <input value={examples[i] ?? ""} onChange={(e) => setEjemplo(i, e.target.value)} placeholder={i === 0 ? "María" : "…"} />
              </label>
            ))}
            {/* Van al servidor en el orden de las variables, una por línea. */}
            <input type="hidden" name="examples" value={vars.map((_, i) => examples[i] ?? "").join("\n")} />
          </div>
        )}

        {body.trim() && (
          <div className="ancho vista-previa">
            <strong>Así le llega al cliente</strong>
            <p className="burbuja">{vistaPrevia(body, examples)}</p>
          </div>
        )}

        {tocado && problemas.length > 0 && (
          <ul className="ancho problemas">
            {problemas.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <div className="ancho">
          <button type="submit" className="btn primary" disabled={problemas.length > 0 || enviando}>
            {enviando ? "Enviando…" : "Enviar a Meta para revisión"}
          </button>
        </div>
      </form>
    </details>
  );
}
