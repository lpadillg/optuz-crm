import type { ReactNode } from "react";

// Íconos de línea (24×24) propios, sin dependencias.
// Sin anotar como Record<string, …>: así `IconName` es la lista real y un nombre inventado no compila.
const PATHS = {
  dashboard: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  inbox: (
    <>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.5-4.6A8 8 0 1 1 21 12Z" />
    </>
  ),
  pipeline: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="9.5" y="4" width="5" height="10" rx="1.5" />
      <rect x="16" y="4" width="5" height="13" rx="1.5" />
    </>
  ),
  contactos: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20" />
    </>
  ),
  citas: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  promociones: (
    <>
      <path d="M3 12V4h8l10 10-8 8L3 12Z" />
      <circle cx="7.5" cy="8.5" r="1.2" />
    </>
  ),
  respuestas: (
    <>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </>
  ),
  conocimiento: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" />
      <path d="M8 7h7M8 11h7" />
    </>
  ),
  sucursales: (
    <>
      <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  equipo: (
    <>
      <path d="M12 3 4 6v6c0 4.5 3.3 7.8 8 9 4.7-1.2 8-4.5 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  tendencia: (
    <>
      <path d="m3 16 5.5-5.5 4 4L21 6" />
      <path d="M15 6h6v6" />
    </>
  ),
  chequeo: (
    <>
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8A8.5 8.5 0 1 1 12.5 3a8.4 8.4 0 0 1 3.8.9" />
      <path d="m9 11 3 3 9-9" />
    </>
  ),
  nuevo: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  enviar: (
    <>
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4 19-6.5Z" />
    </>
  ),
  reloj: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  archivar: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
    </>
  ),
  "panel-cerrar": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  "panel-abrir": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16M18.5 9l-2 3 2 3" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </>
  ),
  campana: (
    <>
      <path d="M6 9a6 6 0 1 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9Z" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  buscar: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4-4" />
    </>
  ),
  mas: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  tablero: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="10" rx="1.5" />
      <rect x="17" y="4" width="4" height="13" rx="1.5" />
    </>
  ),
  lista: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  usuario: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  pausa: (
    <>
      <path d="M9 5v14M15 5v14" />
    </>
  ),
  play: (
    <>
      <path d="M7 4.5v15l13-7.5-13-7.5Z" />
    </>
  ),
  agente: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </>
  ),
  salir: (
    <>
      <path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
