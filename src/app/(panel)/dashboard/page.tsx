import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon, type IconName } from "@/components/icons";
import { requireUser, seesAllBranches } from "@/lib/session";
import { horaCorta } from "@/lib/time";
import { LEAD_ORIGINS, LEAD_ORIGIN_LABEL, type LeadOrigin, type LeadStage } from "@/lib/types";

const DAY_MS = 86_400_000;
const limaDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d); // YYYY-MM-DD
const startOfLimaDay = (d: Date) => new Date(`${limaDay(d)}T00:00:00-05:00`);
const hour = (iso: string) => horaCorta(new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" }).format(new Date(iso)));
const shortDay = (day: string) => new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00-05:00`));

/**
 * Tres ventanas y todas las cifras de la pantalla miden la misma. Antes el encabezado decía «últimos 7 días» pero
 * la asistencia era de 30, la conversión de siempre y las citas miraban hacia adelante: no se podían comparar.
 */
const PERIODS = {
  hoy: { label: "Hoy", prev: "ayer", chartDays: 7 },
  "7": { label: "7 días", prev: "los 7 días anteriores", chartDays: 7 },
  "30": { label: "30 días", prev: "los 30 días anteriores", chartDays: 30 },
} as const;
type Period = keyof typeof PERIODS;
// En este orden (Object.keys pondría primero las claves numéricas).
const PERIOD_ORDER: Period[] = ["hoy", "7", "30"];

interface LeadRow {
  id: string;
  stage: LeadStage;
  origin: LeadOrigin;
  created_at: string;
  archive_reason: string | null;
  branches: { nombre: string } | null;
  appointments: { status: string }[];
}
interface ApptRow {
  id: string;
  status: string;
  scheduled_at: string;
  created_at: string;
  leads: { nombre: string | null; phone: string | null } | null;
  branches: { nombre: string } | null;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const period: Period = sp.p === "hoy" || sp.p === "30" ? sp.p : "7";
  const P = PERIODS[period];
  const { supabase, profile } = await requireUser();

  const now = new Date();
  // Inicio del período actual y del anterior, del mismo largo, para comparar.
  const start = period === "hoy" ? startOfLimaDay(now) : new Date(now.getTime() - Number(period) * DAY_MS);
  const prevStart = period === "hoy" ? new Date(start.getTime() - DAY_MS) : new Date(start.getTime() - Number(period) * DAY_MS);
  const chartStart = startOfLimaDay(new Date(now.getTime() - (P.chartDays - 1) * DAY_MS));
  const since = new Date(Math.min(prevStart.getTime(), chartStart.getTime()));
  const endOfTomorrow = new Date(startOfLimaDay(now).getTime() + 2 * DAY_MS);

  // RLS acota todo a la sucursal del asesor (si la tiene); sin sucursal o administrador, ve el total.
  const [leadsQ, humanQ, msgsQ, createdQ, schedQ, unassignedQ] = await Promise.all([
    supabase
      .from("leads")
      .select("id, stage, origin, created_at, archive_reason, branches(nombre), appointments(status)")
      .gte("created_at", since.toISOString())
      .limit(10000),
    supabase.from("conversations").select("id", { count: "exact", head: true }).eq("requires_human", true),
    supabase.from("messages").select("sender").neq("sender", "lead").gte("created_at", start.toISOString()).limit(20000),
    // Citas AGENDADAS en el período (por cuándo se pidieron, no por cuándo son).
    supabase
      .from("appointments")
      .select("id, status, scheduled_at, created_at, leads(nombre, phone), branches(nombre)")
      .gte("created_at", since.toISOString())
      .limit(10000),
    // Citas que TOCABAN en el período (asistencia) y las de hoy y mañana (agenda).
    supabase
      .from("appointments")
      .select("id, status, scheduled_at, created_at, leads(nombre, phone), branches(nombre)")
      .gte("scheduled_at", prevStart.toISOString())
      .lt("scheduled_at", endOfTomorrow.toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10000),
    supabase.from("conversations").select("id", { count: "exact", head: true }).is("assigned_to", null).eq("bot_active", false),
  ]);
  for (const q of [leadsQ, humanQ, msgsQ, createdQ, schedQ, unassignedQ]) if (q.error) throw q.error;

  // Proveedores, spam y números equivocados no son clientes: no cuentan en ninguna cifra.
  const allLeads = ((leadsQ.data ?? []) as unknown as LeadRow[]).filter((l) => l.archive_reason !== "no_es_cliente");
  const created = (createdQ.data ?? []) as unknown as ApptRow[];
  const sched = (schedQ.data ?? []) as unknown as ApptRow[];

  const inRange = (iso: string, from: Date, to: Date) => {
    const t = new Date(iso).getTime();
    return t >= from.getTime() && t < to.getTime();
  };
  const booked = (l: LeadRow) => l.appointments.some((a) => a.status !== "cancelada");
  const cameIn = (l: LeadRow) => l.appointments.some((a) => a.status === "atendida");

  // ── Las cuatro cifras del período, con su comparación ──
  function measure(from: Date, to: Date) {
    const leads = allLeads.filter((l) => inRange(l.created_at, from, to));
    const citas = created.filter((a) => a.status !== "cancelada" && inRange(a.created_at, from, to)).length;
    const conAgenda = leads.filter(booked).length;
    const pasadas = sched.filter((a) => inRange(a.scheduled_at, from, to) && new Date(a.scheduled_at) < now);
    const vinieron = pasadas.filter((a) => a.status === "atendida").length;
    const faltaron = pasadas.filter((a) => a.status === "no_show").length;
    return {
      leads,
      citas,
      conversion: leads.length ? Math.round((conAgenda / leads.length) * 100) : null,
      asistencia: vinieron + faltaron ? Math.round((vinieron / (vinieron + faltaron)) * 100) : null,
      porMarcar: pasadas.filter((a) => a.status === "agendada" || a.status === "confirmada").length,
    };
  }
  const cur = measure(start, now);
  const prev = measure(prevStart, start);

  // ── Embudo del período: de cada 100 que escribieron, cuántos llegaron a cada paso ──
  const funnel = [
    { label: "Escribieron", value: cur.leads.length, hint: "Contactos nuevos del período" },
    { label: "Les respondimos", value: cur.leads.filter((l) => l.stage !== "nuevo").length, hint: "El bot o una persona les contestó" },
    { label: "Agendaron", value: cur.leads.filter(booked).length, hint: "Tienen o tuvieron una cita (sin contar canceladas)" },
    { label: "Vinieron", value: cur.leads.filter(cameIn).length, hint: "Su cita quedó marcada como atendida" },
  ];

  // ── Por día: cuánta gente escribió y cuántas citas se agendaron ──
  const days = Array.from({ length: P.chartDays }, (_, i) => limaDay(new Date(chartStart.getTime() + i * DAY_MS + 12 * 3_600_000)));
  const perDay = new Map(days.map((d) => [d, { leads: 0, citas: 0 }]));
  for (const l of allLeads) {
    const b = perDay.get(limaDay(new Date(l.created_at)));
    if (b) b.leads++;
  }
  for (const a of created) {
    const b = perDay.get(limaDay(new Date(a.created_at)));
    if (b && a.status !== "cancelada") b.citas++;
  }
  const maxDay = Math.max(1, ...[...perDay.values()].map((v) => Math.max(v.leads, v.citas)));
  const daysWithData = [...perDay.values()].filter((v) => v.leads + v.citas > 0).length;
  const today = limaDay(now);

  // ── De dónde vienen y en qué sucursal: leads y cuántos agendaron ──
  const porOrigen = LEAD_ORIGINS.map((o) => {
    const suyos = cur.leads.filter((l) => l.origin === o);
    return { key: o, label: LEAD_ORIGIN_LABEL[o], leads: suyos.length, citas: suyos.filter(booked).length };
  }).filter((r) => r.leads > 0);
  const sucursales = new Map<string, { leads: number; citas: number }>();
  for (const l of cur.leads) {
    const k = l.branches?.nombre ?? "Sin sucursal";
    const r = sucursales.get(k) ?? { leads: 0, citas: 0 };
    r.leads++;
    if (booked(l)) r.citas++;
    sucursales.set(k, r);
  }
  const porSucursal = [...sucursales.entries()].map(([label, v]) => ({ key: label, label, ...v })).sort((a, b) => b.leads - a.leads);

  // ── Agenda de hoy y mañana ──
  const agenda = sched.filter((a) => (a.status === "agendada" || a.status === "confirmada") && new Date(a.scheduled_at) >= now).slice(0, 8);

  // ── Lo que exige una decisión hoy ──
  const porMarcarTotal = sched.filter((a) => new Date(a.scheduled_at) < now && (a.status === "agendada" || a.status === "confirmada")).length;
  const todo: { label: string; value: number; href: string; icon: IconName }[] = [];
  if (humanQ.count) todo.push({ label: humanQ.count === 1 ? "chat espera a una persona" : "chats esperan a una persona", value: humanQ.count, href: "/inbox", icon: "inbox" });
  if (porMarcarTotal) todo.push({ label: porMarcarTotal === 1 ? "cita por marcar" : "citas por marcar", value: porMarcarTotal, href: "/citas", icon: "reloj" });
  if (unassignedQ.count) todo.push({ label: unassignedQ.count === 1 ? "chat pausado sin asignar" : "chats pausados sin asignar", value: unassignedQ.count, href: "/inbox", icon: "usuario" });

  const salientes = (msgsQ.data ?? []) as { sender: "bot" | "humano" }[];
  const botShare = salientes.length ? Math.round((salientes.filter((m) => m.sender === "bot").length / salientes.length) * 100) : null;

  return (
    <div className="page">
      <h1>Resumen</h1>

      <div className="dash-head">
        <p className="page-intro" style={{ margin: 0 }}>
          {seesAllBranches(profile) ? "Todas las sucursales" : "Tu sucursal"}
        </p>
        <span className="spacer" />
        <nav className="tabs-inline" aria-label="Período">
          {PERIOD_ORDER.map((k) =>
            k === period ? (
              <span key={k} className="active" aria-current="true">
                {PERIODS[k].label}
              </span>
            ) : (
              <Link key={k} href={k === "7" ? "/dashboard" : `/dashboard?p=${k}`}>
                {PERIODS[k].label}
              </Link>
            ),
          )}
        </nav>
      </div>

      {/* Primero lo que pide una decisión hoy; si no hay nada pendiente, se dice y ya. */}
      {todo.length > 0 ? (
        <div className="todo-row">
          {todo.map((t) => (
            <Link key={t.href + t.label} href={t.href} className="todo">
              <span className="todo-ico">
                <Icon name={t.icon} size={20} />
              </span>
              <span>
                <b>{t.value}</b>
                <span>{t.label}</span>
              </span>
              <span className="todo-go" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="all-clear">
          <Icon name="chequeo" size={17} /> Nada pendiente: ningún chat espera a una persona y no hay citas por marcar.
        </p>
      )}

      {/* Las cuatro cifras del período: todas miden la misma ventana y se comparan con la anterior. */}
      <div className="headline">
        <Headline label="Conversaciones nuevas" value={cur.leads.length} delta={cur.leads.length - prev.leads.length} unit="" prevLabel={P.prev} />
        <Headline label="Citas agendadas" value={cur.citas} delta={cur.citas - prev.citas} unit="" prevLabel={P.prev} href="/citas" />
        <Headline
          label="Conversión a cita"
          value={cur.conversion === null ? "—" : `${cur.conversion}%`}
          delta={cur.conversion === null || prev.conversion === null ? null : cur.conversion - prev.conversion}
          unit=" pts"
          prevLabel={P.prev}
          featured
          hint="De los que escribieron en el período, cuántos agendaron"
        />
        <Headline
          label="Asistencia"
          value={cur.asistencia === null ? "—" : `${cur.asistencia}%`}
          delta={cur.asistencia === null || prev.asistencia === null ? null : cur.asistencia - prev.asistencia}
          unit=" pts"
          prevLabel={P.prev}
          hint="De las citas que ya pasaron y están marcadas, cuántas vinieron"
          note={cur.porMarcar ? `${cur.porMarcar} sin marcar` : undefined}
        />
      </div>

      <div className="dash-grid">
        <section className="card wide chart-card">
          <div className="card-head">
            <h2>Conversaciones y citas por día</h2>
            <span className="muted">{P.chartDays === 30 ? "Últimos 30 días" : "Últimos 7 días"}</span>
          </div>
          {daysWithData < 3 ? (
            <p className="chart-thin">
              <b>{[...perDay.values()].reduce((n, v) => n + v.leads, 0)}</b>{[...perDay.values()].reduce((n, v) => n + v.leads, 0) === 1 ? " conversación" : " conversaciones"} y{" "}
              <b>{[...perDay.values()].reduce((n, v) => n + v.citas, 0)}</b>{[...perDay.values()].reduce((n, v) => n + v.citas, 0) === 1 ? " cita" : " citas"} en {daysWithData === 0 ? "el período" : daysWithData === 1 ? "un solo día" : "dos días"}.
              <span className="muted"> El gráfico aparece cuando haya actividad en al menos tres días.</span>
            </p>
          ) : (
            <>
              <div className={`bars2${P.chartDays === 30 ? " dense" : ""}`} role="img" aria-label="Conversaciones nuevas y citas agendadas por día">
                {days.map((d, i) => {
                  const v = perDay.get(d)!;
                  const showLabel = P.chartDays === 7 || i % 5 === 0 || i === days.length - 1;
                  return (
                    <div key={d} className={`b2-col${d === today ? " today" : ""}`} title={`${shortDay(d)}: ${v.leads} conversaciones, ${v.citas} citas`}>
                      <div className="b2-bars">
                        <i className="b2 leads" style={{ height: `${(v.leads / maxDay) * 100}%` }} />
                        <i className="b2 citas" style={{ height: `${(v.citas / maxDay) * 100}%` }} />
                      </div>
                      <span className="b2-label">{showLabel ? (d === today ? "Hoy" : shortDay(d)) : ""}</span>
                    </div>
                  );
                })}
              </div>
              <p className="legend muted">
                <i className="dot b2-leads" /> Conversaciones nuevas <i className="dot b2-citas" /> Citas agendadas
              </p>
            </>
          )}
        </section>

        <section className="card wide">
          <div className="card-head">
            <h2>Próximas citas</h2>
            <Link href="/citas" className="muted">
              Ver todas →
            </Link>
          </div>
          {agenda.length === 0 ? (
            <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
              No hay citas para hoy ni mañana.
            </p>
          ) : (
            <ul className="agenda">
              {agenda.map((a) => (
                <li key={a.id}>
                  <span className="ag-when">
                    <b>{hour(a.scheduled_at)}</b>
                    <span>{limaDay(new Date(a.scheduled_at)) === today ? "Hoy" : "Mañana"}</span>
                  </span>
                  <Avatar name={a.leads?.nombre ?? null} size="sm" />
                  <span className="ag-who">
                    <strong>{a.leads?.nombre ?? a.leads?.phone ?? "Sin nombre"}</strong>
                    <span className="muted">{a.branches?.nombre}</span>
                  </span>
                  {a.status === "confirmada" && <span className="tag ok">Confirmó</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card wide">
          <div className="card-head">
            <h2>Embudo</h2>
            <span className="muted">{period === "hoy" ? "Hoy" : `Últimos ${P.label}`}</span>
          </div>
          <ol className="funnel">
            {funnel.map((s, i) => {
              const base = funnel[0].value;
              const pct = base ? Math.round((s.value / base) * 100) : 0;
              const prevStep = i > 0 ? funnel[i - 1].value : null;
              const step = prevStep ? Math.round((s.value / prevStep) * 100) : null;
              return (
                <li key={s.label} title={s.hint}>
                  <div className="fn-row">
                    <span className="fn-label">{s.label}</span>
                    <strong>{s.value}</strong>
                  </div>
                  <div className="track">
                    <div className="fill" style={{ width: `${base ? Math.max(pct, s.value ? 2 : 0) : 0}%` }} />
                  </div>
                  {i > 0 && base > 0 && <span className="fn-step">{step === null ? "—" : `${step}% del paso anterior`}</span>}
                </li>
              );
            })}
          </ol>
        </section>

        <section className="card wide">
          <div className="card-head">
            <h2>De dónde vienen</h2>
            <Link href="/anuncios" className="muted">
              Anuncios →
            </Link>
          </div>
          <Breakdown rows={porOrigen} empty="Aún no hay contactos en el período." />
        </section>

        <section className="card wide span2">
          <div className="card-head">
            <h2>Por sucursal</h2>
            <span className="muted hide-sm">Conversaciones nuevas y cuántas agendaron</span>
          </div>
          <Breakdown rows={porSucursal} empty="Aún no hay contactos en el período." />
        </section>
      </div>

      {botShare !== null && (
        <p className="agent-foot muted">
          <Icon name="respuestas" size={15} /> El agente envió el <strong>{botShare}%</strong> de las respuestas del período; el resto, tu equipo.{" "}
          <Link href="/sistema">Ver cómo va el agente →</Link>
        </p>
      )}
    </div>
  );
}

/** Una cifra principal con su comparación contra el período anterior (en unidades, no en %: con números chicos, «+100%» engaña). */
function Headline({
  label,
  value,
  delta,
  unit,
  prevLabel,
  href,
  hint,
  note,
  featured,
}: {
  label: string;
  value: number | string;
  delta: number | null;
  unit: string;
  prevLabel: string;
  href?: string;
  hint?: string;
  note?: string;
  featured?: boolean;
}) {
  const dir = delta === null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const body = (
    <>
      <span className="hl-label">{label}</span>
      <span className="hl-value">{value}</span>
      <span className={`hl-delta ${dir}`}>
        {delta === null ? "Sin datos para comparar" : delta === 0 ? `Igual que ${prevLabel}` : `${delta > 0 ? "▲ +" : "▼ "}${delta}${unit} vs ${prevLabel}`}
      </span>
      {note && <span className="hl-note">{note}</span>}
    </>
  );
  const cls = `hl${featured ? " featured" : ""}`;
  return href ? (
    <Link href={href} className={cls} title={hint}>
      {body}
    </Link>
  ) : (
    <div className={cls} title={hint}>
      {body}
    </div>
  );
}

/** Cuántos contactos hay en cada grupo y cuántos de ellos agendaron. */
function Breakdown({ rows, empty }: { rows: { key: string; label: string; leads: number; citas: number }[]; empty: string }) {
  if (rows.length === 0) return <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <div className="breakdown">
      {rows.map((r) => (
        <div key={r.key} className="bd-row">
          <span className="bd-label">{r.label}</span>
          <div className="bd-track" aria-hidden="true">
            <i className="bd-leads" style={{ width: `${(r.leads / max) * 100}%` }} />
            <i className="bd-citas" style={{ width: `${(r.citas / max) * 100}%` }} />
          </div>
          <span className="bd-nums">
            <strong>{r.leads}</strong> · {r.citas} con cita
          </span>
        </div>
      ))}
    </div>
  );
}
