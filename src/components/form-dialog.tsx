"use client";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Botón + diálogo modal para formularios de alta/edición. Usa <dialog>: el navegador ya se encarga del foco,
 * de Esc para cerrar y de bloquear el fondo. Se cierra también al pulsar fuera. El contenido (normalmente un
 * <form action={…}> del servidor) llega como `children`; al enviarse, la acción redirige y la página se recarga.
 */
export function FormDialog({
  trigger,
  title,
  description,
  children,
  triggerClassName = "ghost btn-sm",
  defaultOpen = false,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  triggerClassName?: string;
  /** Abrir al cargar la página (p. ej. desde un enlace «Crear vendedor»). */
  defaultOpen?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (defaultOpen && ref.current && !ref.current.open) ref.current.showModal();
  }, [defaultOpen]);

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => ref.current?.showModal()}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        className="dialog"
        aria-label={title}
        // El clic en el fondo (::backdrop) llega al propio <dialog>, no a su contenido.
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <div className="dialog-head">
          <div>
            <h2>{title}</h2>
            {description && <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{description}</p>}
          </div>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Cerrar" title="Cerrar (Esc)" onClick={() => ref.current?.close()}>
            ✕
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </dialog>
    </>
  );
}
