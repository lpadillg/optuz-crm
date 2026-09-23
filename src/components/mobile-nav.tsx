"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { Icon } from "@/components/icons";
import type { NavItem } from "@/components/nav-links";

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** Lo que se usa a diario desde el celular; el resto vive en «Más». */
const PRIMARY = ["/inbox", "/citas", "/leads"];

/**
 * Navegación del celular: barra fija abajo, como cualquier app. Antes la barra iba arriba en horizontal
 * y se cortaba a media palabra, sin ninguna señal de que hubiera más secciones.
 */
export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const more = useRef<HTMLDialogElement>(null);
  const primary = PRIMARY.map((href) => items.find((i) => i.href === href)).filter((i): i is NavItem => Boolean(i));
  const rest = items.filter((i) => !PRIMARY.includes(i.href));
  const restActive = rest.some((i) => isActive(pathname, i.href));

  return (
    <>
      <nav className="mobile-nav" aria-label="Secciones">
        {primary.map((item) => (
          <Link key={item.href} href={item.href} className={isActive(pathname, item.href) ? "active" : undefined} aria-current={isActive(pathname, item.href) ? "page" : undefined}>
            <span className="mn-ico">
              <Icon name={item.icon} size={20} />
              {item.badge ? <b className="badge">{item.badge > 9 ? "9+" : item.badge}</b> : null}
            </span>
            {item.label}
          </Link>
        ))}
        <button type="button" className={restActive ? "active" : undefined} onClick={() => more.current?.showModal()} aria-haspopup="dialog">
          <span className="mn-ico">
            <Icon name="menu" size={20} />
          </span>
          Más
        </button>
      </nav>

      <dialog
        ref={more}
        className="dialog more-sheet"
        aria-label="Más secciones"
        onClick={(e) => {
          if (e.target === more.current) more.current?.close();
        }}
      >
        <div className="dialog-head">
          <h2>Más secciones</h2>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={() => more.current?.close()}>
            ✕
          </button>
        </div>
        <div className="more-grid">
          {rest.map((item) => (
            <Link key={item.href} href={item.href} onClick={() => more.current?.close()} className={isActive(pathname, item.href) ? "active" : undefined}>
              <Icon name={item.icon} size={18} />
              {item.label}
            </Link>
          ))}
        </div>
      </dialog>
    </>
  );
}
