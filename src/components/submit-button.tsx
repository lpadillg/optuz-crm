"use client";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/**
 * Botón de envío que se apaga y cambia de texto mientras la acción va en camino.
 *
 * Sin esto, pulsar «Guardar» no cambia nada en pantalla hasta que el servidor termina y la página se recarga:
 * un segundo largo en el que parece que el botón no funciona y la gente vuelve a pulsarlo. `useFormStatus` lo
 * sabe sin que haya que llevar la cuenta a mano, porque lee el estado del <form> que lo contiene.
 */
export function SubmitButton({
  children,
  pendingLabel = "Guardando…",
  className,
}: {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
