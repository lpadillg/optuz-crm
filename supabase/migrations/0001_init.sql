-- Optuz CRM — esquema inicial (Fase 1)
-- Ver docs/optuz-crm-spec.md → "Modelo de datos en Supabase".

create extension if not exists pgcrypto;

-- ── Tipos ────────────────────────────────────────────────────────────────
create type user_role        as enum ('admin', 'vendedor');
create type lead_source      as enum ('ctwa', 'otro');
create type lead_status      as enum ('nuevo', 'contactado', 'cita_agendada', 'atendido', 'perdido');
create type message_direction as enum ('in', 'out');
create type message_sender   as enum ('bot', 'humano', 'lead');
create type appointment_status as enum ('agendada', 'confirmada', 'atendida', 'no_show', 'cancelada');
-- Por ahora las citas son solo para examen visual (se amplía con `alter type … add value`).
create type service_type     as enum ('examen_visual');

-- ── updated_at ───────────────────────────────────────────────────────────
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── branches ─────────────────────────────────────────────────────────────
create table branches (
  id                  uuid primary key default gen_random_uuid(),
  nombre              text not null unique,
  direccion           text not null,
  google_calendar_id  text,                       -- un calendario dedicado por sucursal
  meta_campaign_ids   text[] not null default '{}', -- campañas/anuncios Meta que mapean a esta sucursal
  activa              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index branches_meta_campaign_ids_idx on branches using gin (meta_campaign_ids);

-- ── users (personas del panel; 1:1 con auth.users) ───────────────────────
create table users (
  id         uuid primary key references auth.users (id) on delete cascade,
  nombre     text not null,
  email      text not null unique,
  role       user_role not null default 'vendedor',
  branch_id  uuid references branches (id),
  created_at timestamptz not null default now(),
  -- un vendedor siempre pertenece a una sucursal; el admin no
  constraint vendedor_requires_branch check (role = 'admin' or branch_id is not null)
);

-- ── leads ────────────────────────────────────────────────────────────────
create table leads (
  id          uuid primary key default gen_random_uuid(),
  -- Identidad en WhatsApp. Desde 2026 un cliente puede escribir con un "usuario" sin número visible: en ese caso
  -- solo hay BSUID (`user_id` en el webhook de Meta) y el teléfono queda nulo hasta que lo dé (o llegue en otro mensaje).
  phone       text unique,                        -- E.164, ej. +51999999999
  bsuid       text unique,                        -- business-scoped user id de WhatsApp (ISO país + "." + id)
  nombre      text,
  branch_id   uuid references branches (id),      -- null hasta detectar/preguntar la sucursal
  source      lead_source not null default 'otro',
  ad_id       text,                               -- anuncio/campaña Meta que originó el lead
  ctwa_clid   text,
  status      lead_status not null default 'nuevo',
  opt_out     boolean not null default false,     -- Ley 29733: detiene broadcasts, no citas ya agendadas
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lead_has_identity check (phone is not null or bsuid is not null)
);
create index leads_branch_status_idx on leads (branch_id, status);
create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();

-- ── conversations ────────────────────────────────────────────────────────
-- Meta no tiene "conversaciones" con id propio: el hilo de un cliente con el número del negocio es 1 lead = 1 conversación.
create table conversations (
  id                      uuid primary key default gen_random_uuid(),
  lead_id                 uuid not null unique references leads (id) on delete cascade,
  bot_active              boolean not null default true,
  requires_human          boolean not null default false, -- el agente derivó el caso (o falló) y un vendedor debe verlo
  handoff_reason          text,
  last_message_at         timestamptz not null default now(),
  last_message_preview    text not null default '',
  created_at              timestamptz not null default now()
);
create index conversations_last_message_idx on conversations (last_message_at desc);

-- ── messages ─────────────────────────────────────────────────────────────
create table messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations (id) on delete cascade,
  direction           message_direction not null,
  sender              message_sender not null,
  content             text not null default '',
  attachments         jsonb not null default '[]',
  wa_message_id       text unique,                -- id de mensaje de WhatsApp ("wamid…"): idempotencia ante reintentos del webhook
  author_id           uuid references users (id), -- vendedor que escribió (solo sender = 'humano')
  created_at          timestamptz not null default now(),
  -- coherencia: lo entrante siempre es del lead; lo saliente nunca
  constraint direction_sender_consistent check (
    (direction = 'in' and sender = 'lead') or (direction = 'out' and sender <> 'lead')
  )
);
create index messages_conversation_created_idx on messages (conversation_id, created_at);

-- La bandeja ordena y previsualiza por estos campos: se mantienen aquí, sea cual sea quien inserte el mensaje.
create function sync_conversation_last_message() returns trigger
language plpgsql as $$
begin
  update conversations
     set last_message_at = new.created_at,
         last_message_preview = left(coalesce(nullif(new.content, ''), '📎 Archivo adjunto'), 120)
   where id = new.conversation_id;
  return new;
end $$;
create trigger messages_sync_conversation after insert on messages
  for each row execute function sync_conversation_last_message();

-- ── conversation_notes (notas internas, nunca se envían al cliente) ──────
create table conversation_notes (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations (id) on delete cascade,
  author_id        uuid not null references users (id),
  body             text not null,
  created_at       timestamptz not null default now()
);
create index conversation_notes_conversation_idx on conversation_notes (conversation_id, created_at);

-- ── promotions ───────────────────────────────────────────────────────────
create table promotions (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid references branches (id),     -- null = todas las sucursales
  titulo       text not null,
  descripcion  text not null,
  valid_from   timestamptz not null,
  valid_to     timestamptz not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint promotion_valid_range check (valid_to > valid_from)
);
create index promotions_lookup_idx on promotions (branch_id, active, valid_from, valid_to);

-- ── appointments ─────────────────────────────────────────────────────────
create table appointments (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads (id),
  branch_id         uuid not null references branches (id),
  google_event_id   text unique,
  tipo_servicio     service_type not null default 'examen_visual',
  promotion_id      uuid references promotions (id), -- promoción vigente a la que se acoge la cita, si aplica
  scheduled_at      timestamptz not null,
  duration_minutes  int not null default 30 check (duration_minutes > 0),
  status            appointment_status not null default 'agendada',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index appointments_branch_scheduled_idx on appointments (branch_id, scheduled_at);
-- Red de seguridad contra doble reserva si dos conversaciones piden el mismo hueco a la vez.
create unique index appointments_no_double_booking
  on appointments (branch_id, scheduled_at)
  where status in ('agendada', 'confirmada');
create trigger appointments_updated_at before update on appointments
  for each row execute function set_updated_at();

-- ── webhook_events (deduplicación de las entregas de Meta) ───────────────
-- Meta entrega "al menos una vez" y sus webhooks no traen id de evento: la llave es el id del propio
-- mensaje/estado (p. ej. "msg:wamid.…" o "status:wamid.…:failed"). Una entrega puede traer varios.
create table webhook_events (
  event_id      text primary key,
  event_type    text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

-- ── Helpers de RLS ───────────────────────────────────────────────────────
-- security definer para leer public.users sin recursión de políticas.
create function current_user_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from users where id = auth.uid()
$$;

create function current_user_branch() returns uuid
language sql stable security definer set search_path = public as $$
  select branch_id from users where id = auth.uid()
$$;

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_user_role() = 'admin', false)
$$;

-- ── Row Level Security ───────────────────────────────────────────────────
-- El webhook y el agente usan la service role key (bypass de RLS).
-- El panel usa la sesión del usuario: vendedor = su sucursal, admin = todo.
alter table branches            enable row level security;
alter table users               enable row level security;
alter table leads               enable row level security;
alter table conversations       enable row level security;
alter table messages            enable row level security;
alter table conversation_notes  enable row level security;
alter table appointments        enable row level security;
alter table promotions          enable row level security;
alter table webhook_events      enable row level security; -- sin políticas: solo service role

create policy branches_read on branches for select to authenticated
  using (is_admin() or id = current_user_branch());
create policy branches_admin_write on branches for all to authenticated
  using (is_admin()) with check (is_admin());

-- Un vendedor ve a sus compañeros de sucursal (para mostrar quién escribió una nota).
create policy users_read on users for select to authenticated
  using (is_admin() or id = auth.uid() or branch_id = current_user_branch());
create policy users_admin_write on users for all to authenticated
  using (is_admin()) with check (is_admin());

create policy leads_read on leads for select to authenticated
  using (is_admin() or branch_id = current_user_branch());
create policy leads_update on leads for update to authenticated
  using (is_admin() or branch_id = current_user_branch())
  with check (is_admin() or branch_id = current_user_branch());

create policy conversations_read on conversations for select to authenticated
  using (is_admin() or exists (
    select 1 from leads l where l.id = conversations.lead_id and l.branch_id = current_user_branch()
  ));
-- pausar / reactivar el bot desde el inbox
create policy conversations_update on conversations for update to authenticated
  using (is_admin() or exists (
    select 1 from leads l where l.id = conversations.lead_id and l.branch_id = current_user_branch()
  ))
  with check (is_admin() or exists (
    select 1 from leads l where l.id = conversations.lead_id and l.branch_id = current_user_branch()
  ));

-- Los mensajes salientes se insertan desde el servidor (tras enviar por la API de WhatsApp), no desde el cliente.
create policy messages_read on messages for select to authenticated
  using (is_admin() or exists (
    select 1 from conversations c join leads l on l.id = c.lead_id
    where c.id = messages.conversation_id and l.branch_id = current_user_branch()
  ));

create policy notes_read on conversation_notes for select to authenticated
  using (is_admin() or exists (
    select 1 from conversations c join leads l on l.id = c.lead_id
    where c.id = conversation_notes.conversation_id and l.branch_id = current_user_branch()
  ));
create policy notes_insert on conversation_notes for insert to authenticated
  with check (
    author_id = auth.uid() and (is_admin() or exists (
      select 1 from conversations c join leads l on l.id = c.lead_id
      where c.id = conversation_notes.conversation_id and l.branch_id = current_user_branch()
    ))
  );

create policy appointments_read on appointments for select to authenticated
  using (is_admin() or branch_id = current_user_branch());
create policy appointments_update on appointments for update to authenticated
  using (is_admin() or branch_id = current_user_branch())
  with check (is_admin() or branch_id = current_user_branch());

create policy promotions_read on promotions for select to authenticated
  using (is_admin() or branch_id is null or branch_id = current_user_branch());
create policy promotions_admin_write on promotions for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── Permisos ─────────────────────────────────────────────────────────────
-- Explícitos porque los proyectos nuevos de Supabase no siempre los conceden solos.
-- service_role (webhook/agente) salta RLS pero necesita privilegios de tabla; authenticated queda acotado por RLS;
-- anon no recibe nada (el panel exige login).
grant usage on schema public to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated, service_role;

-- ── Realtime: el vendedor ve en vivo lo que hace el bot ──────────────────
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
