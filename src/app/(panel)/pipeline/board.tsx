"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icons";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { horaCorta } from "@/lib/time";
import { archiveLead } from "@/app/(panel)/crm-actions";
import { escribirANoAsistio } from "@/app/(panel)/actions";
import { LEAD_STAGE_HINT, LEAD_STAGE_LABEL, LEAD_ORIGIN_LABEL, MANUAL_ARCHIVE_REASONS, ARCHIVE_REASON_LABEL, type LeadOrigin, type LeadStage } from "@/lib/types";
import { CAMPOS_LEAD, COLUMNAS, ESPERA_DESDE, HUMANO, MOTIVO_NO_MOVIBLE, ORDEN, POR_COLUMNA, toBoardLead, type BoardLead, type Columna, type LeadRow } from "./orden";

export type { BoardLead };

const fmt = (iso: string) =>
  horaCorta(new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit" }).format(new Date(iso)));

const COLUMNA_LABEL = (c: Columna) => (c === HUMANO ? "Requiere Humano" : LEAD_STAGE_LABEL[c]);
const COLUMNA_HINT = (c: Columna) =>
  c === HUMANO
    ? "Chats que esperan a una persona. Al atenderlos vuelven a la etapa que les toque."
    : LEAD_STAGE_HINT[c];

/**
 * Pedir un tramo que ya no existe no es un fallo: entre que se pintó el total y se pulsó «ver más», alguien
 * pudo archivar tarjetas. Simplemente no hay más que traer.
 */
const sinMasFilas = (e: { code?: string }) => e.code === "PGRST103";

/**
 * Desde cuándo espera este lead, en las columnas donde esperar ES el problema: en «Nuevo» desde que escribió
 * por primera vez, y en «Requiere humano» desde el último mensaje del chat. En las demás no se muestra,
 * porque ahí el tiempo no significa lo mismo.
 */
const espera = (status: Columna, l: BoardLead): string | null => {
  const desde = ESPERA_DESDE[status];
  if (desde === "creado") return l.createdAt;
  if (desde === "ultimo_mensaje") return l.lastMessageAt;
  return null;
};

/** «2 h», «3 d»: cuánto lleva sin contestar. */
function since(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

export function Board({
  initial,
  totales,
  branches,
  userId,
}: {
  initial: Record<Columna, BoardLead[]>;
  totales: Record<Columna, number>;
  branches: { id: string; nombre: string }[];
  userId: string;
}) {
  // Las columnas llegan ya ordenadas desde el servidor, cada una por lo suyo. Aquí se guardan en una sola
  // lista porque mover una tarjeta le cambia la columna; el orden dentro de cada una se conserva.
  const [leads, setLeads] = useState(() => COLUMNAS.flatMap((c) => initial[c] ?? []));
  const [cargando, setCargando] = useState<Columna | null>(null);
  const [over, setOver] = useState<Columna | null>(null);
  const [archiving, setArchiving] = useState<BoardLead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [escribiendo, setEscribiendo] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [owner, setOwner] = useState<"todos" | "mios" | "sin_asignar" | "humano" | "en_visto">("todos");
  const [q, setQ] = useState("");

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (branch === "ninguna" ? l.branchId : branch && l.branchId !== branch) return false;
      if (owner === "mios" && l.assignedTo !== userId) return false;
      if (owner === "sin_asignar" && l.assignedTo) return false;
      if (owner === "humano" && !l.requiresHuman) return false;
      if (owner === "en_visto" && !l.waitingOnClient) return false;
      return !term || `${l.nombre ?? ""} ${l.phone ?? ""}`.toLowerCase().includes(term);
    });
  }, [leads, branch, owner, q, userId]);

  async function move(id: string, destino: Columna) {
    const prev = leads;
    const lead = prev.find((l) => l.id === id);
    if (!lead) return;
    const db = createSupabaseBrowserClient();
    setError(null);

    // A «Requiere humano»: se marca el chat para que alguien lo atienda y se pausa el bot.
    if (destino === HUMANO) {
      if (lead.requiresHuman || !lead.conversationId) return;
      setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, requiresHuman: true } : l)));
      const { error } = await db
        .from("conversations")
        .update({ requires_human: true, bot_active: false, handoff_reason: "Marcado a mano desde el tablero" })
        .eq("id", lead.conversationId);
      if (error) {
        setLeads(prev);
        setError("No se pudo marcar el chat.");
      }
      return;
    }

    // Hay columnas que no se ponen a mano porque salen de un hecho (ver MOTIVO_NO_MOVIBLE).
    if (MOTIVO_NO_MOVIBLE[destino]) {
      setError(MOTIVO_NO_MOVIBLE[destino]!);
      return;
    }

    // Sacarlo de «Requiere humano» es darlo por atendido, además de cambiarlo de etapa.
    const atender = lead.requiresHuman && lead.conversationId;
    if (lead.stage === destino && !atender) return;
    setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, stage: destino, requiresHuman: false } : l))); // optimista

    const { error } = await db.from("leads").update({ stage: destino }).eq("id", id);
    if (error) {
      setLeads(prev);
      setError("No se pudo mover el lead.");
      return;
    }
    if (atender) {
      // Se devuelve al bot, además de quitar la marca. Sin esto el chat quedaba en el peor estado posible:
      // el bot apagado (se apagó al pedir persona) y ya sin el aviso de que alguien debe atenderlo, así que
      // no contestaba nadie y el tablero no lo señalaba.
      const { error: convErr } = await db
        .from("conversations")
        .update({ requires_human: false, bot_active: true, handoff_reason: null })
        .eq("id", lead.conversationId!);
      if (convErr) {
        setLeads(prev);
        setError("Se movió el lead, pero no se pudo dar por atendido el chat.");
      }
    }
  }

  /**
   * Trae el siguiente tramo de una columna. Usa exactamente el mismo orden que el servidor (ORDEN), para que
   * «ver más» continúe la lista en vez de empezar otra distinta.
   */
  async function verMas(status: Columna) {
    setError(null);
    setCargando(status);
    const db = createSupabaseBrowserClient();
    const desde = leads.filter((l) => (status === HUMANO ? l.requiresHuman : !l.requiresHuman && l.stage === status)).length;

    let nuevas: BoardLead[] = [];
    if (status === HUMANO) {
      let q = db
        .from("conversations")
        .select(`lead_id, leads!inner(${CAMPOS_LEAD})`)
        .eq("requires_human", true)
        .eq("leads.opt_out", false)
        .is("leads.archived_at", null);
      for (const o of ORDEN[status]) q = q.order(o.col, { ascending: o.ascending, nullsFirst: o.nullsFirst });
      const { data, error } = await q.range(desde, desde + POR_COLUMNA - 1);
      if (error && !sinMasFilas(error)) { setCargando(null); setError("No se pudieron cargar más tarjetas."); return; }
      nuevas = (data ?? []).map((r) => toBoardLead(r.leads as unknown as LeadRow));
    } else {
      const yaHumano = leads.filter((l) => l.requiresHuman).map((l) => l.id);
      let q = db.from("leads").select(CAMPOS_LEAD).eq("stage", status).eq("opt_out", false).is("archived_at", null);
      if (yaHumano.length) q = q.not("id", "in", `(${yaHumano.join(",")})`);
      for (const o of ORDEN[status]) q = q.order(o.col, { ascending: o.ascending, nullsFirst: o.nullsFirst });
      const { data, error } = await q.range(desde, desde + POR_COLUMNA - 1);
      if (error && !sinMasFilas(error)) { setCargando(null); setError("No se pudieron cargar más tarjetas."); return; }
      nuevas = (data ?? []).map((l) => toBoardLead(l as unknown as LeadRow));
    }

    // Una tarjeta pudo moverse de columna mientras tanto: no se duplica.
    setLeads((cur) => {
      const vistos = new Set(cur.map((l) => l.id));
      return [...cur, ...nuevas.filter((l) => !vistos.has(l.id))];
    });
    setCargando(null);
  }

  /** Le escribe a quien no vino para ofrecerle otro horario. Lo decide una persona, no pasa solo. */
  async function recuperar(lead: BoardLead) {
    setError(null);
    setEscribiendo(lead.id);
    const res = await escribirANoAsistio(lead.id);
    setEscribiendo(null);
    if (!res.ok) setError(res.error ?? "No se le pudo escribir.");
    else setAviso(res.message ?? "Mensaje enviado.");
  }

  /** Sacar del tablero a quien no pertenece al embudo. Se puede deshacer desde la ficha del contacto. */
  async function archive(lead: BoardLead, reason: string) {
    setArchiving(null);
    setError(null);
    const prev = leads;
    setLeads((cur) => cur.filter((l) => l.id !== lead.id)); // optimista
    const res = await archiveLead(lead.id, reason);
    if (!res.ok) {
      setLeads(prev);
      setError(res.error ?? "No se pudo archivar el contacto.");
    }
  }

  return (
    <>
      <div className="toolbar">
        <Link href="/leads?nuevo=1" className="btn primary">
          <Icon name="mas" size={16} /> Nuevo contacto
        </Link>
        <span className="spacer" />
        <input
          type="search"
          className="toolbar-search"
          placeholder="Filtrar tarjetas…"
          aria-label="Filtrar tarjetas"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted summary">{visible.length} leads</span>
        <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Sucursal">
          <option value="">Todas las sucursales</option>
          <option value="ninguna">Sin sucursal</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.nombre}
            </option>
          ))}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value as typeof owner)} aria-label="Responsable">
          <option value="todos">Todos</option>
          <option value="mios">Asignados a mí</option>
          <option value="sin_asignar">Sin asignar</option>
          <option value="humano">Requieren humano</option>
          <option value="en_visto">En visto (no contestan)</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {aviso && <p className="banner ok">{aviso}</p>}

      <div className="board">
        {COLUMNAS.map((status) => {
          // Quien espera a una persona sale en la primera columna, no en su etapa. El orden dentro de cada
          // una lo decidió la base (ver ORDEN en ./orden.ts): aquí solo se reparten las tarjetas.
          const col = visible.filter((l) => (status === HUMANO ? l.requiresHuman : !l.requiresHuman && l.stage === status));
          const cargadas = leads.filter((l) => (status === HUMANO ? l.requiresHuman : !l.requiresHuman && l.stage === status)).length;
          const faltan = Math.max(0, (totales[status] ?? 0) - cargadas);
          return (
            <section
              key={status}
              className={`column st-${status}${over === status ? " over" : ""}`}
              data-status={status}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver((o) => (o === status ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData("text/plain");
                if (id) void move(id, status);
              }}
            >
              <header title={COLUMNA_HINT(status)}>
                <strong>{COLUMNA_LABEL(status)}</strong>
                <span className="col-sub muted">
                  {faltan > 0 ? `${col.length} de ${totales[status]}` : `${col.length} ${col.length === 1 ? "lead" : "leads"}`}
                </span>
              </header>
              {col.map((l) => {
                const title = l.nombre ?? l.phone ?? "Usuario de WhatsApp";
                const state = l.requiresHuman ? "warn" : l.conversationId ? "ok" : "idle";
                return (
                  <article
                    key={l.id}
                    className={`lead-card${l.requiresHuman ? " urgent" : ""}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", l.id)}
                  >
                    {l.tags.length > 0 && (
                      <div className="tag-stripes" title={l.tags.join(", ")}>
                        {l.tags.slice(0, 3).map((t) => (
                          <i key={t} className={`stripe c${[...t].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 5}`} />
                        ))}
                      </div>
                    )}
                    <div className="lead-main">
                      <div>
                        <Link href={`/leads/${l.id}`} className="lead-title">
                          {title}
                        </Link>
                        <div className="muted lead-sub">{l.nombre ? (l.phone ?? "sin número visible") : (l.branch ?? "")}</div>
                      </div>
                      {l.conversationId ? (
                        <Link
                          href={`/inbox/${l.conversationId}`}
                          className={`state-dot ${state}`}
                          title={l.requiresHuman ? "Requiere atención humana: abrir chat" : "Abrir chat"}
                          aria-label={`Abrir chat de ${title}`}
                        >
                          <Icon name="inbox" size={14} />
                        </Link>
                      ) : (
                        <span className="state-dot idle" title="Sin conversación" />
                      )}
                    </div>
                    {(l.waitingOnClient || l.sawSlots || l.returnedAt || espera(status, l) || l.nextAppointmentAt) && (
                      <div className="lead-marks">
                        {/* Lo que lleva esperando, donde esperar es el problema: nadie le ha contestado todavía. */}
                        {espera(status, l) && (
                          <span className="mark urge" title={`Espera desde el ${fmt(espera(status, l)!)}`}>
                            ⏱ lleva {since(espera(status, l)!)} esperando
                          </span>
                        )}
                        {status === "cita_agendada" && l.nextAppointmentAt && (
                          <span className="mark hot" title={`Su cita es el ${fmt(l.nextAppointmentAt)}`}>
                            cita {fmt(l.nextAppointmentAt)}
                          </span>
                        )}
                        {l.sawSlots && (
                          <span className="mark hot" title="Llegó a ver horarios concretos: estuvo a un paso de agendar">
                            vio horarios
                          </span>
                        )}
                        {l.returnedAt && (
                          <span className="mark" title={`Volvió a escribir el ${fmt(l.returnedAt)}`}>
                            volvió
                          </span>
                        )}
                        {l.waitingOnClient && l.lastMessageAt && (
                          <span className="mark quiet" title="El último mensaje es nuestro: está en visto">
                            ⏱ {since(l.lastMessageAt)} sin contestar
                          </span>
                        )}
                      </div>
                    )}
                    <div className="lead-foot">
                      {l.assigneeName ? (
                        <Avatar name={l.assigneeName} size="sm" title={`Asignado a ${l.assigneeName}`} />
                      ) : (
                        <span className="avatar sm empty" title="Sin asignar">
                          <Icon name="usuario" size={13} />
                        </span>
                      )}
                      {l.branch && l.nombre && <span className="tag">{l.branch}</span>}
                      {l.origin !== "otro" && <span className="tag">{LEAD_ORIGIN_LABEL[l.origin]}</span>}
                      {l.tags.slice(0, 2).map((t) => (
                        <span key={t} className="tag ok">
                          {t}
                        </span>
                      ))}
                      <span className="spacer" />
                      {l.lastMessageAt && <span className="muted">{fmt(l.lastMessageAt)}</span>}
                    </div>
                    {/* Alternativa al arrastre (móvil / teclado): visible al pasar el cursor o enfocar */}
                    <div className="card-actions">
                      <select
                        className="move"
                        value={l.requiresHuman ? HUMANO : l.stage}
                        onChange={(e) => move(l.id, e.target.value as Columna)}
                        aria-label="Mover a"
                      >
                        {COLUMNAS.filter((s) => !MOTIVO_NO_MOVIBLE[s] || l.stage === s).map((s) => (
                          <option key={s} value={s}>
                            {COLUMNA_LABEL(s)}
                          </option>
                        ))}
                      </select>
                      {l.stage === "no_asistio" && (
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={escribiendo === l.id}
                          title="Ofrecerle otro horario por WhatsApp"
                          onClick={() => void recuperar(l)}
                        >
                          {escribiendo === l.id ? "Enviando…" : "Escribirle"}
                        </button>
                      )}
                      <button type="button" className="icon-btn" title="Archivar: sacarlo del tablero" aria-label={`Archivar a ${title}`} onClick={() => setArchiving(l)}>
                        <Icon name="archivar" size={16} />
                      </button>
                    </div>
                  </article>
                );
              })}
              {col.length === 0 && (
                <div className="col-empty muted">{status === HUMANO ? "Nadie espera a una persona" : "Suelta un lead aquí"}</div>
              )}
              {faltan > 0 && (
                <button type="button" className="ghost btn-sm col-mas" disabled={cargando === status} onClick={() => void verMas(status)}>
                  {cargando === status ? "Cargando…" : `Ver ${Math.min(faltan, POR_COLUMNA)} más`}
                </button>
              )}
            </section>
          );
        })}
      </div>

      {archiving && (
        <div className="archive-pop" role="dialog" aria-label="Archivar contacto">
          <div className="archive-card">
            <strong>Archivar a {archiving.nombre ?? archiving.phone ?? "este contacto"}</strong>
            <p className="muted">Sale del tablero. Sus chats siguen llegando al inbox y puedes recuperarlo desde su ficha.</p>
            {MANUAL_ARCHIVE_REASONS.map((r) => (
              <button key={r} type="button" className="ghost" onClick={() => archive(archiving, r)}>
                {ARCHIVE_REASON_LABEL[r]}
              </button>
            ))}
            <p className="hint">
              Si lo archivas como «no es un cliente», no volverá al tablero aunque escriba otra vez.
            </p>
            <button type="button" className="ghost btn-sm" onClick={() => setArchiving(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </>
  );
}
