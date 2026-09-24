-- ── Los mensajes que escribe el agente, editables desde el panel ─────────
-- Los pasos de la cita los manda el código, y eso los hacía inmutables: cada vez que uno sonaba seco había
-- que pedírselo a un programador y esperar. El tono de cómo le hablas a tus clientes no puede depender de eso.
--
-- Cada mensaje tiene una clave fija (lo que el código pide) y un texto editable con huecos: {{nombre}},
-- {{sucursal}}, {{dia}}, {{hora}}. Si nadie lo ha tocado, se usa el que trae el sistema.
create table agent_messages (
  clave       text primary key,
  texto       text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users (id)
);

comment on table agent_messages is 'Textos que el agente envía en el flujo de la cita. Los edita el negocio desde Agente IA.';
comment on column agent_messages.clave is 'Qué mensaje es (cita:dia, cita:franja…). La pone el código, no se inventa desde el panel.';

alter table agent_messages enable row level security;

-- Cualquiera del equipo los lee (para verlos en el panel); solo un administrador los cambia.
create policy agent_messages_read on agent_messages for select using (true);
create policy agent_messages_write on agent_messages for all using (is_admin()) with check (is_admin());

create trigger agent_messages_updated_at before update on agent_messages
  for each row execute function set_updated_at();
