"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

const KEY = "optuz:sidebar-collapsed";

/**
 * Botón que contrae/expande la barra lateral (contraída = solo íconos). Deja `data-sidebar="collapsed"`
 * en <html> (el CSS hace el resto) y recuerda la elección en este navegador. El script de `app/layout.tsx`
 * lo aplica antes del primer pintado para evitar el parpadeo al recargar.
 */
export function PanelToggle() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(KEY) === "1");
    } catch {
      /* sin almacenamiento (modo privado): queda expandida */
    }
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    if (next) document.documentElement.dataset.sidebar = "collapsed";
    else delete document.documentElement.dataset.sidebar;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* no pasa nada: solo no se recuerda */
    }
  }

  const label = collapsed ? "Expandir barra lateral" : "Contraer barra lateral";
  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={label} aria-pressed={collapsed} title={label}>
      <Icon name="menu" size={18} />
    </button>
  );
}
