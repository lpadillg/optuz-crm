import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Optuz CRM",
  description: "CRM sobre WhatsApp con agente IA para las sucursales de Optuz",
};

// Aplica la preferencia de paneles (barra lateral contraída) ANTES del primer pintado,
// para que al recargar no haya un parpadeo con el diseño por defecto. La clave la escribe PanelToggle.
const PANEL_PREFS = `try{var d=document.documentElement,s=localStorage;if(s.getItem("optuz:sidebar-collapsed")==="1")d.dataset.sidebar="collapsed";}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: el script de arriba cambia atributos de <html> antes de que React hidrate.
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PANEL_PREFS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
