import type { ReactNode } from "react";
import { AlertCenter } from "@/components/alert-center";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { Icon } from "@/components/icons";
import { GlobalSearch } from "@/components/global-search";
import { LogoutButton } from "@/components/logout-button";
import { MobileNav } from "@/components/mobile-nav";
import { PageTitle, SideNav, type NavItem } from "@/components/nav-links";
import { PanelToggle } from "@/components/panel-toggle";
import { requireUser } from "@/lib/session";
import { getAgentSwitch } from "@/lib/settings";

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const { supabase, profile } = await requireUser();

  // Aviso en el ícono del inbox: conversaciones que esperan a una persona (RLS: solo las de su sucursal).
  const { data: waitingRows } = await supabase.from("conversations").select("id, escalated_at").eq("requires_human", true);
  const waiting = waitingRows?.length ?? 0;
  const agent = await getAgentSwitch();

  const items: NavItem[] = [
    { href: "/dashboard", label: "Resumen", icon: "dashboard" },
    { href: "/inbox", label: "Inbox", icon: "inbox", badge: waiting ?? 0 },
    { href: "/pipeline", label: "Tablero de leads", icon: "pipeline" },
    { href: "/leads", label: "Contactos", icon: "contactos" },
    { href: "/citas", label: "Citas", icon: "citas" },
    { href: "/promociones", label: "Promociones", icon: "promociones" },
    ...(profile.role === "admin"
      ? ([
          // Todo lo que decide cómo se comporta el agente vive junto: apagarlo y lo que sabe.
          { href: "/agente", label: "Agente IA", icon: "agente", admin: true, group: "Agente IA" },
          { href: "/conocimiento", label: "Conocimiento", icon: "conocimiento", admin: true, group: "Agente IA" },
          { href: "/respuestas", label: "Respuestas", icon: "respuestas", admin: true, group: "Administración" },
          { href: "/sucursales", label: "Sucursales", icon: "sucursales", admin: true, group: "Administración" },
          { href: "/equipo", label: "Equipo", icon: "equipo", admin: true, group: "Administración" },
          { href: "/anuncios", label: "Anuncios", icon: "tendencia", admin: true, group: "Administración" },
          { href: "/plantillas", label: "Plantillas", icon: "respuestas", admin: true, group: "Administración" },
          { href: "/sistema", label: "Sistema", icon: "chequeo", admin: true, group: "Administración" },
        ] satisfies NavItem[])
      : []),
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            O
          </span>
          <span className="brand-name">Optuz CRM</span>
        </div>
        <SideNav items={items} />
      </aside>
      <div className="main">
        <header className="topbar">
          <PanelToggle />
          <PageTitle items={items} />
          <span className="spacer" />
          <GlobalSearch />
          <AlertCenter
            userId={profile.id}
            role={profile.role}
            waitingIds={(waitingRows ?? []).map((r) => r.id as string)}
            escalatedIds={(waitingRows ?? []).filter((r) => r.escalated_at).map((r) => r.id as string)}
          />
          <div className="user-chip">
            <Avatar name={profile.nombre} />
            <span className="user-meta">
              <strong>{profile.nombre}</strong>
              <span className="muted">{profile.role === "admin" ? "Administrador" : "Asesor"}</span>
            </span>
          </div>
          <LogoutButton />
        </header>
        {!agent.enabled && (
          <p className="agent-off" role="status">
            <Icon name="pausa" size={16} />
            <span>
              <strong>El agente está apagado.</strong> No se envía ninguna respuesta automática, ni seguimientos ni recordatorios de cita.
              Los mensajes siguen llegando al inbox: respóndelos tú.
              {agent.pausedBy && <span className="muted"> Lo apagó {agent.pausedBy}.</span>}
              {agent.reason && <span className="muted"> «{agent.reason}»</span>}
            </span>
            {profile.role === "admin" && <Link href="/agente">Encender</Link>}
          </p>
        )}
        <div className="content">{children}</div>
        <MobileNav items={items} />
      </div>
    </div>
  );
}
