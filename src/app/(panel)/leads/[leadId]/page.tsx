import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteContactData, mergeContacts, unarchiveLead, updateContact } from "@/app/(panel)/crm-actions";
import { Avatar } from "@/components/avatar";
import { FormDialog } from "@/components/form-dialog";
import { requireUser } from "@/lib/session";
import { APPOINTMENT_STATUS_LABEL, ARCHIVE_REASON_LABEL, LEAD_ORIGINS, LEAD_ORIGIN_LABEL, LEAD_STAGE_LABEL, firstOf, type AppointmentStatus, type ArchiveReason, type LeadOrigin, type LeadStage } from "@/lib/types";

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leadId } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireUser();

  const { data } = await supabase
    .from("leads")
    .select("id, nombre, phone, bsuid, email, stage, source, origin, opt_out, promo_consent, tags, notes, branch_id, created_at, archived_at, archive_reason, branches(nombre), conversations(id)")
    .eq("id", leadId)
    .maybeSingle();
  if (!data) notFound(); // no existe, o RLS no lo deja ver

  const lead = data as unknown as {
    id: string;
    nombre: string | null;
    phone: string | null;
    bsuid: string | null;
    email: string | null;
    stage: LeadStage;
    source: string;
    origin: LeadOrigin;
    opt_out: boolean;
    promo_consent: boolean;
    tags: string[];
    notes: string | null;
    branch_id: string | null;
    created_at: string;
    archived_at: string | null;
    archive_reason: ArchiveReason | null;
    branches: { nombre: string } | null;
    conversations: { id: string } | { id: string }[] | null;
  };

  const [{ data: branches }, { data: appts }, { data: consents }] = await Promise.all([
    supabase.from("branches").select("id, nombre").order("nombre"),
    supabase
      .from("appointments")
      .select("id, scheduled_at, status, branches(nombre)")
      .eq("lead_id", leadId)
      .order("scheduled_at", { ascending: false }),
    supabase
      .from("consent_log")
      .select("id, kind, action, channel, evidence, text_version, created_at, users(nombre)")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  // Candidatos para unir (solo el admin ve a todos): el mismo cliente con otro número o identidad
  const others =
    profile.role === "admin"
      ? (((await supabase.from("leads").select("id, nombre, phone").neq("id", leadId).order("created_at", { ascending: false }).limit(500)).data ?? []) as { id: string; nombre: string | null; phone: string | null }[])
      : [];

  const error = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const appointments = (appts ?? []) as unknown as { id: string; scheduled_at: string; status: AppointmentStatus; branches: { nombre: string } | null }[];
  const conv = firstOf(lead.conversations);
  const history = (consents ?? []) as unknown as {
    id: string;
    kind: "atencion" | "promociones";
    action: "otorgado" | "revocado";
    channel: "whatsapp" | "panel" | "sistema";
    evidence: string | null;
    text_version: string;
    created_at: string;
    users: { nombre: string } | null;
  }[];
  const lastGrant = (kind: "atencion" | "promociones") => history.find((h) => h.kind === kind && h.action === "otorgado");
  const CHANNEL = { whatsapp: "WhatsApp", panel: "Panel", sistema: "Sistema" } as const;
  const title = lead.nombre ?? lead.phone ?? "Usuario de WhatsApp";

  return (
    <div className="page">
      <p>
        <Link href="/leads">← Contactos</Link>
      </p>

      <div className="person-head">
        <Avatar name={lead.nombre} size="lg" />
        <div>
          <h1>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {lead.phone ?? "Sin número visible"} · {lead.branches?.nombre ?? "sin sucursal"} ·{" "}
            {lead.source === "ctwa" ? "llegó por anuncio" : "origen: otro"} · creado {fmt(lead.created_at)}
          </p>
        </div>
        <span className="spacer" />
        {conv && (
          <Link className="btn" href={`/inbox/${conv.id}`}>
            Abrir chat
          </Link>
        )}
      </div>

      {error && <p className="banner warn">{error}</p>}
      {ok && <p className="banner ok">{ok}</p>}

      {lead.archived_at && (
        <div className="banner archived-banner">
          <span>
            <strong>Fuera del tablero</strong> desde el {fmt(lead.archived_at)}
            {lead.archive_reason && <> · {ARCHIVE_REASON_LABEL[lead.archive_reason]}</>}
            <span className="cell-sub" style={{ display: "block" }}>
              {lead.archive_reason === "no_es_cliente"
                ? "No volverá al tablero aunque escriba otra vez."
                : "Volverá al tablero en cuanto escriba de nuevo."}
            </span>
          </span>
          <form action={unarchiveLead}>
            <input type="hidden" name="id" value={lead.id} />
            <button type="submit" className="btn-sm">
              Devolver al tablero
            </button>
          </form>
        </div>
      )}

      <div className="detail-grid">
        <form action={updateContact} className="card stack">
          <h2>Datos del contacto</h2>
          <input type="hidden" name="id" value={lead.id} />
          <div className="row">
            <label>
              Nombre
              <input name="nombre" defaultValue={lead.nombre ?? ""} maxLength={120} />
            </label>
            <label>
              Email
              <input name="email" type="email" defaultValue={lead.email ?? ""} placeholder="sin email" />
            </label>
          </div>
          <div className="row">
            <label>
              Origen
              <select name="origin" defaultValue={lead.origin} style={{ width: "100%" }}>
                {LEAD_ORIGINS.map((o) => (
                  <option key={o} value={o}>
                    {LEAD_ORIGIN_LABEL[o]}
                  </option>
                ))}
              </select>
              <span className="hint">Si llegó por un anuncio se detecta solo; el resto lo anotas tú.</span>
            </label>
          </div>
          <div className="row">
            {profile.role === "admin" ? (
              <label>
                Sucursal
                <select name="branch_id" defaultValue={lead.branch_id ?? ""} style={{ width: "100%" }}>
                  {!lead.branch_id && <option value="">Sin sucursal</option>}
                  {(branches ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.nombre}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Sucursal
                <input value={lead.branches?.nombre ?? "—"} disabled readOnly />
                <span className="hint">Solo un administrador puede cambiarla.</span>
              </label>
            )}
          </div>
          <label>
            Etiquetas <span className="hint">(separadas por coma)</span>
            <input name="tags" defaultValue={lead.tags.join(", ")} placeholder="vip, lentes de contacto" />
          </label>
          <label>
            Notas internas
            <textarea name="notes" rows={4} defaultValue={lead.notes ?? ""} maxLength={4000} placeholder="Preferencias, antecedentes, acuerdos…" />
            <span className="hint">Solo las ve tu equipo. El agente no las usa.</span>
          </label>
          <label className="check">
            <input type="checkbox" name="opt_out" defaultChecked={lead.opt_out} /> Dado de baja (el bot y las campañas no le escriben; el cambio queda registrado)
          </label>
          <div>
            <button type="submit">Guardar</button>
          </div>
        </form>

        <div className="card stack">
          <h2>Citas</h2>
          {appointments.length === 0 && <p className="muted">Sin citas registradas.</p>}
          {appointments.map((a) => (
            <div key={a.id} className="cp-row">
              <dt>
                {fmt(a.scheduled_at)}
                <div className="cell-sub">{a.branches?.nombre}</div>
              </dt>
              <dd>
                <span className="tag">{APPOINTMENT_STATUS_LABEL[a.status]}</span>
              </dd>
            </div>
          ))}

          <hr />
          <h2>Resumen</h2>
          <dl className="cp-block" style={{ gap: 6, margin: 0 }}>
            <div className="cp-row">
              <dt>Etapa</dt>
              <dd>
                <span className={`tag dot-${lead.stage}`}>{LEAD_STAGE_LABEL[lead.stage as LeadStage]}</span>{" "}
                <Link href="/pipeline" className="muted" style={{ fontSize: 12 }}>
                  Tablero →
                </Link>
              </dd>
            </div>
            <div className="cp-row">
              <dt>Origen</dt>
              <dd>{LEAD_ORIGIN_LABEL[lead.origin]}</dd>
            </div>
            <div className="cp-row">
              <dt>Etiquetas</dt>
              <dd>{lead.tags.length ? lead.tags.map((t) => <span key={t} className="tag ok">{t}</span>) : <span className="muted">—</span>}</dd>
            </div>
            <div className="cp-row">
              <dt>Mensajes masivos</dt>
              <dd>{lead.opt_out ? <span className="tag warn">Dado de baja</span> : <span className="tag ok">Permitidos</span>}</dd>
            </div>
            {lead.bsuid && (
              <div className="cp-row">
                <dt>ID de WhatsApp</dt>
                <dd>
                  <code>{lead.bsuid}</code>
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <section className="card wide stack" style={{ marginTop: 18 }}>
        <div className="row-head" style={{ marginBottom: 0 }}>
          <h2>Consentimientos y datos personales</h2>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Registro de cuándo y cómo este cliente autorizó o pidió dejar de recibir mensajes (Ley 29733). Solo se escribe desde el servidor.
        </p>
        <div className="consent-grid">
          <div className="consent-box">
            <strong>Atención</strong>
            <span className={`tag ${lead.opt_out ? "warn" : "ok"}`}>{lead.opt_out ? "Dado de baja" : "Autorizada"}</span>
            <span className="cell-sub">Responder sus consultas y agendar su cita.</span>
          </div>
          <div className="consent-box">
            <strong>Promociones</strong>
            <span className={`tag ${lead.promo_consent ? "ok" : ""}`}>{lead.promo_consent ? "Aceptadas" : "No autorizadas"}</span>
            <span className="cell-sub">
              {lead.promo_consent ? `Aceptó el ${fmt(lastGrant("promociones")?.created_at ?? lead.created_at)}.` : "Solo se le envían si las pide expresamente (PROMO)."}
            </span>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Qué</th>
                <th>Canal</th>
                <th>Constancia</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(h.created_at)}</td>
                  <td>
                    <span className={`tag ${h.action === "otorgado" ? "ok" : "warn"}`}>
                      {h.kind === "atencion" ? "Atención" : "Promociones"} · {h.action === "otorgado" ? "autorizó" : "revocó"}
                    </span>
                  </td>
                  <td>
                    {CHANNEL[h.channel]}
                    {h.users?.nombre && <div className="cell-sub">{h.users.nombre}</div>}
                  </td>
                  <td className="muted" style={{ maxWidth: 360 }}>
                    {h.evidence ? `«${h.evidence}»` : "—"}
                    <div className="cell-sub">texto {h.text_version}</div>
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-row">
                    Sin movimientos registrados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {profile.role === "admin" && others.length > 0 && (
          <div className="danger-zone inline" style={{ justifyContent: "space-between", width: "100%" }}>
            <span>
              <strong>¿Es la misma persona que otro contacto?</strong>
              <span className="cell-sub" style={{ display: "block" }}>
                Une los dos: sus mensajes, citas y consentimientos pasan a esta ficha y el otro contacto desaparece. No se puede deshacer.
              </span>
            </span>
            <FormDialog
              trigger="Unir con otro contacto…"
              triggerClassName="ghost btn-sm"
              title="Unir con otro contacto"
              description="El contacto que elijas se elimina y todo lo suyo pasa a esta ficha. Si ambos tienen dato distinto (nombre, correo, sucursal), se conserva el de esta ficha."
            >
              <form action={mergeContacts} className="stack" style={{ gap: 14 }}>
                <input type="hidden" name="target_id" value={lead.id} />
                <label>
                  Contacto a unir (desaparecerá)
                  <select name="source_id" required defaultValue="" style={{ width: "100%" }}>
                    <option value="" disabled>
                      Elige…
                    </option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.nombre ?? "Sin nombre"} · {o.phone ?? "sin número"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>
                    Para confirmar, escribe <strong>UNIR</strong>
                  </span>
                  <input name="confirmacion" required autoComplete="off" placeholder="UNIR" />
                </label>
                <div className="form-actions">
                  <button type="submit" className="danger">
                    Unir contactos
                  </button>
                </div>
              </form>
            </FormDialog>
          </div>
        )}

        {profile.role === "admin" && (
          <div className="danger-zone inline" style={{ justifyContent: "space-between", width: "100%" }}>
            <span>
              <strong>Eliminar los datos de este contacto</strong>
              <span className="cell-sub" style={{ display: "block" }}>
                Derecho de cancelación: borra chat, notas, citas y consentimientos. No se puede deshacer.
              </span>
            </span>
            <FormDialog
              trigger="Eliminar datos…"
              triggerClassName="danger btn-sm"
              title="Eliminar los datos de este contacto"
              description="Se borra todo lo que el sistema guarda de esta persona. Solo queda una constancia sin datos personales (un código irreversible, la fecha y quién lo hizo)."
            >
              <form action={deleteContactData} className="stack" style={{ gap: 14 }}>
                <input type="hidden" name="id" value={lead.id} />
                <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  <li>Conversación y mensajes, notas internas y etiquetas.</li>
                  <li>Citas (también sus eventos en Google Calendar).</li>
                  <li>Registro de consentimientos y los eventos de WhatsApp con su número.</li>
                </ul>
                <label>
                  Motivo <span className="hint">(opcional: p. ej. «solicitud del titular por correo, 12/09»)</span>
                  <input name="motivo" maxLength={300} />
                </label>
                <label>
                  <span>
                    Para confirmar, escribe <strong>ELIMINAR</strong>
                  </span>
                  <input name="confirmacion" required autoComplete="off" placeholder="ELIMINAR" />
                </label>
                <div className="form-actions">
                  <button type="submit" className="danger">
                    Eliminar definitivamente
                  </button>
                </div>
              </form>
            </FormDialog>
          </div>
        )}
      </section>
    </div>
  );
}
