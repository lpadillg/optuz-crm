import Link from "next/link";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { PageHelp } from "@/components/page-help";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { testBranchCalendar } from "../crm-actions";
import { createBranch, updateBranch } from "../actions";

interface BranchRow {
  id: string;
  nombre: string;
  direccion: string;
  google_calendar_id: string | null;
  meta_campaign_ids: string[] | null;
  activa: boolean;
}

/** Campos del formulario, iguales para registrar y para editar. */
function BranchFields({ b }: { b?: BranchRow }) {
  return (
    <>
      <section className="form-section">
        <h3>Datos que el agente da a los clientes</h3>
        <div className="row">
          <label>
            Nombre
            <input name="nombre" defaultValue={b?.nombre} required minLength={2} maxLength={80} placeholder="Pucallpa" />
          </label>
          <label>
            Dirección
            <input
              name="direccion"
              defaultValue={b?.direccion}
              required
              minLength={5}
              maxLength={200}
              placeholder="Jr. Tarapacá 123, frente al Banco de la Nación"
            />
          </label>
        </div>
        <span className="hint">Calle, número y una referencia. El agente la repite tal cual cuando le preguntan cómo llegar.</span>
      </section>

      <section className="form-section">
        <h3>Agenda de citas</h3>
        <label>
          ID del Google Calendar
          <input name="google_calendar_id" defaultValue={b?.google_calendar_id ?? ""} placeholder="xxxx@group.calendar.google.com" />
          <span className="hint">
            En Google Calendar → Configuración del calendario → «Integrar el calendario». Compártelo con la cuenta de servicio con permiso para «hacer
            cambios en eventos». Sin él, el agente pasa las citas a un asesor.
          </span>
        </label>
      </section>

      <section className="form-section">
        <h3>Anuncios de Meta</h3>
        <label>
          IDs de anuncio o campaña
          <textarea name="meta_campaign_ids" rows={2} defaultValue={(b?.meta_campaign_ids ?? []).join(", ")} placeholder="120xxxxxxxxxx, 120yyyyyyyyyy" />
          <span className="hint">Opcional, separados por coma o salto de línea. Así un lead que llega por un anuncio queda en la sucursal correcta.</span>
        </label>
      </section>

      <label className="switch">
        <input type="checkbox" name="activa" defaultChecked={b ? b.activa : true} />
        <span>
          Sucursal activa
          <span className="hint">Si la desactivas, el agente deja de ofrecerla y de darla como opción.</span>
        </span>
      </label>
    </>
  );
}

export default async function BranchesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; nuevo?: string }>;
}) {
  const { supabase } = await requireAdmin();
  const { ok, error: errorMessage, nuevo } = await searchParams;

  const nowIso = new Date().toISOString();
  const [branchesQ, leadsQ, usersQ, apptsQ] = await Promise.all([
    supabase.from("branches").select("id, nombre, direccion, google_calendar_id, meta_campaign_ids, activa").order("nombre"),
    supabase.from("leads").select("branch_id").not("branch_id", "is", null).limit(20000),
    supabase.from("users").select("branch_id, role").eq("role", "vendedor"),
    supabase.from("appointments").select("branch_id").in("status", ["agendada", "confirmada"]).gte("scheduled_at", nowIso).limit(20000),
  ]);
  for (const q of [branchesQ, leadsQ, usersQ, apptsQ]) if (q.error) throw q.error;

  const branches = (branchesQ.data ?? []) as BranchRow[];
  const count = (rows: { branch_id: string | null }[] | null, id: string) => (rows ?? []).filter((r) => r.branch_id === id).length;

  const activas = branches.filter((b) => b.activa);
  const sinCalendario = activas.filter((b) => !b.google_calendar_id);
  // Asesores que atienden cada sucursal: los de esa sucursal y los que atienden todas (sin sucursal).
  const atienden = (id: string) => count(usersQ.data, id) + (usersQ.data ?? []).filter((r) => r.branch_id === null).length;
  const sinAsesor = activas.filter((b) => atienden(b.id) === 0);

  return (
    <div className="page">
      <h1>Sucursales</h1>
      <div className="page-head">
        <div className="stat-chips">
          <span className="stat-chip">
            <strong>{activas.length}</strong> activa{activas.length === 1 ? "" : "s"} de {branches.length}
          </span>
          <span className={`stat-chip${sinCalendario.length ? " warn" : ""}`}>
            <strong>{activas.length - sinCalendario.length}</strong> con calendario
          </span>
          <span className={`stat-chip${sinAsesor.length ? " warn" : ""}`}>
            <strong>{activas.length - sinAsesor.length}</strong> con asesor
          </span>
        </div>
        <span className="spacer" />
        <FormDialog
          trigger={
            <>
              <Icon name="mas" size={16} /> Nueva sucursal
            </>
          }
          triggerClassName="btn primary"
          title="Registrar sucursal"
          description="El agente la conocerá desde su siguiente conversación, sin tocar código."
          defaultOpen={nuevo === "1"}
        >
          <form action={createBranch} className="stack" style={{ gap: 18 }}>
            <BranchFields />
            <div className="form-actions">
              <button type="submit">Registrar sucursal</button>
            </div>
          </form>
        </FormDialog>
      </div>
      <PageHelp
        more={
          <p>
            El agente toma de aquí el nombre y la dirección de cada sucursal activa, y solo agenda citas donde hay un
            Google Calendar conectado. Un cambio se aplica a la siguiente conversación, sin tocar código.
          </p>
        }
      >
        Dónde atiende el negocio y dónde puede agendar el agente.
      </PageHelp>

      {ok && <div className="banner ok">{ok}</div>}
      {errorMessage && <div className="banner warn">{errorMessage}</div>}
      {/* Un solo aviso sobre el calendario: o faltan las credenciales, o faltan sucursales por conectar. */}
      {!ok && !errorMessage && !env.googleConfigured && (
        <div className="banner warn">
          <strong>Google Calendar aún no está conectado:</strong> faltan las credenciales de la cuenta de servicio, así que el agente no puede
          agendar y deriva las citas a un asesor. Guía paso a paso en el README → «Conectar Google Calendar».
        </div>
      )}
      {!ok && !errorMessage && env.googleConfigured && sinCalendario.length > 0 && (
        <div className="banner warn">
          <strong>Sin calendario:</strong> {sinCalendario.map((b) => b.nombre).join(", ")}. Ahí el agente no puede agendar y deriva la cita a un asesor.
        </div>
      )}

      <div className="branch-grid">
        {branches.map((b) => {
          const campaigns = b.meta_campaign_ids ?? [];
          const contactos = count(leadsQ.data, b.id);
          const asesores = atienden(b.id);
          const citas = count(apptsQ.data, b.id);
          return (
            <article key={b.id} className={`branch-card${b.activa ? "" : " inactive"}`}>
              <header className="branch-head">
                <span className="branch-ico">
                  <Icon name="sucursales" size={20} />
                </span>
                <div className="branch-title">
                  <h2>{b.nombre}</h2>
                  {b.activa ? <span className="tag ok">Activa</span> : <span className="tag">Inactiva</span>}
                </div>
                <span className="spacer" />
                <FormDialog trigger="Editar" title={`Editar ${b.nombre}`} description="Los cambios los usa el agente desde su siguiente conversación.">
                  <form action={updateBranch} className="stack" style={{ gap: 18 }}>
                    <input type="hidden" name="id" value={b.id} />
                    <BranchFields b={b} />
                    <div className="form-actions">
                      <button type="submit">Guardar cambios</button>
                    </div>
                  </form>
                </FormDialog>
              </header>

              <p className="branch-addr">{b.direccion}</p>

              {/* El id de Google mide más de 60 caracteres y se salía de la tarjeta. No es un dato del día a día:
                  se ve entero al pasar el cursor y al editar la sucursal. Aquí queda el estado, que es lo que importa. */}
              <div className="branch-chips">
                <span
                  className={`state-chip ${b.google_calendar_id && env.googleConfigured ? "ok" : "warn"}`}
                  title={b.google_calendar_id ? `Calendario de Google: ${b.google_calendar_id}` : "Sin calendario: el agente derivará las citas a un asesor"}
                >
                  <i aria-hidden="true">{b.google_calendar_id && env.googleConfigured ? "✓" : "!"}</i>
                  {b.google_calendar_id ? "Calendario asignado" : "Sin calendario"}
                </span>
                <span
                  className={`state-chip ${campaigns.length ? "ok" : ""}`}
                  title={campaigns.length ? `Anuncios de Meta: ${campaigns.join(", ")}` : "Los leads por anuncio no se asignarán solos a esta sucursal"}
                >
                  <i aria-hidden="true">{campaigns.length ? "✓" : "–"}</i>
                  {campaigns.length ? `${campaigns.length} anuncio${campaigns.length === 1 ? "" : "s"} de Meta` : "Sin anuncios de Meta"}
                </span>
              </div>

              <ul className="status-list">
                {!b.google_calendar_id && <li className="branch-todo">El agente no puede agendar aquí: pon el calendario en «Editar».</li>}
                {b.google_calendar_id && !env.googleConfigured && <li className="branch-todo">Tiene calendario, pero falta conectar Google (credenciales).</li>}
                {b.google_calendar_id && (
                  <li>
                    <form action={testBranchCalendar}>
                      <input type="hidden" name="id" value={b.id} />
                      <button type="submit" className="ghost btn-sm" title="Lee la disponibilidad y crea y borra un evento de prueba">
                        Probar conexión
                      </button>
                    </form>
                  </li>
                )}
              </ul>

              <div className="branch-stats">
                <Link href={`/leads?branch=${b.id}`}>
                  <strong>{contactos}</strong>contactos
                </Link>
                <Link href="/citas">
                  <strong>{citas}</strong>citas próximas
                </Link>
                <Link href="/equipo" className={asesores === 0 ? "zero" : undefined}>
                  <strong>{asesores}</strong>asesor{asesores === 1 ? "" : "es"}
                </Link>
              </div>
            </article>
          );
        })}
      </div>

      {branches.length === 0 && (
        <div className="card wide">
          <div className="empty-state">
            <span className="ico">
              <Icon name="sucursales" size={22} />
            </span>
            <strong>Aún no hay sucursales</strong>
            <p className="muted">Registra la primera para que el agente pueda dar su dirección y agendar citas.</p>
          </div>
        </div>
      )}
    </div>
  );
}
