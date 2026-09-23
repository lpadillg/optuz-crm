import Link from "next/link";
import { retryFailedJob } from "@/app/(panel)/crm-actions";
import { Icon } from "@/components/icons";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { fetchNumberHealth, QUALITY_LABEL, TIER_LABEL } from "@/lib/whatsapp/health";

const DAY = 86_400_000;
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));

/** «hace 3 min», «hace 2 h». */
function ago(iso: string | null | undefined) {
  if (!iso) return "nunca";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "hace segundos";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

const OUTCOME: Record<string, { label: string; tone: string }> = {
  reply: { label: "Respondió", tone: "ok" },
  refusal: { label: "Derivó (rechazo)", tone: "warn" },
  skipped: { label: "Omitida", tone: "" },
  error: { label: "Error", tone: "err" },
};

export default async function SystemPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireAdmin();
  const since = new Date(Date.now() - DAY).toISOString();

  const [pendingQ, overdueQ, failedQ, failedRowsQ, runsQ, lastEventQ, badEventsQ, branchesQ, health, upQ, downQ, badRepliesQ] = await Promise.all([
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "pending").lt("run_at", new Date(Date.now() - 2 * 60_000).toISOString()),
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("created_at", since),
    supabase.from("jobs").select("id, kind, attempts, last_error, finished_at").eq("status", "failed").order("finished_at", { ascending: false }).limit(15),
    supabase
      .from("agent_runs")
      .select("id, conversation_id, outcome, detail, duration_ms, input_tokens, output_tokens, tool_calls, model, created_at, conversations(leads(nombre, phone))")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(300),
    supabase.from("webhook_events").select("received_at").order("received_at", { ascending: false }).limit(1),
    supabase.from("webhook_events").select("event_id", { count: "exact", head: true }).not("error", "is", null).gte("received_at", since),
    supabase.from("branches").select("google_calendar_id").eq("activa", true),
    fetchNumberHealth(),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("feedback", 1),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("feedback", -1),
    supabase
      .from("messages")
      .select("id, content, feedback_note, created_at, conversation_id, conversations(leads(nombre, phone))")
      .eq("feedback", -1)
      .order("created_at", { ascending: false })
      .limit(15),
  ]);
  type BadReply = { id: string; content: string; feedback_note: string | null; created_at: string; conversation_id: string; conversations: { leads: { nombre: string | null; phone: string | null } | null } | null };
  const badReplies = (badRepliesQ.data ?? []) as unknown as BadReply[];

  type Run = {
    id: string;
    conversation_id: string;
    outcome: string;
    detail: string | null;
    duration_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    tool_calls: { name: string; ms: number; ok: boolean }[];
    model: string | null;
    created_at: string;
    conversations: { leads: { nombre: string | null; phone: string | null } | null } | null;
  };
  const runs = (runsQ.data ?? []) as unknown as Run[];
  const by = (o: string) => runs.filter((r) => r.outcome === o).length;
  const timed = runs.filter((r) => r.duration_ms != null && r.outcome === "reply");
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const avgMs = avg(timed.map((r) => r.duration_ms!));
  const avgIn = avg(runs.filter((r) => r.input_tokens != null).map((r) => r.input_tokens!));
  const avgOut = avg(runs.filter((r) => r.output_tokens != null).map((r) => r.output_tokens!));
  const handoffs = runs.filter((r) => r.tool_calls?.some((t) => t.name === "handoff_to_human")).length;

  const cals = branchesQ.data ?? [];
  const withCal = cals.filter((b) => b.google_calendar_id).length;
  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const quality = health.ok ? QUALITY_LABEL[health.data.quality_rating ?? "UNKNOWN"] ?? QUALITY_LABEL.UNKNOWN : null;

  const stuck = (overdueQ.count ?? 0) > 0;

  // Resumen en una frase: qué está mal, si algo lo está.
  const problems: string[] = [];
  if (stuck) problems.push(`${overdueQ.count} tarea(s) atrasada(s): si el servidor no las está ejecutando, las respuestas del bot se demoran (README → «Tareas en segundo plano»).`);
  if (failedQ.count) problems.push(`${failedQ.count} tarea(s) agotaron sus reintentos en 24 h; abajo puedes reintentarlas.`);
  if (by("error")) problems.push(`${by("error")} corrida(s) del agente terminaron en error.`);
  if (badEventsQ.count) problems.push(`${badEventsQ.count} evento(s) de WhatsApp llegaron con error.`);
  if (!health.ok) problems.push(`No se pudo consultar el número en Meta: ${health.error}`);
  else if ((health.data.quality_rating ?? "GREEN") !== "GREEN") problems.push("La calidad del número bajó: Meta puede limitar los envíos.");

  return (
    <div className="page">
      <h1>Sistema</h1>
      <p className="page-intro">Cómo va la operación. Últimas 24 horas. Para encender o apagar el agente y ajustar lo que sabe, ve a <Link href="/agente">Agente IA</Link>.</p>

      {/* Lo primero: ¿hay algo que atender? */}
      {problems.length === 0 ? (
        <p className="all-clear">
          <Icon name="chequeo" size={17} /> Todo en orden: la cola avanza, el agente responde y el webhook de Meta recibe sin errores.
        </p>
      ) : (
        <div className="banner warn" style={{ display: "grid", gap: 6 }}>
          <strong>Hay {problems.length === 1 ? "algo que revisar" : `${problems.length} cosas que revisar`}:</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      <div className="metric-group">
        <h3>Cola de tareas</h3>
        <div className="kpis compact">
          <Kpi label="En cola" value={pendingQ.count ?? 0} tone={stuck ? "warn" : undefined} />
          <Kpi label="Atrasadas" value={overdueQ.count ?? 0} tone={stuck ? "warn" : undefined} />
          <Kpi label="Fallidas (24 h)" value={failedQ.count ?? 0} tone={failedQ.count ? "warn" : undefined} />
        </div>
      </div>

      <div className="metric-group">
        <h3>Agente <Link href="/agente" className="muted" style={{ fontSize: 12.5, fontWeight: 400, marginLeft: 8 }}>Configurarlo →</Link></h3>
        <div className="kpis compact">
          <Kpi label="Corridas" value={runs.length} />
          <Kpi label="Errores" value={by("error")} tone={by("error") ? "warn" : undefined} />
          <Kpi label="Latencia media" value={timed.length ? `${(avgMs / 1000).toFixed(1)} s` : "—"} />
          <Kpi label="Tokens por corrida" value={runs.length ? `${avgIn} / ${avgOut}` : "—"} title="Promedio de tokens de entrada / salida" />
          <Kpi label="Derivadas a una persona" value={handoffs} />
          <Kpi label="Calidad de respuestas" value={`${upQ.count ?? 0} / ${downQ.count ?? 0}`} tone={downQ.count ? "warn" : undefined} title="Respuestas del bot marcadas con 👍 / 👎 por tu equipo" />
        </div>
      </div>

      <div className="metric-group">
        <h3>WhatsApp</h3>
        <div className="kpis compact">
          <Kpi label="Errores del webhook (24 h)" value={badEventsQ.count ?? 0} tone={badEventsQ.count ? "warn" : undefined} />
          <Kpi label="Último evento" value={ago(lastEventQ.data?.[0]?.received_at as string | undefined)} />
        </div>
      </div>

      <div className="grid2">
        <section className="card wide">
          <h2>Número de WhatsApp</h2>
          {health.ok ? (
            <dl className="cp-block" style={{ gap: 8, marginTop: 12 }}>
              <div className="cp-row"><dt>Número</dt><dd>{health.data.display_phone_number ?? "—"}</dd></div>
              <div className="cp-row"><dt>Nombre verificado</dt><dd>{health.data.verified_name ?? "—"}</dd></div>
              <div className="cp-row">
                <dt>Calidad</dt>
                <dd>
                  <span className={`tag ${quality?.tone ?? ""}`}>{quality?.text}</span>
                </dd>
              </div>
              <div className="cp-row"><dt>Límite diario</dt><dd>{TIER_LABEL[health.data.messaging_limit_tier ?? ""] ?? health.data.messaging_limit_tier ?? "—"}</dd></div>
              <div className="cp-row"><dt>Estado</dt><dd>{health.data.status ?? "—"}</dd></div>
            </dl>
          ) : (
            <p className="muted" style={{ marginTop: 12 }}>
              No se pudo consultar a Meta: {health.error}
            </p>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            Si la calidad baja a amarillo o rojo, Meta puede limitar o restringir el número: revisa que no se estén enviando mensajes no deseados.
          </p>
        </section>

        <section className="card wide">
          <h2>Integraciones</h2>
          <dl className="cp-block" style={{ gap: 8, marginTop: 12 }}>
            <div className="cp-row"><dt>Último evento de WhatsApp</dt><dd>{ago(lastEventQ.data?.[0]?.received_at as string | undefined)}</dd></div>
            <div className="cp-row">
              <dt>Google Calendar</dt>
              <dd>
                {env.googleConfigured ? <span className="tag ok">Conectado</span> : <span className="tag warn">Sin credenciales</span>}{" "}
                <span className="muted">{withCal} de {cals.length} sucursales con calendario</span>
              </dd>
            </div>
            <div className="cp-row"><dt>Avisos por correo</dt><dd>{env.resendApiKey && env.alertEmailFrom ? <span className="tag ok">Activos</span> : <span className="muted">Sin configurar (solo en el panel)</span>}</dd></div>
          </dl>
        </section>
      </div>

      {(failedRowsQ.data ?? []).length > 0 && (
        <>
          <div className="section-head">
            <h2>Tareas fallidas</h2>
            <span className="muted">Agotaron sus reintentos</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Cuándo</th><th>Tarea</th><th>Intentos</th><th>Error</th><th /></tr>
              </thead>
              <tbody>
                {(failedRowsQ.data ?? []).map((j) => (
                  <tr key={j.id as string}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{j.finished_at ? fmt(j.finished_at as string) : "—"}</td>
                    <td><code>{j.kind as string}</code></td>
                    <td>{j.attempts as number}</td>
                    <td className="muted" style={{ maxWidth: 420 }}>{(j.last_error as string | null) ?? "—"}</td>
                    <td>
                      <form action={retryFailedJob}>
                        <input type="hidden" name="id" value={j.id as string} />
                        <button type="submit" className="ghost btn-sm">Reintentar</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {badReplies.length > 0 && (
        <>
          <div className="section-head">
            <h2>Respuestas del bot marcadas con 👎</h2>
            <span className="muted">Revísalas y ajusta el conocimiento o las instrucciones</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Cuándo</th><th>Chat</th><th>Lo que respondió el bot</th><th>Qué estuvo mal</th></tr>
              </thead>
              <tbody>
                {badReplies.map((m) => {
                  const lead = m.conversations?.leads;
                  return (
                    <tr key={m.id}>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(m.created_at)}</td>
                      <td><Link href={`/inbox/${m.conversation_id}`}>{lead?.nombre ?? lead?.phone ?? "Cliente"}</Link></td>
                      <td className="muted" style={{ maxWidth: 460, whiteSpace: "pre-wrap" }}>{m.content.slice(0, 280)}</td>
                      <td>{m.feedback_note ?? <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-head">
        <h2>Últimas corridas del agente</h2>
        <span className="muted">{runs.length} en 24 h</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Cuándo</th><th>Chat</th><th>Resultado</th><th>Duración</th><th>Tokens</th><th>Herramientas</th></tr>
          </thead>
          <tbody>
            {runs.slice(0, 30).map((r) => {
              const lead = r.conversations?.leads;
              const o = OUTCOME[r.outcome] ?? { label: r.outcome, tone: "" };
              return (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(r.created_at)}</td>
                  <td><Link href={`/inbox/${r.conversation_id}`}>{lead?.nombre ?? lead?.phone ?? "Cliente"}</Link></td>
                  <td>
                    <span className={`tag ${o.tone}`}>{o.label}</span>
                    {r.detail && <div className="cell-sub">{r.detail}</div>}
                  </td>
                  <td className="muted">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : "—"}</td>
                  <td className="muted">{r.input_tokens != null ? `${r.input_tokens} / ${r.output_tokens ?? 0}` : "—"}</td>
                  <td>{(r.tool_calls ?? []).length ? (r.tool_calls ?? []).map((t) => <span key={t.name + t.ms} className={`tag ${t.ok ? "" : "err"}`}>{t.name}</span>) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-row">
                  <div className="empty-state">
                    <span className="ico"><Icon name="chequeo" size={22} /></span>
                    <strong>Aún no hay corridas del agente</strong>
                    <p className="muted">Aparecerán aquí cuando un cliente escriba.</p>
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

function Kpi({ label, value, tone, title }: { label: string; value: number | string; tone?: "warn"; title?: string }) {
  return (
    <div className={`kpi${tone ? ` ${tone}` : ""}`} title={title}>
      <span>
        <span className="kpi-value">{value}</span>
        <span className="kpi-label" style={{ display: "block" }}>{label}</span>
      </span>
    </div>
  );
}
