import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icons";
import { requireUser } from "@/lib/session";
import { horaCorta } from "@/lib/time";
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABEL, type AppointmentStatus } from "@/lib/types";
import { reprogramarCita, updateAppointmentStatus } from "../actions";
import { FiltroSede } from "./filtro-sede";

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

/** "hoy", "ayer" o "lun 22": el día de una cita que ya pasó, sin repetir la hora que va al lado. */
function diaCorto(iso: string) {
  const day = limaDay(new Date(iso));
  if (day === limaDay(new Date())) return "hoy";
  if (day === limaDay(new Date(Date.now() - 86_400_000))) return "ayer";
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "short", day: "numeric" }).format(new Date(iso)).replace(".", "");
}

/** "YYYY-MM-DDTHH:mm" en hora de Lima, que es lo que espera un <input type="datetime-local">. */
const localInput = (iso: string) => {
  const d = new Date(iso);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
};

const DAY_MS = 86_400_000;
/** Cuánto hacia atrás se buscan citas sin marcar. */
const PENDING_DAYS = 30;

interface Row {
  id: string;
  scheduled_at: string;
  status: AppointmentStatus;
  paciente: string | null;
  leads: { nombre: string | null; phone: string | null } | null;
  branches: { nombre: string } | null;
  promotions: { titulo: string } | null;
}

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const historial = sp.ver === "historial";
  const sede = typeof sp.sede === "string" ? sp.sede : "";
  const { supabase } = await requireUser();

  // La agenda mira 30 días atrás (lo que falta marcar); el historial, los últimos 90 días.
  const lookBackDays = historial ? 90 : PENDING_DAYS;
  const from = new Date(Date.now() - lookBackDays * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .select("id, scheduled_at, status, paciente, leads(nombre, phone), branches(nombre), promotions(titulo)")
    .gte("scheduled_at", from)
    .order("scheduled_at", { ascending: true })
    .limit(300);
  if (error) throw error;

  const { data: branchRows } = await supabase.from("branches").select("id, nombre").order("nombre");
  const branches = (branchRows ?? []) as { id: string; nombre: string }[];

  // El filtro se aplica sobre lo ya cargado: son como mucho 300 citas de un rango corto.
  const todas = (data ?? []) as unknown as Row[];
  const rows = sede ? todas.filter((a) => a.branches?.nombre === sede) : todas;
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

  const days: { key: string; label: string; esHoy: boolean; items: Row[] }[] = [];
  const claveHoy = limaDay(new Date());
  for (const a of agenda) {
    const key = limaDay(new Date(a.scheduled_at));
    const last = days.at(-1);
    if (last?.key === key) last.items.push(a);
    else days.push({ key, label: dayLabel(a.scheduled_at), esHoy: key === claveHoy, items: [a] });
  }

  // Las cuatro cifras de la cabecera: lo que hay que saber del día sin leer la lista entera.
  const hoy = agenda.filter((a) => limaDay(new Date(a.scheduled_at)) === claveHoy);
  const sinConfirmar = agenda.filter((a) => a.status === "agendada" && new Date(a.scheduled_at).getTime() > now).length;
  const estaSemana = agenda.filter((a) => {
    const t = new Date(a.scheduled_at).getTime();
    return t > now && t <= now + 7 * DAY_MS;
  }).length;

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
        <span className="spacer" />
        {branches.length > 1 && <FiltroSede branches={branches} sede={sede} />}
      </div>

      {/* Lo que hay que saber del día antes de mirar nada más. */}
      <div className="kpis compact">
        <div className="kpi">
          <span>
            <span className="kpi-value">{hoy.length}</span>
            <span className="kpi-label" style={{ display: "block" }}>Citas hoy</span>
          </span>
        </div>
        <div className={`kpi${sinConfirmar > 0 ? " warn" : ""}`}>
          <span>
            <span className="kpi-value">{sinConfirmar}</span>
            <span className="kpi-label" style={{ display: "block" }}>Sin confirmar</span>
          </span>
        </div>
        <div className="kpi">
          <span>
            <span className="kpi-value">{estaSemana}</span>
            <span className="kpi-label" style={{ display: "block" }}>Próximos 7 días</span>
          </span>
        </div>
        <div className={`kpi${pending.length > 0 ? " warn" : ""}`}>
          <span>
            <span className="kpi-value">{pending.length}</span>
            <span className="kpi-label" style={{ display: "block" }}>Falta anotar si vinieron</span>
          </span>
        </div>
      </div>

      {pending.length > 0 && (
        <section className="grupo-dia pendientes">
          <div className="grupo-head">
            <h2>Falta anotar si vinieron</h2>
            <span className="tag warn">{pending.length}</span>
            <span className="spacer" />
            <span className="muted hide-sm">Sin esto, el resumen y el seguimiento van ciegos</span>
          </div>
          <div className="citas">
            {pending.map((a) => (
              <article key={a.id} className="cita pendiente">
                <div className="cita-cuando">
                  <strong>{hour(a.scheduled_at)}</strong>
                  <span className="muted">{diaCorto(a.scheduled_at)}</span>
                </div>
                <Persona a={a} />
                <div className="cita-tags">
                  <span className="tag">{a.branches?.nombre}</span>
                  {a.promotions?.titulo && <span className="tag ok">{a.promotions.titulo}</span>}
                </div>
                <div className="cita-acciones">
                  <Marcar id={a.id} status="atendida" clase="btn-sm" texto="Vino" />
                  <Marcar id={a.id} status="no_show" clase="ghost btn-sm" texto="No vino" />
                  <Marcar id={a.id} status="cancelada" clase="ghost btn-sm" texto="Se canceló" titulo="Se canceló y nadie lo anotó: libera el hueco en Google Calendar" />
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
        <section key={d.key} className={`grupo-dia${d.esHoy ? " es-hoy" : ""}`}>
          <div className="grupo-head">
            <h2>{d.label}</h2>
            <span className="muted">
              {d.items.length} cita{d.items.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="citas">
            {d.items.map((a) => {
              const yaPaso = passed(a);
              const enCurso = !yaPaso && new Date(a.scheduled_at).getTime() - now < 30 * 60_000;
              return (
                <article key={a.id} className={`cita${yaPaso ? " past" : ""}${enCurso ? " ahora" : ""}`}>
                  <div className="cita-cuando">
                    <strong>{hour(a.scheduled_at)}</strong>
                    {enCurso && <span className="tag warn">ahora</span>}
                  </div>
                  <Persona a={a} />
                  <div className="cita-tags">
                    <span className="tag">{a.branches?.nombre}</span>
                    {a.status === "confirmada" ? (
                      <span className="tag ok" title="El cliente respondió al recordatorio">
                        Confirmada
                      </span>
                    ) : (
                      <span className="tag" title="Aún no ha confirmado su asistencia">
                        Sin confirmar
                      </span>
                    )}
                    {a.promotions?.titulo && <span className="tag ok">{a.promotions.titulo}</span>}
                  </div>
                  <div className="cita-acciones">
                    {yaPaso ? (
                      <>
                        <Marcar id={a.id} status="atendida" clase="btn-sm" texto="Vino" />
                        <Marcar id={a.id} status="no_show" clase="ghost btn-sm" texto="No vino" />
                      </>
                    ) : (
                      <>
                        <details className="mover">
                          <summary>Reagendar</summary>
                          <form action={reprogramarCita} className="mover-form">
                            <input type="hidden" name="id" value={a.id} />
                            <label>
                              Nueva fecha y hora
                              <input type="datetime-local" name="starts_at" defaultValue={localInput(a.scheduled_at)} step={1800} required />
                            </label>
                            <label>
                              Sucursal
                              <select name="branch_id" defaultValue="">
                                <option value="">La misma ({a.branches?.nombre})</option>
                                {branches.map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.nombre}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="check">
                              <input type="checkbox" name="avisar" value="1" defaultChecked />
                              Avisarle por WhatsApp
                            </label>
                            <button type="submit" className="btn-sm">
                              Reagendar
                            </button>
                          </form>
                        </details>
                        <Marcar id={a.id} status="cancelada" clase="ghost btn-sm" texto="Cancelar" titulo="Libera el hueco, también en Google Calendar" />
                      </>
                    )}
                  </div>
                </article>
              );
            })}
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

/** Quién viene: el paciente en grande y, debajo, quién lo agendó o su teléfono. */
function Persona({ a }: { a: Row }) {
  const distinto = a.paciente && a.paciente !== a.leads?.nombre;
  return (
    <div className="cita-quien">
      <Avatar name={a.paciente ?? a.leads?.nombre} />
      <div style={{ minWidth: 0 }}>
        <strong>{a.paciente ?? a.leads?.nombre ?? "Sin nombre"}</strong>
        <div className="cell-sub">{distinto ? `Agendó ${a.leads?.nombre ?? "un contacto"}` : (a.leads?.phone ?? "sin número visible")}</div>
      </div>
    </div>
  );
}

/** Un botón que deja la cita en un estado. Es un formulario porque cambia datos: no vale un enlace. */
function Marcar({ id, status, texto, clase, titulo }: { id: string; status: AppointmentStatus; texto: string; clase: string; titulo?: string }) {
  return (
    <form action={updateAppointmentStatus}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <button type="submit" className={clase} title={titulo}>
        {texto}
      </button>
    </form>
  );
}
