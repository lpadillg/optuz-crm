"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon, type IconName } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
  /** Los enlaces de administración van bajo su propio encabezado. */
  admin?: boolean;
  /** Encabezado bajo el que se agrupa (los que no lo llevan van sueltos arriba). */
  group?: string;
}

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/**
 * Barra lateral: ícono + nombre cuando está expandida. Contraída (solo íconos) muestra el nombre de la
 * sección junto al cursor (o al enfocar con teclado). El aviso es `position: fixed` para que el scroll
 * de la barra no lo recorte.
 */
export function SideNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [tip, setTip] = useState<{ label: string; y: number } | null>(null);

  function show(label: string, el: HTMLElement) {
    // Solo hace falta cuando los nombres están ocultos.
    if (document.documentElement.dataset.sidebar !== "collapsed") return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ label, y: r.top + r.height / 2 });
  }

  return (
    <nav className="side-nav" aria-label="Principal" onScroll={() => setTip(null)}>
      {items.map((item, i) => (
        <span key={item.href} className="side-item">
          {item.group && item.group !== items[i - 1]?.group && (
            <>
              <hr className="side-sep" />
              <div className="side-group">{item.group}</div>
            </>
          )}
          <Link
            href={item.href}
            className={isActive(pathname, item.href) ? "active" : undefined}
            aria-label={item.label}
            aria-current={isActive(pathname, item.href) ? "page" : undefined}
            onMouseEnter={(e) => show(item.label, e.currentTarget)}
            onFocus={(e) => show(item.label, e.currentTarget)}
            onMouseLeave={() => setTip(null)}
            onBlur={() => setTip(null)}
          >
            <Icon name={item.icon} />
            <span className="side-label">{item.label}</span>
            {item.badge ? <b className="badge">{item.badge > 99 ? "99+" : item.badge}</b> : null}
          </Link>
        </span>
      ))}
      {tip && (
        <div className="side-tip" role="tooltip" style={{ top: tip.y }}>
          {tip.label}
        </div>
      )}
    </nav>
  );
}

/** Título de la sección actual, en la cabecera. */
export function PageTitle({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const current = items.find((i) => isActive(pathname, i.href));
  return <h2 className="top-title">{current?.label ?? "Optuz CRM"}</h2>;
}
