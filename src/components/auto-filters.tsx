"use client";
import { useRef, type ReactNode } from "react";

/**
 * Filtros que se aplican al elegir, sin botón «Filtrar». El formulario sigue siendo normal (GET), así que
 * funciona igual sin JavaScript: en ese caso el botón de reserva queda visible.
 */
export function AutoFilters({ children, action }: { children: ReactNode; action?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <form
      ref={form}
      className="filters"
      method="get"
      action={action}
      role="search"
      onChange={(e) => {
        // Los desplegables se aplican al momento; al escribir se espera a que pares.
        const target = e.target as HTMLElement;
        if (timer.current) clearTimeout(timer.current);
        const wait = target.tagName === "SELECT" ? 0 : 450;
        timer.current = setTimeout(() => form.current?.requestSubmit(), wait);
      }}
    >
      {children}
      {/* Sin JavaScript este botón es la única forma de enviar; con JavaScript sobra y se oculta. */}
      <noscript>
        <button type="submit">Filtrar</button>
      </noscript>
    </form>
  );
}
