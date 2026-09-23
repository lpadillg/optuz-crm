import { createReminderTemplate, syncTemplatesAction } from "@/app/(panel)/crm-actions";
import { Icon } from "@/components/icons";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { TEMPLATE_DEFS } from "@/lib/whatsapp/templates";
import { NuevaPlantilla } from "./nueva-plantilla";

const TONE: Record<string, string> = { APPROVED: "ok", PENDING: "warn", IN_APPEAL: "warn", REJECTED: "err", PAUSED: "err", DISABLED: "err" };
const LABEL: Record<string, string> = { APPROVED: "Aprobada", PENDING: "En revisión", IN_APPEAL: "En apelación", REJECTED: "Rechazada", PAUSED: "Pausada", DISABLED: "Deshabilitada" };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireAdmin();
  const { data, error } = await supabase.from("message_templates").select("name, language, category, status, body, reason, synced_at").order("name");
  if (error) throw error;
  const rows = data ?? [];
  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const reminder = rows.find((t) => t.name === env.reminderTemplate);
  const configured = Boolean(env.whatsappBusinessAccountId);
  // Las tres plantillas que el CRM necesita, con lo que hay creado en Meta para cada una.
  const necesarias = TEMPLATE_DEFS.map((def) => ({ def, fila: rows.find((t) => t.name === def.name) }));

  return (
    <div className="page">
      <h1>Plantillas de WhatsApp</h1>
      <div className="page-head">
        <div className="stat-chips">
          {necesarias.map(({ def, fila }) => (
            <span key={def.name} className={`stat-chip${fila?.status === "APPROVED" ? "" : " warn"}`}>
              <code>{def.name}</code>: <strong>{fila ? (LABEL[fila.status] ?? fila.status) : "sin crear"}</strong>
            </span>
          ))}
        </div>
        <span className="spacer" />
        <form action={syncTemplatesAction}>
          <button type="submit" className="ghost" disabled={!configured}>Sincronizar con Meta</button>
        </form>
        {necesarias
          .filter(({ fila }) => !fila)
          .map(({ def }) => (
            <form key={def.name} action={createReminderTemplate}>
              <input type="hidden" name="name" value={def.name} />
              <button type="submit" className="btn primary" disabled={!configured}>
                <Icon name="mas" size={16} /> Crear «{def.name}»
              </button>
            </form>
          ))}
      </div>
      <p className="page-intro">
        WhatsApp solo permite escribirle a un cliente <strong>dentro de las 24 horas</strong> de su último mensaje. Para avisar antes de una cita (casi siempre fuera de ese plazo) se necesita una
        <strong> plantilla aprobada por Meta</strong>. El recordatorio va como texto normal si el cliente escribió hace poco, y con la plantilla si no.
      </p>

      {!configured && <p className="banner warn">Falta <code>WHATSAPP_BUSINESS_ACCOUNT_ID</code> en <code>.env.local</code>: sin él no se puede hablar con Meta.</p>}
      {err && <p className="banner warn">{err}</p>}
      {ok && <p className="banner ok">{ok}</p>}
      {configured && reminder?.status !== "APPROVED" && !err && !ok && (
        <p className="banner warn">
          <strong>Sin plantilla de recordatorio aprobada:</strong> si un recordatorio toca fuera de las 24 horas, no se podrá enviar y el chat quedará como «Requiere humano».
          {!reminder ? " Crea la plantilla con el botón de arriba." : " Cuando Meta la apruebe, pulsa «Sincronizar con Meta»."}
        </p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Nombre</th><th>Estado</th><th>Categoría</th><th>Texto</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.name as string}>
                <td><code>{t.name as string}</code><div className="cell-sub">{t.language as string}</div></td>
                <td>
                  <span className={`tag ${TONE[t.status as string] ?? ""}`}>{LABEL[t.status as string] ?? (t.status as string)}</span>
                  {t.reason && <div className="cell-sub">{t.reason as string}</div>}
                </td>
                <td className="muted">{t.category as string}</td>
                <td className="muted" style={{ maxWidth: 520, whiteSpace: "pre-wrap" }}>{t.body as string}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="empty-row">
                  <div className="empty-state">
                    <span className="ico"><Icon name="respuestas" size={22} /></span>
                    <strong>Aún no hay plantillas</strong>
                    <p className="muted">Crea la de recordatorio de cita o sincroniza las que ya tengas en Meta.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <NuevaPlantilla />

      <details className="card wide" style={{ marginTop: 16 }}>
        <summary>Ver el texto de las plantillas que el CRM usa por su cuenta</summary>
        {TEMPLATE_DEFS.map((def) => (
          <div key={def.name} style={{ marginTop: 12 }}>
            <code>{def.name}</code>
            <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{def.body}</p>
            <p className="hint">Ejemplo: {def.examples.join(" · ")}. Categoría: {def.category === "UTILITY" ? "utilidad (aviso sobre algo que el cliente ya pidió)" : "marketing"}.</p>
          </div>
        ))}
      </details>
    </div>
  );
}
