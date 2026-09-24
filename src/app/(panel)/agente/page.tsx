import Link from "next/link";
import { guardarMensajeAgente, restaurarMensajeAgente, toggleAgent } from "@/app/(panel)/crm-actions";
import { FormDialog } from "@/components/form-dialog";
import { Icon } from "@/components/icons";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { getAgentSwitch } from "@/lib/settings";
import { MENSAJES } from "@/lib/agent/mensajes";
import { SubmitButton } from "@/components/submit-button";

const DAY = 86_400_000;
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/**
 * Agente IA: todo lo que decide cómo se comporta el bot en un solo sitio (apagarlo, lo que sabe y sus ajustes).
 * Antes el interruptor estaba escondido en Sistema, entre métricas de servidor, y el conocimiento vivía aparte.
 * Sistema queda para el estado técnico: cola de tareas, corridas y salud del número.
 */
export default async function AgentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireAdmin();
  const agent = await getAgentSwitch();
  // Los mensajes que alguien ya cambió: el resto se muestran como vienen de fábrica.
  const { data: editadosRows } = await supabase.from("agent_messages").select("clave, texto");
  const editados = new Map((editadosRows ?? []).map((m) => [m.clave as string, m.texto as string]));
  const since = new Date(Date.now() - DAY).toISOString();

  const [knowledgeQ, runsQ, upQ, downQ] = await Promise.all([
    supabase.from("knowledge_base").select("activa"),
    supabase.from("agent_runs").select("outcome, tool_calls").gte("created_at", since).limit(500),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("feedback", 1),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("feedback", -1),
  ]);
  for (const q of [knowledgeQ, runsQ, upQ, downQ]) if (q.error) throw q.error;

  const knowledge = knowledgeQ.data ?? [];
  const activas = knowledge.filter((k) => k.activa).length;
  const runs = (runsQ.data ?? []) as { outcome: string; tool_calls: { name: string }[] | null }[];
  const respondidas = runs.filter((r) => r.outcome === "reply").length;
  const derivadas = runs.filter((r) => r.tool_calls?.some((t) => t.name === "handoff_to_human")).length;

  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;

  return (
    <div className="page">
      <h1>Agente IA</h1>
      <p className="page-intro">Enciende o apaga al agente, revisa lo que sabe y cómo está configurado.</p>

      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      <section className={`agent-switch${agent.enabled ? "" : " off"}`}>
        <span className="as-state">
          <Icon name={agent.enabled ? "play" : "pausa"} size={18} />
        </span>
        <div className="as-text">
          <strong>{agent.enabled ? "El agente está atendiendo" : "El agente está apagado"}</strong>
          <span className="muted">
            {agent.enabled
              ? "Responde los chats, envía los seguimientos y los recordatorios de cita."
              : "No sale ningún mensaje automático. Los chats llegan al inbox y los responde tu equipo."}
            {!agent.enabled && agent.pausedBy && <> Lo apagó {agent.pausedBy}{agent.pausedAt ? ` el ${fmt(agent.pausedAt)}` : ""}.</>}
            {!agent.enabled && agent.reason && <> «{agent.reason}»</>}
          </span>
        </div>
        {agent.enabled ? (
          <FormDialog
            trigger="Apagar agente"
            triggerClassName="btn danger"
            title="Apagar el agente"
            description="Deja de responder y no saldrá ningún mensaje automático hasta que lo enciendas."
          >
            <form action={toggleAgent} className="stack" style={{ gap: 14 }}>
              <input type="hidden" name="enabled" value="false" />
              <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                <li>No responde los mensajes que lleguen.</li>
                <li>No envía seguimientos ni recordatorios de cita.</li>
                <li>Los chats siguen llegando al inbox: tu equipo responde a mano.</li>
              </ul>
              <label>
                Motivo <span className="hint">(opcional, lo ve tu equipo en el aviso)</span>
                <input name="reason" maxLength={200} placeholder="Está respondiendo mal los precios" />
              </label>
              <div className="form-actions">
                <button type="submit" className="danger">
                  Apagar el agente
                </button>
              </div>
            </form>
          </FormDialog>
        ) : (
          <form action={toggleAgent}>
            <input type="hidden" name="enabled" value="true" />
            <button type="submit" className="btn primary">
              Encender agente
            </button>
          </form>
        )}
      </section>

      <div className="grid2">
        <section className="card wide">
          <div className="card-head">
            <h2>Lo que sabe</h2>
            <Link href="/conocimiento" className="muted">
              Editar →
            </Link>
          </div>
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
            {knowledge.length === 0 ? (
              <>Todavía no le has cargado información: responde solo con las instrucciones base.</>
            ) : (
              <>
                <strong>{activas}</strong> ficha{activas === 1 ? "" : "s"} activa{activas === 1 ? "" : "s"} de {knowledge.length}. El agente las usa para
                responder desde la siguiente conversación.
              </>
            )}
          </p>
          <ul className="empty-ideas" style={{ marginTop: 12 }}>
            <li>Horarios, direcciones y cómo llegar a cada sucursal.</li>
            <li>Qué incluye el examen visual y cuánto dura.</li>
            <li>Lo que NO debe decir: precios y diagnósticos.</li>
          </ul>
        </section>

        <section className="card wide">
          <div className="card-head">
            <h2>Cómo está configurado</h2>
            <span className="muted hide-sm">Se cambia en el servidor</span>
          </div>
          <dl className="cp-block" style={{ gap: 8, marginTop: 12 }}>
            <div className="cp-row"><dt>Modelo</dt><dd><code>{env.openaiModel}</code></dd></div>
            <div className="cp-row"><dt>Espera antes de responder</dt><dd>{env.agentDebounceMs / 1000} s <span className="muted">(agrupa los mensajes seguidos)</span></dd></div>
            <div className="cp-row"><dt>Seguimiento al que no responde</dt><dd>{env.followupAfterMinutes ? `a los ${env.followupAfterMinutes} min` : <span className="muted">desactivado</span>}</dd></div>
            <div className="cp-row">
              <dt>Agenda</dt>
              <dd>{env.googleConfigured ? <span className="tag ok">Google Calendar conectado</span> : <span className="tag warn">Sin credenciales</span>}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="metric-group" style={{ marginTop: 16 }}>
        <h3>Cómo le fue en 24 horas</h3>
        <div className="kpis compact">
          <Kpi label="Chats respondidos" value={respondidas} />
          <Kpi label="Derivados a una persona" value={derivadas} />
          <Kpi label="Respuestas 👍 / 👎" value={`${upQ.count ?? 0} / ${downQ.count ?? 0}`} tone={downQ.count ? "warn" : undefined} />
        </div>
      </div>
      <div className="metric-group" style={{ marginTop: 16 }}>
        <h3>Cómo habla al agendar una cita</h3>
        <p className="page-intro" style={{ marginTop: 0 }}>
          Estos mensajes los envía el agente tal cual, sin improvisar, para que cada cita salga siempre igual. El tono es
          tuyo: cámbialo cuando quieras y se aplica en la siguiente conversación.
        </p>
        <div className="mensajes-agente">
          {MENSAJES.map((m) => {
            const editado = editados.get(m.clave);
            return (
              <form key={m.clave} action={guardarMensajeAgente} className="mensaje-agente">
                <input type="hidden" name="clave" value={m.clave} />
                <div className="mensaje-cuando">
                  <strong>{m.cuando}</strong>
                  {editado && <span className="tag ok">editado</span>}
                </div>
                <textarea name="texto" defaultValue={editado ?? m.texto} rows={m.texto.length > 120 ? 4 : 2} required />
                <div className="mensaje-pie">
                  {m.huecos.length > 0 ? (
                    <span className="hint">
                      Se rellenan solos: {m.huecos.map((h) => `{{${h}}}`).join(" · ")}
                    </span>
                  ) : (
                    <span className="hint">Este mensaje no lleva datos variables.</span>
                  )}
                  <span className="spacer" />
                  {editado && (
                    <button type="submit" formAction={restaurarMensajeAgente} className="ghost btn-sm">
                      Restaurar
                    </button>
                  )}
                  <SubmitButton className="btn-sm">Guardar</SubmitButton>
                </div>
              </form>
            );
          })}
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12.5 }}>
        <Link href="/sistema">Ver el detalle técnico en Sistema →</Link>
      </p>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: "warn" }) {
  return (
    <div className={`kpi${tone ? ` ${tone}` : ""}`}>
      <span>
        <span className="kpi-value">{value}</span>
        <span className="kpi-label" style={{ display: "block" }}>{label}</span>
      </span>
    </div>
  );
}
