"use client";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icons";

/**
 * Buscar contactos desde cualquier pantalla. Antes era un campo fijo en el centro de la cabecera: ocupaba el
 * ancho que le falta al chat, decía «Buscar contactos» aunque estuvieras en Sistema, y se cortaba en pantallas
 * angostas. Ahora es una lupa que abre el buscador encima de la página (también con «/»).
 */
export function GlobalSearch() {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // «/» abre el buscador, salvo que ya estés escribiendo en algún campo.
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !ref.current?.open) {
        e.preventDefault();
        ref.current?.showModal();
        input.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Buscar contactos"
        title="Buscar contactos (/)"
        onClick={() => {
          ref.current?.showModal();
          input.current?.focus();
        }}
      >
        <Icon name="buscar" size={18} />
      </button>
      <dialog
        ref={ref}
        className="dialog search-dialog"
        aria-label="Buscar contactos"
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <form action="/leads" method="get" role="search" className="search-form">
          <Icon name="buscar" size={18} />
          <input ref={input} type="search" name="q" placeholder="Nombre, teléfono o email…" aria-label="Buscar contactos" autoComplete="off" />
          <button type="submit" className="btn-sm">
            Buscar
          </button>
        </form>
        <p className="hint" style={{ margin: "10px 2px 0" }}>
          Busca entre tus contactos. Pulsa <kbd>Esc</kbd> para cerrar.
        </p>
      </dialog>
    </>
  );
}
