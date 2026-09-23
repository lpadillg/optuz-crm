"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icons";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { horaCorta } from "@/lib/time";

export interface ConversationItem {
  id: string;
  bot_active: boolean;
  requires_human: boolean;
  assigned_to: string | null;
  escalated_at: string | null;
  last_message_at: string;
  last_message_preview: string;
  /** Quién envió el último mensaje: si fue el cliente, el chat espera respuesta. */
  last_message_sender: "bot" | "humano" | "lead" | null;
  leads: { nombre: string | null; phone: string | null; branches: { nombre: string } | null } | null;
  assignee: { nombre: string } | null;
}

type FilterId = "esperando" | "humano" | "mias" | "sin_asignar" | "pausado" | "recientes";

/**
 * Filtros que SE SUMAN entre sí. Antes eran carpetas excluyentes en una columna aparte, y no se podía pedir
 * lo más normal: «las mías que están esperando respuesta». Cada uno responde a una pregunta distinta —quién
 * espera, de quién es, qué hace el bot, cuándo fue— así que combinarlos es justo lo que hace falta.
 */
const FILTERS: { id: FilterId; label: string; hint: string; alert?: boolean }[] = [
  { id: "esperando", label: "Esperando respuesta", hint: "El cliente escribió lo último y nadie le ha contestado", alert: true },
  { id: "humano", label: "Requieren persona", hint: "El bot las derivó al equipo", alert: true },
  { id: "mias", label: "Mías", hint: "Asignadas a ti" },
  { id: "sin_asignar", label: "Sin asignar", hint: "Nadie se ha hecho cargo todavía" },
  { id: "pausado", label: "Bot pausado", hint: "Las lleva una persona: el bot no responde" },
  { id: "recientes", label: "Últimas 24 h", hint: "Con movimiento en el último día" },
];

const DAY = 86_400_000;

const matches = (c: ConversationItem, f: FilterId, userId: string) =>
  (f === "esperando" && c.last_message_sender === "lead") ||
  (f === "humano" && c.requires_human) ||
  (f === "mias" && c.assigned_to === userId) ||
  (f === "sin_asignar" && c.assigned_to === null) ||
  (f === "pausado" && !c.bot_active && !c.requires_human) ||
  (f === "recientes" && Date.now() - new Date(c.last_message_at).getTime() < DAY);

/** «3 min», «2 h 10 min». */
function waitLabel(ms: number) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h >= 24 ? `${Math.floor(h / 24)} d` : `${h} h ${min % 60} min`;
}
/** Hoy → hora; esta semana → día; antes → fecha corta. */
function when(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const opts: Intl.DateTimeFormatOptions =
    diff < DAY
      ? { hour: "numeric", minute: "2-digit" }
      : diff < 7 * DAY
        ? { weekday: "short" }
        : { day: "2-digit", month: "2-digit" };
  return horaCorta(new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", ...opts }).format(d));
}

export function ConversationList({ items, userId }: { items: ConversationItem[]; userId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abre mostrando quién espera respuesta; si no espera nadie, abre sin filtros (una lista vacía al entrar confunde).
  const [active, setActive] = useState<FilterId[]>(() => (items.some((c) => c.last_message_sender === "lead") ? ["esperando"] : []));
  const [branch, setBranch] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Reloj para el «esperando hace N min» de los chats pendientes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Cualquier mensaje o cambio de estado (bot pausado, derivación, asignación) refresca la lista, con debounce.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };
    const channel = supabase
      .channel("inbox-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, refresh)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [router]);

  const toggle = (id: FilterId) => setActive((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const passes = (c: ConversationItem, filters: FilterId[]) =>
    filters.every((f) => matches(c, f, userId)) && (!branch || c.leads?.branches?.nombre === branch);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items
      .filter((c) => {
        if (!passes(c, active)) return false;
        if (!term) return true;
        const hay = `${c.leads?.nombre ?? ""} ${c.leads?.phone ?? ""} ${c.last_message_preview}`.toLowerCase();
        return hay.includes(term);
      })
      // Primero quien espera a una persona, después quien espera respuesta, y dentro de cada grupo lo más reciente.
      .sort(
        (a, b) =>
          Number(b.requires_human) - Number(a.requires_human) ||
          Number(b.last_message_sender === "lead") - Number(a.last_message_sender === "lead") ||
          new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime(),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, active, branch, q, userId]);

  // En cada filtro, cuántos chats quedarían si se añade al resto: así no se llega nunca a una lista vacía a ciegas.
  const counts = useMemo(() => {
    const out = {} as Record<FilterId, number>;
    for (const f of FILTERS) {
      const combo = active.includes(f.id) ? active : [...active, f.id];
      out[f.id] = items.filter((c) => passes(c, combo)).length;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, active, branch, userId]);

  const branches = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of items.filter((c) => passes(c, active))) {
      const b = c.leads?.branches?.nombre;
      if (b) m.set(b, (m.get(b) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, active, userId]);

  const sinFiltros = active.length === 0 && !branch;

  return (
    <>
      <aside className="conv-list">
        <div className="conv-head">
          <div className="title">
            <strong>Chats</strong>
            <span className="muted">{visible.length}</span>
            <span className="spacer" />
            <div className="search-pill">
              <Icon name="buscar" size={16} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar chat…" aria-label="Buscar chat" />
            </div>
          </div>

          <div className="conv-filters" role="group" aria-label="Filtros">
            <button
              type="button"
              className={`chip-btn${sinFiltros ? " on" : ""}`}
              aria-pressed={sinFiltros}
              onClick={() => {
                setActive([]);
                setBranch(null);
              }}
              title="Quitar todos los filtros"
              aria-label={`Todas, ${items.length} chats`}
            >
              Todas <span className="chip-n" aria-hidden="true">{items.length}</span>
            </button>
            {FILTERS.map((f) => {
              const on = active.includes(f.id);
              const n = counts[f.id];
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`chip-btn${on ? " on" : ""}${f.alert && n > 0 ? " urge" : ""}`}
                  aria-pressed={on}
                  title={f.hint}
                  disabled={!on && n === 0}
                  onClick={() => toggle(f.id)}
                >
                  {f.label} <span className="chip-n" aria-hidden="true">{n}</span>
                </button>
              );
            })}
            {branches.length > 1 && (
              <select
                className="chip-select"
                value={branch ?? ""}
                onChange={(e) => setBranch(e.target.value || null)}
                aria-label="Sucursal"
                title="Filtrar por sucursal"
              >
                <option value="">Todas las sucursales</option>
                {branches.map(([name, n]) => (
                  <option key={name} value={name}>
                    {name} ({n})
                  </option>
                ))}
              </select>
            )}
          </div>

          {!sinFiltros && (
            <p className="conv-hint muted">
              {active.length > 0 && active.map((id) => FILTERS.find((f) => f.id === id)!.hint).join(" · ")}
              {branch && `${active.length > 0 ? " · " : ""}Solo ${branch}`}
            </p>
          )}
        </div>

        {visible.length === 0 && (
          <p className="muted pad">
            {items.length === 0 ? "Aún no hay conversaciones." : q.trim() ? "Sin resultados para esa búsqueda." : "Ningún chat cumple estos filtros."}
          </p>
        )}

        {visible.map((c) => {
          const isOpen = pathname === `/inbox/${c.id}`;
          const name = c.leads?.nombre ?? c.leads?.phone ?? "Usuario de WhatsApp";
          const pip = c.requires_human ? "wait" : c.bot_active ? "on" : "";
          // El cliente escribió lo último: el chat espera una respuesta.
          const waiting = c.last_message_sender === "lead";
          return (
            <Link key={c.id} href={`/inbox/${c.id}`} className={`conv${isOpen ? " active" : ""}${waiting ? " waiting" : ""}`}>
              <span className="conv-avatar">
                <Avatar name={c.leads?.nombre ?? null} />
                <i className={`pip ${pip}`} title={c.requires_human ? "Espera a una persona" : c.bot_active ? "Bot activo" : "Bot pausado"} />
              </span>
              <div className="conv-body">
                <div className="conv-top">
                  <strong>
                    {name}
                    {waiting && <i className="unread" title="Esperando respuesta" aria-label="Esperando respuesta" />}
                  </strong>
                  <time className="muted">{when(c.last_message_at)}</time>
                </div>
                <div className="conv-preview muted">{c.last_message_preview}</div>
                <div className="conv-tags">
                  {c.leads?.branches?.nombre && <span className="tag">{c.leads.branches.nombre}</span>}
                  {c.requires_human && <span className="tag warn">Requiere persona</span>}
                  {waiting && (
                    <span className={`tag ${c.escalated_at ? "err" : ""}`} title="Tiempo desde el último mensaje del cliente">
                      ⏱ {waitLabel(now - new Date(c.last_message_at).getTime())}
                    </span>
                  )}
                  {!c.bot_active && !c.requires_human && <span className="tag">Bot pausado</span>}
                  {c.assignee && <span className="tag ok">{c.assignee.nombre}</span>}
                </div>
              </div>
            </Link>
          );
        })}
      </aside>
    </>
  );
}
