import Link from "next/link";
import { createContact } from "@/app/(panel)/crm-actions";
import { AutoFilters } from "@/components/auto-filters";
import { Avatar } from "@/components/avatar";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { PageHelp } from "@/components/page-help";
import { parseLeadFilters, queryLeads } from "@/lib/leads-query";
import { requireUser, seesAllBranches } from "@/lib/session";
import { LEAD_ORIGINS, LEAD_ORIGIN_LABEL, LEAD_STAGES, LEAD_STAGE_LABEL, ARCHIVE_REASON_LABEL, firstOf, type ArchiveReason, type LeadOrigin, type LeadStage } from "@/lib/types";

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "short" }).format(new Date(iso));

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { supabase, profile } = await requireUser();
  const filters = parseLeadFilters(sp);
  const error = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const filtering = Boolean(filters.q || filters.stage || filters.origin || filters.branch || filters.tag);

  const [{ data, error: qErr }, { data: branches }, { data: tagRows }] = await Promise.all([
    queryLeads(supabase, filters),
    supabase.from("branches").select("id, nombre").eq("activa", true).order("nombre"),
    supabase.from("leads").select("tags").limit(2000),
  ]);
  if (qErr) throw qErr;

  const allTags = [...new Set((tagRows ?? []).flatMap((r) => r.tags as string[]))].sort();
  const leads = (data ?? []) as unknown as {
    id: string;
    nombre: string | null;
    phone: string | null;
    email: string | null;
    stage: LeadStage;
    archived_at: string | null;
    archive_reason: string | null;
    source: string;
    origin: LeadOrigin;
    opt_out: boolean;
    promo_consent: boolean;
    tags: string[];
    created_at: string;
    branches: { nombre: string } | null;
    conversations: { id: string } | { id: string }[] | null;
  }[];

  const exportQs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div className="page">
      <div className="row-head">
        <h1 className="page-title">Contactos</h1>
        <span className="muted">
          {leads.length} contacto{leads.length === 1 ? "" : "s"}
          {filtering && " con estos filtros"}
        </span>
        <span className="spacer" />
        <a className="btn ghost" href={`/api/leads/export${exportQs ? `?${exportQs}` : ""}`}>
          Exportar CSV
        </a>
        <FormDialog
          trigger={
            <>
              <Icon name="mas" size={16} /> Nuevo contacto
            </>
          }
          triggerClassName="btn primary"
          title="Nuevo contacto"
          description="Para alguien que llegó por otro canal. Los de WhatsApp se crean solos."
          defaultOpen={sp.nuevo === "1"}
        >
          <form action={createContact} className="stack" style={{ gap: 14 }}>
            <div className="row">
              <label>
                Nombre
                <input name="nombre" required maxLength={120} placeholder="Ana Ramírez" />
              </label>
              <label>
                Teléfono de WhatsApp
                <input name="phone" required placeholder="987654321" inputMode="tel" />
                <span className="hint">Sin prefijo se guarda como +51.</span>
              </label>
            </div>
            <div className="row">
              <label>
                Email <span className="hint">(opcional)</span>
                <input name="email" type="email" placeholder="ana@correo.com" />
              </label>
              <label>
                Sucursal
                <select name="branch_id" defaultValue={profile.branch_id ?? ""} required style={{ width: "100%" }}>
                  {seesAllBranches(profile) && <option value="">Elegir…</option>}
                  {(branches ?? [])
                    .filter((b) => seesAllBranches(profile) || b.id === profile.branch_id)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.nombre}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              Etiquetas <span className="hint">(separadas por coma)</span>
              <input name="tags" placeholder="vip, lentes de contacto" />
            </label>
            <div className="form-actions">
              <button type="submit">Crear contacto</button>
            </div>
          </form>
        </FormDialog>
      </div>
      {error && <p className="banner warn">{error}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      <AutoFilters>
        <input type="search" name="q" placeholder="Buscar por nombre, teléfono o email" defaultValue={filters.q ?? ""} aria-label="Buscar contactos" />
        <select name="stage" defaultValue={filters.stage ?? ""} aria-label="Etapa">
          <option value="">Todas las etapas</option>
          {LEAD_STAGES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <select name="origin" defaultValue={filters.origin ?? ""} aria-label="Origen">
          <option value="">Todos los orígenes</option>
          {LEAD_ORIGINS.map((o) => (
            <option key={o} value={o}>
              {LEAD_ORIGIN_LABEL[o]}
            </option>
          ))}
        </select>
        <select name="branch" defaultValue={filters.branch ?? ""} aria-label="Sucursal">
          <option value="">Todas las sucursales</option>
          {(branches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.nombre}
            </option>
          ))}
        </select>
        <select name="tag" defaultValue={filters.tag ?? ""} aria-label="Etiqueta">
          <option value="">Todas las etiquetas</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {filtering && (
          <Link href="/leads" className="btn ghost">
            Limpiar filtros
          </Link>
        )}
      </AutoFilters>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contacto</th>
              <th>Teléfono</th>
              <th>Sucursal</th>
              <th>Estado</th>
              <th className="hide-sm">Etiquetas</th>
              <th className="hide-sm">Creado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const conv = firstOf(l.conversations);
              return (
                <tr key={l.id}>
                  <td className="cell-main">
                    <div className="cell-person">
                      <Avatar name={l.nombre} />
                      <div>
                        <Link href={`/leads/${l.id}`}>{l.nombre ?? "Sin nombre"}</Link>
                        {l.email && <div className="cell-sub">{l.email}</div>}
                        <div className="cell-sub">{LEAD_ORIGIN_LABEL[l.origin]}</div>
                      </div>
                    </div>
                  </td>
                  <td>{l.phone ?? <span className="muted">Sin número visible</span>}</td>
                  <td>{l.branches?.nombre ?? <span className="tag warn">Sin sucursal</span>}</td>
                  <td>
                    {l.archived_at ? (
                      <span className="tag" title="Fuera del tablero">{ARCHIVE_REASON_LABEL[l.archive_reason as ArchiveReason] ?? "Archivado"}</span>
                    ) : (
                      <span className={`tag dot-${l.stage}`}>{LEAD_STAGE_LABEL[l.stage]}</span>
                    )}
                    {l.opt_out && <span className="tag">baja</span>}
                    {l.promo_consent && <span className="tag ok">promos</span>}
                  </td>
                  <td className="hide-sm">
                    {l.tags.length === 0 && <span className="muted">—</span>}
                    {l.tags.map((t) => (
                      <span key={t} className="tag ok">
                        {t}
                      </span>
                    ))}
                  </td>
                  <td className="muted hide-sm">{fmt(l.created_at)}</td>
                  <td>{conv && <Link href={`/inbox/${conv.id}`}>Abrir chat</Link>}</td>
                </tr>
              );
            })}
            {leads.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-row">
                  <div className="empty-state">
                    <span className="ico">
                      <Icon name="contactos" size={22} />
                    </span>
                    <strong>{filtering ? "No hay contactos con esos filtros" : "Aún no hay contactos"}</strong>
                    <p className="muted">
                      {filtering
                        ? "Prueba con otros filtros o límpialos."
                        : "Los leads se crean solos cuando alguien escribe por WhatsApp. También puedes agregar uno a mano."}
                    </p>
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
