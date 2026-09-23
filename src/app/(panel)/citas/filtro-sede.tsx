"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * Filtro de sucursal de la agenda. Navega al elegir, sin botón de por medio: un «Filtrar» aparte obliga a dos
 * gestos para una decisión que ya está tomada al soltar el desplegable.
 *
 * Es un componente de cliente porque la página es de servidor y el filtro vive en la URL: así el filtro se
 * puede compartir, se mantiene al recargar y el navegador puede volver atrás.
 */
export function FiltroSede({ branches, sede }: { branches: { id: string; nombre: string }[]; sede: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pendiente, empezar] = useTransition();

  function elegir(nombre: string) {
    const next = new URLSearchParams(params);
    if (nombre) next.set("sede", nombre);
    else next.delete("sede");
    const qs = next.toString();
    empezar(() => router.push(qs ? `/citas?${qs}` : "/citas"));
  }

  return (
    <select
      className="filtro-sede"
      value={sede}
      aria-label="Sucursal"
      disabled={pendiente}
      onChange={(e) => elegir(e.target.value)}
    >
      <option value="">Todas las sucursales</option>
      {branches.map((b) => (
        <option key={b.id} value={b.nombre}>
          {b.nombre}
        </option>
      ))}
    </select>
  );
}
