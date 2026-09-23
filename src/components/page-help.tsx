import type { ReactNode } from "react";

/**
 * Encabezado de pantalla: una línea corta siempre visible y, si hace falta, el detalle plegado.
 * Antes cada pantalla abría con tres o cuatro líneas de manual que se leen una vez y luego estorban siempre.
 */
export function PageHelp({ children, more }: { children: ReactNode; more?: ReactNode }) {
  return (
    <div className="page-help">
      <p className="page-intro">{children}</p>
      {more && (
        <details className="help-more">
          <summary>¿Cómo funciona?</summary>
          <div className="help-body">{more}</div>
        </details>
      )}
    </div>
  );
}
