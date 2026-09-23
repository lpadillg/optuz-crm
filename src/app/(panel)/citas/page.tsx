import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icons";
import { requireUser } from "@/lib/session";
import { horaCorta } from "@/lib/time";
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABEL, type AppointmentStatus } from "@/lib/types";
import { updateAppointmentStatus } from "../actions";

const hour = (iso: string) =>
  horaCorta(new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" }).format(new Date(iso)));

const limaDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d);

/** "Hoy", "Mañana" o el día escrito. */
function dayLabel(iso: string) {
  const day = limaDay(new Date(iso));
  if (day === limaDay(new Date())) return "Hoy";
  if (day === limaDay(new Date(Date.now() + 86_400_000))) return "Mañana";
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
}

/** "Hoy a las 10:00", "ayer a las 15:30", "el lunes 15 a las 9:00": para las que ya pasaron. */
function pastLabel(iso: string) {
  const day = limaDay(new Date(iso));
  const when = hour(iso);
  if (day === limaDay(new Date())) return `Hoy a las ${when}`;
  if (day === limaDay(new Date(Date.now() - 86_400_000))) return `Ayer a las ${when}`;
  const d = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
  return `El ${d} a las ${when}`;
}

const DAY_MS = 86_400_000;
/** Cuánto hacia atrás se buscan citas sin marcar. */
const PENDING_DAYS = 30;

interface Row {
  id: string;
  scheduled_at: string;
  status: AppointmentStatus;
  leads: { nombre: string | null; phone: string | null } | null;
  branches: { nombre: string } | null;
  promotions: { titulo: string } | null;
}

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const historial = sp.ver === "historial";
  const { supabase } = await requireUser();

  // La agenda mira 30 días atrás (lo que falta marcar); el historial, los últimos 90 días.
  const lookBackDays = historial ? 90 : PENDING_DAYS;
  const from = new Date(Date.now() - lookBackDays * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .select("id, scheduled_at, status, leads(nombre, phone), branches(nombre), promotions(titulo)")
    .gte("scheduled_at", from)
    .order("scheduled_at", { ascending: true })
    .limit(300);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Row[];
  const now = Date.now();
  const startOfToday = new Date(`${limaDay(new Date())}T00:00:00-05:00`).getTime();
  const passed = (a: Row) => new Date(a.scheduled_at).getTime() < now;

  // Ya pasaron y siguen en «agendada»/«confirmada»: nadie anotó si el cliente vino. Lo más reciente primero.
  const pending = rows
    .filter((a) => passed(a) && (a.status === "agendada" || a.status === "confirmada"))
    .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at));

  // La agenda: lo que viene, más lo de hoy que ya pasó pero alguien ya resolvió (para ver el día completo).
  // Las canceladas ya liberaron su hueco: solo se cuentan al pie.
  const fromToday = rows.filter((a) => !pending.includes(a) && new Date(a.scheduled_at).getTime() >= startOfToday);
  const agenda = fromToday.filter((a) => a.status !== "cancelada");
  const cancelledRows = fromToday.filter((a) => a.status === "cancelada");
  const cancelled = cancelledRows.length;

  const days: { key: string; label: string; items: Row[] }[] = [];
  for (const a of agenda) {
    const key = limaDay(new Date(a.scheduled_at));
    const last = days.at(-1);
    if (last?.key === key) last.items.push(a);
    else days.push({ key, label: dayLabel(a.scheduled_at), items: [a] });
  }

  // Historial: lo que ya ocurrió, de lo más reciente a lo más antiguo, con el porcentaje de asistencia.
  const past = rows
    .filter((a) => passed(a) && a.status !== "cancelada")
    .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at));
  const attended = past.filter((a) => a.status === "atendida").length;
  const noShow = past.filter((a) => a.status === "no_show").length;
  const resolved = attended + noShow;

  if (historial) {
    return (
      <div className="page">
        <h1>Citas</h1>
        <div className="row-head">
          <div className="tabs-inline">
            <Link href="/citas">Agenda</Link>
            <span className="active">Historial</span>
          </div>
          <span className="spacer" />
          <span className="muted">Últimos 90 días</span>
        </div>

        <div className="kpis compact">
          <div className="kpi">
            <span>
              <span className="kpi-value">{past.length}</span>
              <span className="kpi-label" style={{ display: "block" }}>Citas que ya pasaron</span>
            </span>
          </div>
          <div className="kpi">
            <span>
              <span className="kpi-value">{resolved ? `${Math.round((attended / resolved) * 100)}%` : "—"}</span>
              <span className="kpi-label" style={{ display: "block" }}>Asistencia</span>
            </span>
          </div>
          <div className="kpi">
            <span>
              <span className="kpi-value">{attended}</span>
              <span className="kpi-label" style={{ display: "block" }}>Atendidas</span>
            </span>
          </div>
          <div className={`kpi${noShow ? " warn" : ""}`}>
            <span>
              <span className="kpi-value">{noShow}</span>
              <span className="kpi-label" style={{ display: "block" }}>No asistieron</span>
            </span>
          </div>
        </div>

        {past.length === 0 ? (
          <div className="card wide">
            <div className="empty-state">
              <span className="ico">
                <Icon name="citas" size={22} />
              </span>
              <strong>Todavía no hay citas pasadas</strong>
              <p className="muted">Aquí verás cuántas personas vinieron y cuántas faltaron.</p>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Cliente</th>
                  <th className="hide-sm">Sucursal</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {past.map((a) => (
                  <tr key={a.id}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {dayLabel(a.scheduled_at)}, {hour(a.scheduled_at)}
                    </td>
                    <td className="cell-main">{a.leads?.nombre ?? "Sin nombre"}</td>
                    <td className="hide-sm">{a.branches?.nombre}</td>
                    <td>
                      {a.status === "atendida" && <span className="tag ok">Atendida</span>}
                      {a.status === "no_show" && <span className="tag warn">No asistió</span>}
                      {(a.status === "agendada" || a.status === "confirmada") && <span className="tag">Sin marcar</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Citas</h1>
      <div className="row-head">
        <div className="tabs-inline">
          <span className="active">Agenda</span>
          <Link href="/citas?ver=historial">Historial</Link>
        </div>
      </div>
      <p className="page-intro">
        Examen visual gratuito. Arriba, las que ya pasaron y falta anotar si el cliente vino: eso alimenta el resumen y el
        seguimiento. Debajo, la agenda de hoy en adelante.
      </p>

      {pending.length > 0 && (
        <section className="day-group">
          <div className="day-head">
            <h2>Pendientes de marcar</h2>
            <span className="tag warn">
              {pending.length} cita{pending.length === 1 ? "" : "s"} ya {pending.length === 1 ? "pasó" : "pasaron"}
            </span>
          </div>
          <div className="appt-list">
            {pending.map((a) => (
              <article key={a.id} className="appt pending">
                <div className="appt-top">
                  <Avatar name={a.leads?.nombre} />
                  <div style={{ minWidth: 0 }}>
                    <strong>{a.leads?.nombre ?? "Sin nombre"}</strong>
                    <div className="cell-sub">{a.leads?.phone ?? "sin número visible"}</div>
                  </div>
                </div>
                <div className="appt-when">{pastLabel(a.scheduled_at)}</div>
                <div className="inline">
                  <span className="tag">{a.branches?.nombre}</span>
                  {a.promotions?.titulo && <span className="tag ok">{a.promotions.titulo}</span>}
                </div>
                <div className="appt-ask">
                  <span>¿Vino?</span>
                  <form action={updateAppointmentStatus}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="status" value="atendida" />
                    <button type="submit" className="btn-sm">
                      Sí, atendida
                    </button>
                  </form>
                  <form action={updateAppointmentStatus}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="status" value="no_show" />
                    <button type="submit" className="ghost btn-sm">
                      No asistió
                    </button>
                  </form>
                  <form action={updateAppointmentStatus}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="status" value="cancelada" />
                    <button type="submit" className="ghost btn-sm" title="Se canceló y nadie lo anotó: también libera el hueco en Google Calendar">
                      Se canceló
                    </button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {days.length === 0 && (
        <div className="card wide">
          <div className="empty-state">
            <span className="ico">
              <Icon name="citas" size={22} />
            </span>
            <strong>No hay citas próximas</strong>
            <p className="muted">
              El agente agenda solo cuando la sucursal tiene su Google Calendar conectado. Revísalo en Sucursales.
            </p>
          </div>
        </div>
      )}

      {days.map((d) => (
        <section key={d.key} className="day-group">
          <div className="day-head">
            <h2>{d.label}</h2>
            <span className="muted">
              {d.items.length} cita{d.items.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="appt-list">
            {d.items.map((a) => (
              <article key={a.id} className={`appt${passed(a) ? " past" : ""}`}>
                <div className="appt-top">
                  <span className="appt-time">{hour(a.scheduled_at)}</span>
                  <Avatar name={a.leads?.nombre} />
                  <div style={{ minWidth: 0 }}>
                    <strong>{a.leads?.nombre ?? "Sin nombre"}</strong>
                    <div className="cell-sub">{a.leads?.phone ?? "sin número visible"}</div>
                  </div>
                </div>
                <div className="inline">
                  <span className="tag">{a.branches?.nombre}</span>
                  {a.promotions?.titulo && <span className="tag ok">{a.promotions.titulo}</span>}
                </div>
                <form action={updateAppointmentStatus}>
                  <input type="hidden" name="id" value={a.id} />
                  <select name="status" defaultValue={a.status} aria-label={`Estado de la cita de ${a.leads?.nombre ?? "el cliente"}`}>
                    {APPOINTMENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {APPOINTMENT_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="ghost btn-sm">
                    Guardar
                  </button>
                </form>
              </article>
            ))}
          </div>
        </section>
      ))}

      {cancelled > 0 && (
        <details className="cancelled-box">
          <summary>
            {cancelled} cita{cancelled === 1 ? " cancelada" : "s canceladas"}: su horario volvió a quedar libre
          </summary>
          <ul>
            {cancelledRows.map((a) => (
              <li key={a.id}>
                <strong>{dayLabel(a.scheduled_at)}</strong> a las {hour(a.scheduled_at)} · {a.leads?.nombre ?? "Sin nombre"} · {a.branches?.nombre}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
