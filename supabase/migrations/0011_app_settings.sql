-- ── Interruptor general del agente ──────────────────────────────────────
-- Hasta ahora el bot solo se podía pausar chat por chat (`conversations.bot_active`). Si empieza a responder mal
-- hace falta un corte único para todo el negocio: deja de contestar, de mandar seguimientos y de mandar
-- recordatorios de cita. Los mensajes del cliente siguen llegando al inbox y el equipo responde a mano.
--
-- Una sola fila: `check (id = 1)` impide que se creen ajustes duplicados.
create table app_settings (
  id                 int primary key default 1 check (id = 1),
  agent_enabled      boolean not null default true,
  agent_paused_at    timestamptz,
  agent_paused_by    uuid references users (id) on delete set null,
  agent_pause_reason text,
  updated_at         timestamptz not null default now()
);

insert into app_settings (id) values (1);

alter table app_settings enable row level security;

-- Todo el equipo necesita saber si el agente está apagado (se avisa en el panel); solo el admin lo cambia.
create policy app_settings_read on app_settings for select to authenticated using (true);
create policy app_settings_admin_write on app_settings for update to authenticated
  using (is_admin()) with check (is_admin());

grant all on app_settings to service_role;
grant select, update on app_settings to authenticated;
