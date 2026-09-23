import Link from "next/link";
import { activateAllKnowledge, createKnowledge, deleteKnowledge, toggleKnowledge, updateKnowledge } from "@/app/(panel)/crm-actions";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { MessagePreviewField } from "@/components/message-preview";
import { PageHelp } from "@/components/page-help";
import { requireAdmin } from "@/lib/session";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORY_HINT, KNOWLEDGE_CATEGORY_LABEL, type KnowledgeCategory } from "@/lib/types";

/** Tamaño recomendado de todo lo activo, en caracteres (≈2.700 tokens). Pasarse encarece cada respuesta y distrae al agente. */
const KNOWLEDGE_BUDGET = 9000;

interface Ficha {
  id: string;
  titulo: string;
  contenido: string;
  activa: boolean;
  categoria: KnowledgeCategory;
}

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.from("knowledge_base").select("id, titulo, contenido, activa, categoria").order("titulo");
  if (error) throw error;
  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const rows = (data ?? []) as Ficha[];
  const activas = rows.filter((k) => k.activa).length;
  const apagadas = rows.length - activas;
  // Todo lo activo viaja ENTERO en las instrucciones del agente, en cada mensaje: conviene ver cuánto pesa.
  const size = (k: Ficha) => k.titulo.length + k.contenido.length;
  const usados = rows.filter((k) => k.activa).reduce((n, k) => n + size(k), 0);
  const pasado = usados > KNOWLEDGE_BUDGET;

  // Filtro por tema: se ve un tema a la vez sin perder la cuenta del resto.
  const cat = KNOWLEDGE_CATEGORIES.find((c) => c === sp.c) ?? null;
  const soloApagadas = sp.f === "apagadas";
  const visibles = rows.filter((k) => (!cat || k.categoria === cat) && (!soloApagadas || !k.activa));
  const grupos = KNOWLEDGE_CATEGORIES.map((c) => ({ key: c, fichas: visibles.filter((k) => k.categoria === c) })).filter((g) => g.fichas.length > 0);
  const link = (patch: { c?: KnowledgeCategory | null; f?: string | null }) => {
    const c = patch.c === undefined ? cat : patch.c;
    const f = patch.f === undefined ? (soloApagadas ? "apagadas" : null) : patch.f;
    const qs = new URLSearchParams();
    if (c) qs.set("c", c);
    if (f) qs.set("f", f);
    return qs.size ? `/conocimiento?${qs}` : "/conocimiento";
  };

  return (
    <div className="page">
      <div className="row-head">
        <h1 className="page-title">Conocimiento del agente</h1>
        <span className="spacer" />
        {apagadas > 0 && (
          <FormDialog
            trigger="Activar todas"
            triggerClassName="btn ghost"
            title="Activar todas las fichas"
            description={`${apagadas} ficha${apagadas === 1 ? "" : "s"} pasará${apagadas === 1 ? "" : "n"} a estar activa${apagadas === 1 ? "" : "s"}: el agente las usará para responder desde la siguiente conversación.`}
          >
            <form action={activateAllKnowledge} className="form-actions">
              <button type="submit">Activar las {apagadas}</button>
            </form>
          </FormDialog>
        )}
        <FormDialog
          trigger={
            <>
              <Icon name="mas" size={16} /> Agregar información
            </>
          }
          triggerClassName="btn primary"
          title="Agregar información"
          description="El agente la usará para responder desde la siguiente conversación."
        >
          <form action={createKnowledge} className="stack" style={{ gap: 14 }}>
            <label>
              Título
              <input name="titulo" required maxLength={120} placeholder="Formas de pago" />
            </label>
            <CategoryField defaultValue={cat ?? "atencion"} />
            <MessagePreviewField
              name="contenido"
              label="Contenido"
              rows={5}
              maxLength={4000}
              placeholder="Aceptamos efectivo, Yape, Plin y tarjetas…"
              hint="Escríbelo como se lo dirías a un cliente."
            />
            <div className="form-actions">
              <button type="submit">Agregar</button>
            </div>
          </form>
        </FormDialog>
      </div>
      <PageHelp
        more={
          <>
            <p>Servicios, garantías, formas de pago y políticas: lo que el agente debe saber para responder bien.</p>
            <p>
              <strong>No pongas precios</strong>: el agente no los maneja y deriva esas consultas a una persona. Las
              sucursales, los horarios y las promociones salen de sus propias secciones, no de aquí.
            </p>
            <p>
              Todo lo que esté <strong>activo</strong> se le envía al agente entero en cada mensaje que responde. Por eso conviene tenerlo corto: fichas
              breves, una por tema, y apagadas las que casi nadie pregunta.
            </p>
          </>
        }
      >
        Lo que el agente sabe de tu negocio al responder.
      </PageHelp>
      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      {rows.length > 0 && (
        <>
          {/* Cuánto de lo recomendado ocupa lo que está activo: la única cifra que decide si conviene una ficha más. */}
          <section className={`kb-budget${pasado ? " over" : ""}`}>
            <div className="kb-b-top">
              <strong>
                {activas} de {rows.length} activa{rows.length === 1 ? "" : "s"}
              </strong>
              <span className="muted">
                {usados.toLocaleString("es-PE")} de {KNOWLEDGE_BUDGET.toLocaleString("es-PE")} caracteres recomendados
              </span>
            </div>
            <div className="track">
              <div className="fill" style={{ width: `${Math.min(100, Math.round((usados / KNOWLEDGE_BUDGET) * 100))}%` }} />
            </div>
            <p className="muted">
              {pasado
                ? "Te pasaste de lo recomendado: cada respuesta del agente cuesta más y le cuesta encontrar lo importante. Acorta las fichas más largas o apaga las que casi no se consultan."
                : "Esto es lo que el agente carga en cada mensaje que responde."}
            </p>
          </section>

          <div className="kb-filters">
            <nav className="chips-row" aria-label="Filtrar por tema">
              <Link href={link({ c: null })} className={`chip-btn${cat ? "" : " on"}`} aria-current={cat ? undefined : "true"}>
                Todos los temas ({rows.length})
              </Link>
              {KNOWLEDGE_CATEGORIES.map((c) => {
                const n = rows.filter((k) => k.categoria === c).length;
                if (n === 0) return null;
                return (
                  <Link key={c} href={link({ c })} className={`chip-btn${cat === c ? " on" : ""}`} aria-current={cat === c ? "true" : undefined}>
                    {KNOWLEDGE_CATEGORY_LABEL[c]} ({n})
                  </Link>
                );
              })}
            </nav>
            {apagadas > 0 && (
              <Link href={link({ f: soloApagadas ? null : "apagadas" })} className={`chip-btn kb-only-off${soloApagadas ? " on" : ""}`}>
                {soloApagadas ? "✓ " : ""}Solo las que faltan activar ({apagadas})
              </Link>
            )}
          </div>
        </>
      )}

      {rows.length === 0 && (
        <div className="card wide">
          <div className="empty-state">
            <span className="ico">
              <Icon name="conocimiento" size={22} />
            </span>
            <strong>Aún no hay información cargada</strong>
            <p className="muted">Empieza por lo que más preguntan: formas de pago, garantía de las monturas, qué traer a la evaluación.</p>
          </div>
        </div>
      )}

      {rows.length > 0 && visibles.length === 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          {soloApagadas ? "No queda ninguna ficha por activar en este tema." : "No hay fichas en este tema todavía."}
        </p>
      )}

      {grupos.map((g) => {
        const activasG = g.fichas.filter((k) => k.activa).length;
        return (
          <section key={g.key} className="kb-group">
            <div className="kb-g-head">
              <h2>{KNOWLEDGE_CATEGORY_LABEL[g.key]}</h2>
              <span className="tag">
                {activasG} de {g.fichas.length} activa{g.fichas.length === 1 ? "" : "s"}
              </span>
              <span className="muted hide-sm">{KNOWLEDGE_CATEGORY_HINT[g.key]}</span>
            </div>
            <div className="kb-grid">
              {g.fichas.map((k) => (
                <article key={k.id} className={`kb-card${k.activa ? "" : " off"}`}>
                  <div className="kb-head">
                    <h3>{k.titulo}</h3>
                    {/* Un clic enciende o apaga: antes había que marcar una casilla y además darle a Guardar. */}
                    <form action={toggleKnowledge} className="kb-toggle">
                      <input type="hidden" name="id" value={k.id} />
                      <input type="hidden" name="activa" value={k.activa ? "false" : "true"} />
                      <button
                        type="submit"
                        className={`switch${k.activa ? " on" : ""}`}
                        aria-label={k.activa ? `Desactivar ${k.titulo}` : `Activar ${k.titulo}`}
                        title={k.activa ? "El agente la está usando. Clic para apagarla." : "Apagada. Clic para que el agente la use."}
                      >
                        <span className="knob" />
                      </button>
                    </form>
                  </div>
                  <p className="kb-text">{k.contenido}</p>
                  <div className="kb-foot">
                    <span className={k.activa ? "tag ok" : "tag"}>{k.activa ? "El agente la usa" : "Desactivada"}</span>
                    <span className="muted">{size(k).toLocaleString("es-PE")} caracteres</span>
                    <span className="spacer" />
                    <FormDialog trigger="Editar" triggerClassName="btn ghost btn-sm" title={k.titulo} description="El cambio rige desde la siguiente conversación.">
                      <form action={updateKnowledge} className="stack" style={{ gap: 14 }}>
                        <input type="hidden" name="id" value={k.id} />
                        {/* El estado se cambia con el interruptor de la tarjeta; aquí solo se conserva. */}
                        {k.activa && <input type="hidden" name="activa" value="on" />}
                        <label>
                          Título
                          <input name="titulo" defaultValue={k.titulo} required maxLength={120} />
                        </label>
                        <CategoryField defaultValue={k.categoria} />
                        <MessagePreviewField
                          name="contenido"
                          label="Contenido"
                          rows={7}
                          maxLength={4000}
                          defaultValue={k.contenido}
                          hint="Escríbelo como se lo dirías a un cliente."
                        />
                        <div className="form-actions between">
                          <button type="submit" formAction={deleteKnowledge} className="ghost danger">
                            Eliminar
                          </button>
                          <button type="submit">Guardar</button>
                        </div>
                      </form>
                    </FormDialog>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CategoryField({ defaultValue }: { defaultValue: KnowledgeCategory }) {
  return (
    <label>
      Tema <span className="hint">(solo ordena esta pantalla; el agente usa todas por igual)</span>
      <select name="categoria" defaultValue={defaultValue}>
        {KNOWLEDGE_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {KNOWLEDGE_CATEGORY_LABEL[c]}
          </option>
        ))}
      </select>
    </label>
  );
}
