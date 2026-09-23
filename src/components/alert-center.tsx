"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface Toast {
  id: number;
  title: string;
  body: string;
  href: string;
  tone: "warn" | "err" | "info";
}

const KEY = "optuz:alerts";

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    setTimeout(() => ctx.close().catch(() => {}), 400);
  } catch {
    /* el navegador bloquea el sonido hasta que la persona interactúa con la página */
  }
}

/**
 * Avisos en vivo para quien atiende: un chat que pasa a «requiere humano», un chat sin atender por más de 15 minutos y
 * los mensajes nuevos en los chats que tú llevas. Tarjeta emergente siempre; sonido y aviso del navegador si los activas
 * con la campana. Solo funciona con el CRM abierto en alguna pestaña (para avisos con el CRM cerrado, ver los correos).
 */
export function AlertCenter({ userId, role, waitingIds, escalatedIds }: { userId: string; role: "admin" | "vendedor"; waitingIds: string[]; escalatedIds: string[] }) {
  const [enabled, setEnabled] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const known = useRef(new Set(waitingIds));
  const knownEscalated = useRef(new Set(escalatedIds));
  const seq = useRef(0);
  const unseen = useRef(0);
  const enabledRef = useRef(false);
  const baseTitle = useRef("");

  useEffect(() => {
    try {
      const on = localStorage.getItem(KEY) === "1" && typeof Notification !== "undefined" && Notification.permission === "granted";
      setEnabled(on);
      enabledRef.current = on;
    } catch {
      /* sin almacenamiento */
    }
    baseTitle.current = document.title.replace(/^\(\d+\)\s*/, "");
    const clear = () => {
      unseen.current = 0;
      document.title = baseTitle.current;
    };
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, []);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    function notify(title: string, body: string, href: string, tone: Toast["tone"]) {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, title, body, href, tone }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 9000);
      if (document.hidden) {
        unseen.current += 1;
        document.title = `(${unseen.current}) ${baseTitle.current}`;
      }
      if (enabledRef.current) {
        beep();
        if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(title, { body, tag: href });
          } catch {
            /* algunos navegadores solo permiten notificaciones desde un service worker */
          }
        }
      }
    }

    async function nameOf(conversationId: string) {
      const { data } = await supabase.from("conversations").select("leads(nombre, phone)").eq("id", conversationId).maybeSingle();
      const lead = data?.leads as unknown as { nombre: string | null; phone: string | null } | null;
      return lead?.nombre ?? lead?.phone ?? "Un cliente";
    }

    const channel = supabase
      .channel("alerts")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, async (payload) => {
        const row = payload.new as { id: string; requires_human: boolean; assigned_to: string | null; escalated_at: string | null; handoff_reason: string | null };
        if (!row.requires_human) {
          known.current.delete(row.id);
          knownEscalated.current.delete(row.id);
          return;
        }
        const mine = row.assigned_to === userId || row.assigned_to === null || role === "admin";
        if (!known.current.has(row.id)) {
          known.current.add(row.id);
          if (mine) notify("Un chat necesita a una persona", `${await nameOf(row.id)}: ${row.handoff_reason ?? "requiere atención"}`, `/inbox/${row.id}`, "warn");
        }
        if (row.escalated_at && !knownEscalated.current.has(row.id)) {
          knownEscalated.current.add(row.id);
          if (mine) notify("⏰ Sin atender hace más de 15 minutos", await nameOf(row.id), `/inbox/${row.id}`, "err");
        }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async (payload) => {
        const m = payload.new as { conversation_id: string; direction: string; content: string };
        if (m.direction !== "in") return;
        // Solo interesa si una persona lleva el chat (bot pausado) y es mío (o nadie lo lleva y soy admin).
        const { data } = await supabase.from("conversations").select("bot_active, assigned_to").eq("id", m.conversation_id).maybeSingle();
        if (!data || data.bot_active) return;
        if (data.assigned_to !== userId && !(data.assigned_to === null && role === "admin")) return;
        notify(`Mensaje nuevo de ${await nameOf(m.conversation_id)}`, (m.content || "📎 Archivo adjunto").slice(0, 100), `/inbox/${m.conversation_id}`, "info");
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, role]);

  async function toggle() {
    if (enabled) {
      setEnabled(false);
      enabledRef.current = false;
      try {
        localStorage.setItem(KEY, "0");
      } catch {}
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    const ok = typeof Notification !== "undefined" && Notification.permission === "granted";
    setEnabled(ok);
    enabledRef.current = ok;
    try {
      localStorage.setItem(KEY, ok ? "1" : "0");
    } catch {}
    if (ok) beep();
  }

  return (
    <>
      <button
        type="button"
        className={`icon-btn${enabled ? " on" : ""}`}
        onClick={toggle}
        aria-pressed={enabled}
        aria-label={enabled ? "Desactivar avisos con sonido" : "Activar avisos con sonido"}
        title={enabled ? "Avisos con sonido activados (clic para desactivar)" : "Activar avisos con sonido y del navegador"}
      >
        <Icon name="campana" size={18} />
      </button>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <Link key={t.id} href={t.href} className={`toast ${t.tone}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            <strong>{t.title}</strong>
            <span>{t.body}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
