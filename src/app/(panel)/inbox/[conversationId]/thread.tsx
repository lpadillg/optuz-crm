"use client";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { Avatar } from "@/components/avatar";
import { reactivateAttention, setMessageFeedback } from "@/app/(panel)/crm-actions";
import { Icon } from "@/components/icons";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { horaCorta } from "@/lib/time";
import {
  APPOINTMENT_STATUS_LABEL,
  ARCHIVE_REASON_LABEL,
  LEAD_ORIGIN_LABEL,
  LEAD_STAGE_HINT,
  LEAD_STAGE_LABEL,
  MESSAGE_PAGE,
  type AppointmentStatus,
  type ArchiveReason,
  type Attachment,
  type LeadOrigin,
  type LeadStage,
  type MessageRow,
  type NoteRow,
} from "@/lib/types";

interface Props {
  conversationId: string;
  userId: string;
  userName: string;
  lead: {
    id: string;
    nombre: string | null;
    phone: string | null;
    stage: LeadStage;
    origin: LeadOrigin;
    tags: string[];
    opt_out: boolean;
    archived_at: string | null;
    archive_reason: string | null;
    created_at: string;
    branches: { nombre: string } | null;
  };
  appointments: { id: string; scheduled_at: string; status: AppointmentStatus; branches: { nombre: string } | null }[];
  team: { id: string; nombre: string }[];
  quickReplies: { atajo: string; titulo: string; cuerpo: string }[];
  initialAssignedTo: string | null;
  initialBotActive: boolean;
  initialRequiresHuman: boolean;
  handoffReason: string | null;
  handoffSummary: string | null;
  initialEscalated: boolean;
  initialMessages: MessageRow[];
  initialNotes: NoteRow[];
}

const MESSAGE_COLS = "id, direction, sender, content, attachments, created_at, author_id, delivery_status, feedback";

const SENDER_LABEL = { bot: "🤖 Bot", humano: "👤 Asesor", lead: "" } as const;

const time = (iso: string) =>
  horaCorta(new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit" }).format(new Date(iso)));

const fmt = (iso: string) =>
  horaCorta(
    new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "numeric", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(new Date(iso)),
  );

const limaDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(iso));

/** Desde cuándo lo tenemos: distingue al que escribe por primera vez del que ya era cliente. */
function sinceLabel(iso: string) {
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 30) return `hace ${dias} días`;
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", month: "short", year: "numeric" }).format(new Date(iso));
}

/** «Hoy 10:30», «Mañana 16:00» o «vie 3 oct, 10:30»: cuándo es su cita, leído de un vistazo. */
function apptWhen(iso: string) {
  const day = limaDay(iso);
  const hora = time(iso);
  if (day === limaDay(new Date().toISOString())) return `Hoy ${hora}`;
  if (day === limaDay(new Date(Date.now() + 86_400_000).toISOString())) return `Mañana ${hora}`;
  const fecha = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  return `${fecha}, ${hora}`;
}

/** "Hoy", "Ayer" o la fecha escrita, para separar los mensajes por día. */
function dayLabel(iso: string) {
  const day = limaDay(iso);
  const today = limaDay(new Date().toISOString());
  const yesterday = limaDay(new Date(Date.now() - 86_400_000).toISOString());
  if (day === today) return "Hoy";
  if (day === yesterday) return "Ayer";
  return new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
}

const ATT_LABEL: Record<Attachment["type"], string> = { image: "Imagen", video: "Video", audio: "Nota de voz", document: "Documento", sticker: "Sticker" };

/** Imágenes, notas de voz y documentos del cliente. Se sirven con un enlace firmado (/api/media) solo a quien ve el chat. */
function AttachmentView({ messageId, attachments }: { messageId: string; attachments: Attachment[] }) {
  return (
    <>
      {attachments.map((a, i) => {
        if (!a.storage_path) return <div key={i} className="att-pending">⏳ {ATT_LABEL[a.type] ?? "Archivo"} (descargando…)</div>;
        const url = `/api/media/${messageId}/${i}`;
        if (a.type === "image" || a.type === "sticker")
          return (
            <a key={i} href={url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="chat-img" src={url} alt={ATT_LABEL[a.type]} loading="lazy" />
            </a>
          );
        if (a.type === "audio") return <audio key={i} className="chat-audio" controls preload="none" src={url} aria-label="Nota de voz" />;
        if (a.type === "video") return <video key={i} className="chat-img" controls preload="none" src={url} />;
        return (
          <a key={i} className="att-doc" href={url} target="_blank" rel="noreferrer">
            📄 {a.filename ?? "Documento"}
          </a>
        );
      })}
    </>
  );
}

/** ✓ enviado · ✓✓ entregado · ✓✓ azul leído · ⚠ no entregado. */
function Ticks({ status }: { status: MessageRow["delivery_status"] }) {
  if (status === "failed") return <span className="ticks failed" title="WhatsApp no pudo entregarlo"> ⚠ no entregado</span>;
  const label = status === "read" ? "Leído" : status === "delivered" ? "Entregado" : "Enviado";
  return (
    <span className={`ticks ${status ?? "sent"}`} title={label} aria-label={label}>
      {" "}
      {status === "delivered" || status === "read" ? "✓✓" : "✓"}
    </span>
  );
}

export function Thread(p: Props) {
  const supabase = createSupabaseBrowserClient();
  const [messages, setMessages] = useState(p.initialMessages);
  const [notes, setNotes] = useState(p.initialNotes);
  const [botActive, setBotActive] = useState(p.initialBotActive);
  const [requiresHuman, setRequiresHuman] = useState(p.initialRequiresHuman);
  const [summary, setSummary] = useState(p.handoffSummary);
  const [escalated, setEscalated] = useState(p.initialEscalated);
  const [assignedTo, setAssignedTo] = useState(p.initialAssignedTo);
  const [optOut, setOptOut] = useState(p.lead.opt_out);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrIndex, setQrIndex] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  // Panel de datos: en pantallas anchas se puede cerrar para que la conversación ocupe más.
  const [panelPinned, setPanelPinned] = useState(true);
  useEffect(() => {
    try {
      setPanelPinned(localStorage.getItem("optuz:chat-panel") !== "off");
    } catch {
      /* sin acceso al almacenamiento: se queda abierto */
    }
  }, []);
  function togglePanel() {
    setPanelPinned((v) => {
      const next = !v;
      try {
        localStorage.setItem("optuz:chat-panel", next ? "on" : "off");
      } catch {
        /* no pasa nada si no se puede recordar */
      }
      return next;
    });
  }
  const bottom = useRef<HTMLDivElement>(null);
  // Hay más mensajes atrás si la primera carga vino llena.
  const [hasMore, setHasMore] = useState(p.initialMessages.length >= MESSAGE_PAGE);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Alto del contenedor antes de anteponer mensajes viejos: sirve para no perder el punto de lectura.
  const keepScroll = useRef<number | null>(null);

  // En vivo: mensajes nuevos (del lead, del bot o de otro asesor) y cambios de estado de la conversación.
  useEffect(() => {
    const channel = supabase
      .channel(`thread-${p.conversationId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${p.conversationId}` },
        (payload) => {
          const row = payload.new as MessageRow;
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${p.conversationId}` },
        (payload) => {
          const row = payload.new as MessageRow;
          setMessages((prev) => prev.map((m) => (m.id === row.id ? { ...m, delivery_status: row.delivery_status, feedback: row.feedback, attachments: row.attachments, content: row.content } : m)));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${p.conversationId}` },
        (payload) => {
          const row = payload.new as { bot_active: boolean; requires_human: boolean; assigned_to: string | null; handoff_summary: string | null; escalated_at: string | null };
          setBotActive(row.bot_active);
          setRequiresHuman(row.requires_human);
          setAssignedTo(row.assigned_to);
          setSummary(row.handoff_summary);
          setEscalated(!!row.escalated_at);
        },
      )
      .subscribe(async (state) => {
        if (state !== "SUBSCRIBED") return;
        // Cierra la ventana entre el render del servidor y la suscripción (y las reconexiones):
        // lo que llegó en ese intervalo no se emitió por Realtime, así que se vuelve a leer.
        const [{ data: fresh }, { data: conv }] = await Promise.all([
          supabase
            .from("messages")
            .select(MESSAGE_COLS)
            .eq("conversation_id", p.conversationId)
            .order("created_at", { ascending: false })
            .limit(MESSAGE_PAGE),
          supabase.from("conversations").select("bot_active, requires_human, assigned_to, handoff_summary, escalated_at").eq("id", p.conversationId).maybeSingle(),
        ]);
        if (fresh) {
          setMessages((prev) => {
            const byId = new Map(prev.map((m) => [m.id, m]));
            for (const m of fresh as MessageRow[]) byId.set(m.id, m);
            return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
          });
        }
        if (conv) {
          setBotActive(conv.bot_active);
          setRequiresHuman(conv.requires_human);
          setAssignedTo(conv.assigned_to);
          setSummary(conv.handoff_summary);
          setEscalated(!!conv.escalated_at);
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.conversationId]);

  useEffect(() => {
    const box = bottom.current?.parentElement;
    if (!box) return;
    if (keepScroll.current !== null) {
      box.scrollTop = box.scrollHeight - keepScroll.current; // sigue mirando el mismo mensaje
      keepScroll.current = null;
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }, [messages]);

  async function loadOlder() {
    const oldest = messages[0]?.created_at;
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    const { data, error } = await supabase
      .from("messages")
      .select(MESSAGE_COLS)
      .eq("conversation_id", p.conversationId)
      .lt("created_at", oldest)
      .order("created_at", { ascending: false })
      .limit(MESSAGE_PAGE);
    setLoadingOlder(false);
    if (error) return setError("No se pudieron cargar los mensajes anteriores");
    const older = ((data ?? []) as MessageRow[]).reverse();
    const box = bottom.current?.parentElement;
    if (box) keepScroll.current = box.scrollHeight;
    setMessages((prev) => [...older.filter((o) => !prev.some((m) => m.id === o.id)), ...prev]);
    setHasMore(older.length >= MESSAGE_PAGE);
  }

  async function toggleBot() {
    setError(null);
    const next = !botActive;
    // Reactivar el bot da el caso por atendido; pausarlo no toca la marca de derivación.
    const patch = next ? { bot_active: true, requires_human: false, handoff_reason: null } : { bot_active: false };
    const { error } = await supabase.from("conversations").update(patch).eq("id", p.conversationId);
    if (error) return setError("No se pudo cambiar el estado del bot");
    setBotActive(next);
    if (next) setRequiresHuman(false);
  }

  // Quita la baja del cliente y devuelve el chat al bot. Pasa por el servidor: queda registrado quién y cuándo.
  async function reactivateCare() {
    setError(null);
    const res = await reactivateAttention(p.conversationId);
    if (!res.ok) return setError(res.error ?? "No se pudo reactivar la atención");
    setOptOut(false);
    setBotActive(true);
    setRequiresHuman(false);
  }

  // 👍/👎 sobre una respuesta del bot; tocar el mismo voto otra vez lo quita.
  async function rate(m: MessageRow, value: 1 | -1) {
    setError(null);
    const next = m.feedback === value ? null : value;
    const note = next === -1 ? (window.prompt("¿Qué estuvo mal? (opcional)") ?? "") : "";
    const res = await setMessageFeedback(m.id, next, note);
    if (!res.ok) return setError(res.error ?? "No se pudo guardar la opinión");
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, feedback: next } : x)));
  }

  async function changeAssignee(next: string) {
    setError(null);
    const value = next || null;
    const { error } = await supabase.from("conversations").update({ assigned_to: value }).eq("id", p.conversationId);
    if (error) return setError("No se pudo asignar la conversación");
    setAssignedTo(value);
  }

  // "/atajo" abre el menú de respuestas rápidas mientras no haya espacios.
  const qrMatches =
    text.startsWith("/") && !/\s/.test(text)
      ? p.quickReplies.filter((q) => q.atajo.startsWith(text.slice(1).toLowerCase()))
      : [];
  function applyQuickReply(body: string) {
    setText(body);
    setQrIndex(0);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    const res = await fetch(`/api/inbox/conversations/${p.conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    setSending(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return setError(data.error ?? "No se pudo enviar el mensaje");
    }
    const { message, botPaused } = (await res.json()) as { message: MessageRow; botPaused?: boolean };
    if (botPaused) setBotActive(false); // tomaste el control: el servidor pausó el bot
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    setRequiresHuman(false);
    setText("");
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    const body = note.trim();
    if (!body) return;
    setError(null);
    const { data, error } = await supabase
      .from("conversation_notes")
      .insert({ conversation_id: p.conversationId, author_id: p.userId, body })
      .select("id, body, created_at")
      .single();
    if (error || !data) return setError("No se pudo guardar la nota");
    setNotes((prev) => [...prev, { ...data, author_name: p.userName }]);
    setNote("");
  }

  const title = p.lead.nombre ?? "Usuario de WhatsApp";
  // WhatsApp solo permite escribir libremente dentro de las 24 h desde el último mensaje del cliente.
  const ultimoDelCliente = [...messages].reverse().find((m) => m.sender === "lead")?.created_at ?? null;
  const ventanaCerrada = !!ultimoDelCliente && Date.now() - new Date(ultimoDelCliente).getTime() > 24 * 3_600_000;
  // Lo que se pregunta al abrir un chat: ¿tiene cita?, ¿suele venir?
  const proxima = p.appointments.find((a) => new Date(a.scheduled_at) >= new Date() && (a.status === "agendada" || a.status === "confirmada"));
  const vino = p.appointments.filter((a) => a.status === "atendida").length;
  const falto = p.appointments.filter((a) => a.status === "no_show").length;
  const assigneeName = p.team.find((u) => u.id === assignedTo)?.nombre ?? null;

  return (
    <div className="thread">
      <header className="thread-head">
        <Link href="/inbox" className="back">
          ← Chats
        </Link>
        <Avatar name={p.lead.nombre} />
        <div className="thread-who">
          <Link href={`/leads/${p.lead.id}`} className="lead-name">
            {title}
          </Link>
          <div className="muted">
            {p.lead.phone ?? "sin número visible"}
            {p.lead.branches && ` · ${p.lead.branches.nombre}`}
            {optOut && " · dado de baja"}
          </div>
        </div>
        <span className="spacer" />
        <span className={`bot-state${botActive ? " on" : ""}`}>
          <span className="bot-dot" aria-hidden="true" />
          {botActive ? "Bot atendiendo" : "Bot pausado"}
          <button
            type="button"
            className="link-btn"
            onClick={toggleBot}
            title={botActive ? "Pausar el bot (también se pausa solo si envías un mensaje)" : "Devolver la conversación al bot"}
          >
            {botActive ? "Pausar" : "Reactivar"}
          </button>
        </span>
        <button type="button" className="ghost only-narrow" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
          Datos
        </button>
        <button
          type="button"
          className="icon-btn wide-only"
          onClick={togglePanel}
          aria-pressed={panelPinned}
          aria-label={panelPinned ? "Ocultar datos del contacto" : "Mostrar datos del contacto"}
          title={panelPinned ? "Ocultar datos del contacto" : "Mostrar datos del contacto"}
        >
          <Icon name={panelPinned ? "panel-cerrar" : "panel-abrir"} size={18} />
        </button>
      </header>

      {optOut && (
        <div className="banner warn optout-banner">
          <span>
            <strong>Cliente dado de baja.</strong> Pidió no recibir mensajes, así que el bot no le escribe por su cuenta. Reactívalo solo si el cliente
            lo pidió (queda registrado a tu nombre).
          </span>
          <button type="button" className="btn-sm" onClick={reactivateCare}>
            Reactivar atención
          </button>
        </div>
      )}

      {requiresHuman && (
        <div className="banner warn">
          <strong>Requiere atención humana.</strong> {p.handoffReason}
          {escalated && <span className="tag err" style={{ marginLeft: 8 }}>⏰ Sin atender hace más de 15 min</span>}
          {summary && (
            <div className="handoff-summary">
              <strong>Resumen para ti</strong>
              <div>{summary}</div>
            </div>
          )}
        </div>
      )}

      <div className="thread-body">
        <div className="thread-main">
          <>
              <div className="messages">
                {hasMore && (
                  <button type="button" className="ghost btn-sm load-older" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? "Cargando…" : "Ver mensajes anteriores"}
                  </button>
                )}
                {messages.map((m, i) => {
                  const prev = messages[i - 1];
                  const newDay = !prev || limaDay(prev.created_at) !== limaDay(m.created_at);
                  const sameAuthor = prev && prev.sender === m.sender && !newDay;
                  return (
                    <Fragment key={m.id}>
                      {newDay && (
                        <div className="day-sep">
                          <span>{dayLabel(m.created_at)}</span>
                        </div>
                      )}
                      <div className={`msg${m.sender === "lead" ? "" : " out"}`}>
                        <div className={`bubble ${m.sender}`}>
                          {m.sender !== "lead" && !sameAuthor && <div className="who">{SENDER_LABEL[m.sender]}</div>}
                          <AttachmentView messageId={m.id} attachments={(m.attachments ?? []) as Attachment[]} />
                          {m.content ? (
                            <div className="body">{m.content}</div>
                          ) : (
                            (m.attachments ?? []).length === 0 && <div className="body"><em>📎 Archivo adjunto</em></div>
                          )}
                        </div>
                        <span className="msg-meta">
                          {m.sender === "lead" ? "Recibido" : "Enviado"} {time(m.created_at)}
                          {m.sender !== "lead" && <Ticks status={m.delivery_status ?? null} />}
                          {m.sender === "bot" && (
                            <span className={`fb${m.feedback ? " voted" : ""}`}>
                              <button type="button" className={m.feedback === 1 ? "on" : ""} aria-pressed={m.feedback === 1} aria-label="Buena respuesta" title="Buena respuesta" onClick={() => rate(m, 1)}>
                                👍
                              </button>
                              <button type="button" className={m.feedback === -1 ? "on bad" : ""} aria-pressed={m.feedback === -1} aria-label="Mala respuesta" title="Mala respuesta: queda en Sistema para revisarla" onClick={() => rate(m, -1)}>
                                👎
                              </button>
                            </span>
                          )}
                        </span>
                      </div>
                    </Fragment>
                  );
                })}
                {messages.length === 0 && <p className="muted">Sin mensajes todavía.</p>}
                <div ref={bottom} />
              </div>
              {ventanaCerrada ? (
                <p className="takeover-hint closed">
                  <span aria-hidden="true">⛔</span> <strong>No se le puede escribir por WhatsApp.</strong> Pasaron más de 24 h desde su último mensaje; Meta solo
                  permite retomar con una plantilla aprobada o cuando el cliente vuelva a escribir. Si es urgente, llámalo.
                </p>
              ) : (
                botActive && (
                  <p className="takeover-hint">
                    <span aria-hidden="true">🤖</span> El bot está atendiendo este chat. Si envías un mensaje, <strong>se pausa</strong> y tú tomas la conversación.
                  </p>
                )
              )}
              <form onSubmit={send} className="composer">
                <div className="composer-pill">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={ventanaCerrada ? "WhatsApp no permite escribirle ahora…" : botActive ? "Escribe para tomar el control de este chat…" : "Escribe un mensaje…  (/ para respuestas rápidas)"}
                  rows={2}
                  onKeyDown={(e) => {
                    if (qrMatches.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        return setQrIndex((i) => (i + 1) % qrMatches.length);
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        return setQrIndex((i) => (i - 1 + qrMatches.length) % qrMatches.length);
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        return applyQuickReply(qrMatches[Math.min(qrIndex, qrMatches.length - 1)].cuerpo);
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) send(e);
                  }}
                />
                {qrMatches.length > 0 && (
                  <div className="qr-menu" role="listbox">
                    {qrMatches.map((q, i) => (
                      <button
                        key={q.atajo}
                        type="button"
                        role="option"
                        aria-selected={i === qrIndex}
                        className={i === qrIndex ? "active" : ""}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyQuickReply(q.cuerpo);
                        }}
                      >
                        <strong>/{q.atajo}</strong> · {q.titulo}
                        <div className="muted">{q.cuerpo.slice(0, 90)}</div>
                      </button>
                    ))}
                  </div>
                )}
                <button type="submit" className="send" aria-label="Enviar" title={ventanaCerrada ? "Pasaron más de 24 h desde su último mensaje" : "Enviar (Enter)"} disabled={sending || !text.trim() || ventanaCerrada}>
                  <Icon name="enviar" size={17} />
                </button>
                </div>
              </form>
            </>

          {error && <p className="error pad">{error}</p>}
        </div>

        <aside className={`contact-panel${panelOpen ? " open" : ""}${panelPinned ? "" : " hidden-wide"}`}>
          <div className="cp-block">
            <h3>Seguimiento</h3>
            <div className="cp-stage">
              {p.lead.archived_at ? (
                <span className="tag" title="Fuera del tablero">
                  Archivado · {ARCHIVE_REASON_LABEL[p.lead.archive_reason as ArchiveReason] ?? "sin motivo"}
                </span>
              ) : (
                <span className={`tag dot-${p.lead.stage}`} title={LEAD_STAGE_HINT[p.lead.stage]}>
                  {LEAD_STAGE_LABEL[p.lead.stage]}
                </span>
              )}
              <Link href="/pipeline" className="muted">
                Tablero →
              </Link>
            </div>
            <p className="cp-note muted">La etapa se mueve sola: cuando le respondes, cuando agenda o cuando deja de contestar.</p>
            <label>
              Asignado a
              <select value={assignedTo ?? ""} onChange={(e) => changeAssignee(e.target.value)} aria-label="Asignado a" style={{ width: "100%" }}>
                <option value="">Sin asignar</option>
                {p.team.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="cp-block">
            <h3>Citas</h3>
            {proxima ? (
              <div className="cp-appt">
                <strong>{apptWhen(proxima.scheduled_at)}</strong>
                <span className="muted">
                  {proxima.branches?.nombre ?? "sin sucursal"} · {APPOINTMENT_STATUS_LABEL[proxima.status]}
                </span>
              </div>
            ) : (
              <p className="cp-note muted">Sin cita agendada. Es el objetivo de este chat.</p>
            )}
            {(vino > 0 || falto > 0) && (
              <div className="cp-line">
                <span className="cp-ico g">
                  <Icon name="citas" size={15} />
                </span>
                Historial
                <span className="val">
                  {vino > 0 && `vino ${vino}`}
                  {vino > 0 && falto > 0 && " · "}
                  {falto > 0 && `faltó ${falto}`}
                </span>
              </div>
            )}
            <Link href="/citas" className="muted cp-more">
              Ver citas →
            </Link>
          </div>

          <div className="cp-block">
            <h3>Notas del equipo</h3>
            {/* Junto al chat, no en su lugar: una nota sirve mientras lees la conversación, y antes había que
                ocultar el chat para verla. El cliente nunca las ve. */}
            {notes.length === 0 ? (
              <p className="cp-vacio">Nadie ha anotado nada todavía. Lo que escribas aquí solo lo ve tu equipo.</p>
            ) : (
              <ul className="cp-notas">
                {notes.map((n) => (
                  <li key={n.id}>
                    <div className="cp-nota-quien">
                      {n.author_name} · {fmt(n.created_at)}
                    </div>
                    {n.body}
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={addNote} className="cp-nota-form">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Añadir una nota…" rows={2} />
              <button type="submit" className="btn-sm" disabled={!note.trim()}>
                Guardar nota
              </button>
            </form>
          </div>

          <div className="cp-block">
            <h3>Contacto</h3>
            <div className="cp-line">
              <span className="cp-ico b">
                <Icon name="tendencia" size={15} />
              </span>
              Origen
              <span className="val">{LEAD_ORIGIN_LABEL[p.lead.origin]}</span>
            </div>
            <div className="cp-line">
              <span className="cp-ico y">
                <Icon name="reloj" size={15} />
              </span>
              Cliente desde
              <span className="val">{sinceLabel(p.lead.created_at)}</span>
            </div>
            {p.lead.tags.length > 0 && (
              <div className="cp-tags">
                {p.lead.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          {optOut && (
            <p className="tag warn" style={{ whiteSpace: "normal", lineHeight: 1.4, padding: "8px 10px" }}>
              Pidió no recibir mensajes. No lo incluyas en envíos masivos.
            </p>
          )}

          <Link href={`/leads/${p.lead.id}`} className="btn ghost btn-sm" style={{ justifyContent: "center" }}>
            Ver ficha completa
          </Link>
        </aside>
      </div>
    </div>
  );
}
