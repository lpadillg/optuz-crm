import { createQuickReply, deleteQuickReply, updateQuickReply } from "@/app/(panel)/crm-actions";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { MessagePreviewField } from "@/components/message-preview";
import { PageHelp } from "@/components/page-help";
import { SubmitButton } from "@/components/submit-button";
import { requireAdmin } from "@/lib/session";

export default async function QuickRepliesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.from("quick_replies").select("id, atajo, titulo, cuerpo").order("atajo");
  if (error) throw error;
  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const rows = data ?? [];

  return (
    <div className="page">
      <div className="row-head">
        <h1 className="page-title">Respuestas rápidas</h1>
        {rows.length > 0 && (
          <span className="muted">
            {rows.length} atajo{rows.length === 1 ? "" : "s"}
          </span>
        )}
        <span className="spacer" />
        <FormDialog
          trigger={
            <>
              <Icon name="mas" size={16} /> Nueva respuesta
            </>
          }
          triggerClassName="btn primary"
          title="Nueva respuesta rápida"
          description="Un mensaje que tu equipo repite mucho, listo para insertar con un atajo."
        >
          <form action={createQuickReply} className="stack" style={{ gap: 14 }}>
            <div className="row">
              <label>
                Atajo <span className="hint">(sin la barra)</span>
                <input name="atajo" required maxLength={30} placeholder="direccion" />
                <span className="hint">Letras, números, guion y guion bajo.</span>
              </label>
              <label>
                Título <span className="hint">(para reconocerla en la lista)</span>
                <input name="titulo" required maxLength={80} placeholder="Cómo llegar a la tienda" />
              </label>
            </div>
            <MessagePreviewField name="cuerpo" label="Mensaje" rows={4} maxLength={1500} placeholder="Estamos en…" />
            <div className="form-actions">
              <SubmitButton pendingLabel="Creando…">Crear</SubmitButton>
            </div>
          </form>
        </FormDialog>
      </div>
      <PageHelp
        more={
          <p>
            En un chat con el bot pausado, escribe «/» y el atajo. El texto se inserta en el cuadro de mensaje y puedes
            editarlo antes de enviarlo. Solo las ve tu equipo: el agente no las usa.
          </p>
        }
      >
        Mensajes listos para tu equipo, con un atajo.
      </PageHelp>
      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      {rows.length > 0 ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Atajo</th>
              <th>Título</th>
              <th>Mensaje</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id}>
                <td>
                  <code>/{q.atajo}</code>
                </td>
                <td className="cell-main">{q.titulo}</td>
                <td style={{ whiteSpace: "pre-wrap", maxWidth: 460 }} className="muted">
                  {q.cuerpo}
                </td>
                <td>
                  <div className="row-actions">
                    <FormDialog
                      trigger="Editar"
                      title={`Editar /${q.atajo}`}
                      description="Los cambios valen para la próxima vez que alguien use el atajo."
                    >
                      <form action={updateQuickReply} className="stack" style={{ gap: 14 }}>
                        <input type="hidden" name="id" value={q.id} />
                        <div className="row">
                          <label>
                            Atajo <span className="hint">(sin la barra)</span>
                            <input name="atajo" required maxLength={30} defaultValue={q.atajo} />
                          </label>
                          <label>
                            Título
                            <input name="titulo" required maxLength={80} defaultValue={q.titulo} />
                          </label>
                        </div>
                        <MessagePreviewField name="cuerpo" label="Mensaje" rows={4} maxLength={1500} defaultValue={q.cuerpo} />
                        <div className="form-actions">
                          <SubmitButton>Guardar cambios</SubmitButton>
                        </div>
                      </form>
                    </FormDialog>
                    <form action={deleteQuickReply}>
                      <input type="hidden" name="id" value={q.id} />
                      <button className="danger btn-sm" type="submit">
                        Eliminar
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : (
        <div className="card wide">
          <div className="empty-state">
            <span className="ico">
              <Icon name="respuestas" size={22} />
            </span>
            <strong>Aún no hay respuestas rápidas</strong>
            <p className="muted">Crea las que más repite tu equipo: cómo llegar, horarios, qué traer a la cita.</p>
            <ul className="empty-ideas">
              <li>«Cómo llegar» con la dirección y una referencia</li>
              <li>«Horarios» de atención de la sucursal</li>
              <li>«Qué traer» a la evaluación visual</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
