-- Optuz CRM — Fase 2: funciones de CRM (contactos con etiquetas, asignación, respuestas rápidas, conocimiento del agente).

-- ── Contactos ────────────────────────────────────────────────────────────
alter table leads
  add column email text,
  add column tags  text[] not null default '{}',
  add column notes text;
create index leads_tags_idx on leads using gin (tags);

-- Un asesor puede crear contactos a mano (para su sucursal; el admin, para cualquiera).
create policy leads_insert on leads for insert to authenticated
  with check (is_admin() or branch_id = current_user_branch());
create policy conversations_insert on conversations for insert to authenticated
  with check (is_admin() or exists (
    select 1 from leads l where l.id = conversations.lead_id and l.branch_id = current_user_branch()
  ));

-- ── Asignación de conversaciones ─────────────────────────────────────────
alter table conversations
  add column assigned_to uuid references users (id) on delete set null;
create index conversations_assigned_idx on conversations (assigned_to);

-- ── Respuestas rápidas (plantillas de texto internas para el inbox) ──────
create table quick_replies (
  id         uuid primary key default gen_random_uuid(),
  atajo      text not null unique check (atajo ~ '^[a-z0-9_-]{1,30}$'), -- se escribe "/atajo" en el chat
  titulo     text not null,
  cuerpo     text not null,
  created_at timestamptz not null default now()
);
alter table quick_replies enable row level security;
create policy quick_replies_read on quick_replies for select to authenticated using (true);
create policy quick_replies_admin_write on quick_replies for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── Base de conocimiento del agente (preguntas frecuentes, políticas, servicios) ──
create table knowledge_base (
  id         uuid primary key default gen_random_uuid(),
  titulo     text not null,
  contenido  text not null,
  activa     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger knowledge_base_updated_at before update on knowledge_base
  for each row execute function set_updated_at();
alter table knowledge_base enable row level security;
create policy knowledge_read on knowledge_base for select to authenticated using (true);
create policy knowledge_admin_write on knowledge_base for all to authenticated
  using (is_admin()) with check (is_admin());

-- Las tablas nuevas no heredan los permisos del esquema inicial.
grant all on quick_replies, knowledge_base to service_role;
grant select, insert, update, delete on quick_replies, knowledge_base to authenticated;
