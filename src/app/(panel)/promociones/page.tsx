import { DateRangeFields } from "@/components/date-range-fields";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { PageHelp } from "@/components/page-help";
import { requireUser } from "@/lib/session";
import { createPromotion, togglePromotion, updatePromotion } from "../actions";

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "medium" }).format(new Date(iso));

export default async function PromotionsPage() {
  const { supabase, profile } = await requireUser();
  const isAdmin = profile.role === "admin";

  const [{ data: promos, error }, { data: branches }] = await Promise.all([
    supabase
      .from("promotions")
      .select("id, titulo, descripcion, valid_from, valid_to, active, branch_id, branches(nombre)")
      .order("valid_to", { ascending: false }),
    supabase.from("branches").select("id, nombre").eq("activa", true).order("nombre"),
  ]);
  if (error) throw error;

  const now = Date.now();
  const rows = (promos ?? []) as unknown as {
    id: string;
    titulo: string;
    descripcion: string;
    valid_from: string;
    valid_to: string;
    active: boolean;
    branch_id: string | null;
    branches: { nombre: string } | null;
  }[];
  const isLiveNow = (p: (typeof rows)[number]) => p.active && new Date(p.valid_from).getTime() <= now && now <= new Date(p.valid_to).getTime();
  const live = rows.filter(isLiveNow).length;
  // Las vigentes primero: son las que el agente está ofreciendo ahora mismo.
  const ordered = [...rows].sort((a, b) => Number(isLiveNow(b)) - Number(isLiveNow(a)) || b.valid_to.localeCompare(a.valid_to));

  return (
    <div className="page">
      <div className="row-head">
        <h1 className="page-title">Promociones</h1>
        <span className="muted">
          {live} vigente{live === 1 ? "" : "s"} de {rows.length}
        </span>
        <span className="spacer" />
        {isAdmin && (
          <FormDialog
            trigger={
              <>
                <Icon name="mas" size={16} /> Nueva promoción
              </>
            }
            triggerClassName="btn primary"
            title="Nueva promoción"
            description="El agente la mencionará mientras esté vigente, solo en la sucursal que elijas."
          >
            <form action={createPromotion} className="stack" style={{ gap: 14 }}>
              <div className="row">
                <label>
                  Sucursal
                  <select name="branch_id" defaultValue="all" style={{ width: "100%" }}>
                    <option value="all">Todas las sucursales</option>
                    {(branches ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.nombre}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Título
                  <input name="titulo" required placeholder="Examen + 20% en monturas" />
                </label>
              </div>
              <label>
                Descripción
                <textarea name="descripcion" rows={3} required placeholder="Lo que el agente puede decirle al cliente." />
                <span className="hint">Sin precios: el agente no los maneja.</span>
              </label>
              <DateRangeFields />
              <div className="form-actions">
                <button type="submit">Crear promoción</button>
              </div>
            </form>
          </FormDialog>
        )}
      </div>
      <PageHelp
        more={
          <>
            <p>El agente consulta las promociones en el momento de responder, así que un cambio aquí se aplica a la siguiente conversación.</p>
            <p>Nunca inventa una promoción ni la ofrece en una sucursal distinta a la que elegiste. Si no hay ninguna vigente, dice que por ahora no hay promociones.</p>
            <p>No escribas precios: el agente no los maneja y deriva esas consultas a una persona.</p>
          </>
        }
      >
        Lo que el agente puede ofrecer, mientras esté vigente.
      </PageHelp>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Promoción</th>
              <th>Sucursal</th>
              <th>Vigencia</th>
              <th>Estado</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {ordered.map((p) => {
              const isLive = p.active && new Date(p.valid_from).getTime() <= now && now <= new Date(p.valid_to).getTime();
              return (
                <tr key={p.id}>
                  <td>
                    <div className="promo-title">{p.titulo}</div>
                    <div className="promo-desc">{p.descripcion}</div>
                  </td>
                  <td>{p.branches?.nombre ?? <span className="tag">Todas</span>}</td>
                  <td className="muted">
                    {fmt(p.valid_from)} → {fmt(p.valid_to)}
                  </td>
                  <td>
                    {isLive ? (
                      <span className="tag ok">Vigente</span>
                    ) : (
                      <span className="tag">{p.active ? "Fuera de fecha" : "Inactiva"}</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td>
                      <div className="row-actions">
                        <FormDialog trigger="Editar" title={`Editar «${p.titulo}»`} description="Los cambios se aplican a la siguiente conversación.">
                          <form action={updatePromotion} className="stack" style={{ gap: 14 }}>
                            <input type="hidden" name="id" value={p.id} />
                            <div className="row">
                              <label>
                                Sucursal
                                <select name="branch_id" defaultValue={p.branch_id ?? "all"} style={{ width: "100%" }}>
                                  <option value="all">Todas las sucursales</option>
                                  {(branches ?? []).map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.nombre}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Título
                                <input name="titulo" required defaultValue={p.titulo} />
                              </label>
                            </div>
                            <label>
                              Descripción
                              <textarea name="descripcion" rows={3} required defaultValue={p.descripcion} />
                              <span className="hint">Sin precios: el agente no los maneja.</span>
                            </label>
                            <DateRangeFields defaultFrom={p.valid_from} defaultTo={p.valid_to} />
                            <div className="form-actions">
                              <button type="submit">Guardar cambios</button>
                            </div>
                          </form>
                        </FormDialog>
                        <form action={togglePromotion}>
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="active" value={String(!p.active)} />
                          <button type="submit" className="ghost btn-sm">
                            {p.active ? "Desactivar" : "Activar"}
                          </button>
                        </form>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="empty-row">
                  <div className="empty-state">
                    <span className="ico">
                      <Icon name="promociones" size={22} />
                    </span>
                    <strong>No hay promociones</strong>
                    <p className="muted">Sin promociones activas, el agente lo dirá con naturalidad y seguirá ofreciendo la cita.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
