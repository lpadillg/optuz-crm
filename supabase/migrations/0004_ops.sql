-- Optuz CRM — Fase 4: operación confiable (cola de trabajos con reintentos, estado de entrega, registro del agente,
-- derivación inteligente), medios, recordatorios/plantillas, anuncios y ciclo de vida de conversaciones.

-- ── Mensajes: estado de entrega, metadatos y valoración ──────────────────
alter table messages
  add column delivery_status     text check (delivery_status in ('sent', 'delivered', 'read', 'failed')),
  add column delivery_updated_at timestamptz,
  add column meta                jsonb not null default '{}',   -- origen: {"kind":"reminder","appointment_id":…}, {"kind":"followup"}…
  add column feedback            smallint check (feedback in (-1, 1)),  -- 👍 / 👎 de un asesor sobre una respuesta del bot
  add column feedback_note       text;

-- ── Conversaciones: resumen de derivación, escalamiento, resuelta, seguimiento ──
alter table conversations
  add column handoff_summary  text,
  add column escalated_at     timestamptz,   -- nadie la atendió a tiempo tras derivarse
  add column resolved_at      timestamptz,   -- marcada como resuelta; un mensaje nuevo del cliente la reabre
  add column followup_sent_at timestamptz;   -- ya se le hizo el único seguimiento

-- ── Cola de trabajos (con reintentos) ────────────────────────────────────
-- Todo lo que no debe perderse ni bloquear el webhook: responder con el agente, descargar medios, recordatorios,
-- seguimientos, escalamientos, eventos hacia Meta… Se procesan con claim_jobs() (FOR UPDATE SKIP LOCKED).
create type job_status as enum ('pending', 'running', 'done', 'failed');
create table jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  payload       jsonb not null default '{}',
  run_at        timestamptz not null default now(),
  status        job_status not null default 'pending',
  attempts      int not null default 0,
  max_attempts  int not null default 3,
  last_error    text,
  locked_at     timestamptz,
  dedupe_key    text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
-- Una sola tarea viva por clave (p. ej. "agent:<conversación>"): permite agrupar mensajes seguidos y no duplicar recordatorios.
create unique index jobs_live_dedupe on jobs (dedupe_key) where dedupe_key is not null and status in ('pending', 'running');
create index jobs_due_idx on jobs (run_at) where status = 'pending';
create index jobs_status_idx on jobs (status, created_at desc);

create function claim_jobs(p_limit int) returns setof jobs
language plpgsql as $$
begin
  return query
  with due as (
    select id from jobs
    where (status = 'pending' and run_at <= now())
       or (status = 'running' and locked_at < now() - interval '5 minutes') -- trabajador caído: se retoma
    order by run_at
    limit p_limit
    for update skip locked
  )
  update jobs j
     set status = 'running', locked_at = now(), attempts = j.attempts + 1
    from due
   where j.id = due.id
  returning j.*;
end $$;

-- ── Registro de cada corrida del agente ──────────────────────────────────
create table agent_runs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations (id) on delete cascade,
  lead_id          uuid references leads (id) on delete set null,
  message_id       uuid,                 -- mensaje del cliente que la originó
  model            text,
  outcome          text not null,        -- reply | refusal | skipped | error
  detail           text,                 -- motivo del skip o texto del error
  duration_ms      int,
  input_tokens     int,
  output_tokens    int,
  tool_calls       jsonb not null default '[]',  -- [{name, ms, ok}]
  created_at       timestamptz not null default now()
);
create index agent_runs_created_idx on agent_runs (created_at desc);
create index agent_runs_conv_idx on agent_runs (conversation_id, created_at desc);

-- ── Derivación: asignar a un vendedor de la sucursal y programar el escalamiento ──
-- Se hace en la base para que valga sea cual sea el camino que marque «requiere humano» (agente, webhook, panel).
create function conversations_on_handoff_before() returns trigger
language plpgsql as $$
declare v uuid;
begin
  if new.requires_human and not old.requires_human then
    new.escalated_at := null;
    if new.assigned_to is null then
      -- El vendedor de la sucursal con menos chats pendientes (rotación); si empatan, al azar.
      select u.id into v
        from users u join leads l on l.id = new.lead_id
       where u.role = 'vendedor' and u.branch_id = l.branch_id
       order by (select count(*) from conversations c where c.assigned_to = u.id and c.requires_human), random()
       limit 1;
      new.assigned_to := v;
    end if;
  end if;
  return new;
end $$;
create trigger conversations_handoff_before before update on conversations
  for each row execute function conversations_on_handoff_before();

create function conversations_on_handoff_after() returns trigger
language plpgsql as $$
begin
  if new.requires_human and not old.requires_human then
    insert into jobs (kind, payload, dedupe_key, max_attempts)
      values ('handoff_summary', jsonb_build_object('conversationId', new.id), 'summary:' || new.id, 2)
      on conflict do nothing;
    insert into jobs (kind, payload, run_at, dedupe_key, max_attempts)
      values ('escalation', jsonb_build_object('conversationId', new.id), now() + interval '15 minutes', 'escalation:' || new.id, 2)
      on conflict do nothing;
  end if;
  return new;
end $$;
create trigger conversations_handoff_after after update on conversations
  for each row execute function conversations_on_handoff_after();

-- Un mensaje NUEVO del cliente reabre la conversación resuelta y cancela el seguimiento pendiente.
create function messages_on_inbound() returns trigger
language plpgsql as $$
begin
  if new.direction = 'in' then
    update conversations set resolved_at = null where id = new.conversation_id and resolved_at is not null;
    delete from jobs where dedupe_key = 'followup:' || new.conversation_id and status = 'pending';
  end if;
  return new;
end $$;
create trigger messages_inbound after insert on messages
  for each row execute function messages_on_inbound();

-- ── Citas: recordatorios y confirmación ──────────────────────────────────
alter table appointments
  add column reminder_24h_sent_at timestamptz,
  add column reminder_2h_sent_at  timestamptz,
  add column confirmed_at         timestamptz,
  add column capi_sent_at         timestamptz;  -- evento de conversión ya enviado a Meta

-- ── Plantillas de WhatsApp (espejo de las que hay en Meta) ───────────────
create table message_templates (
  name        text primary key,
  language    text not null default 'es',
  category    text not null,
  status      text not null default 'PENDING',   -- APPROVED | PENDING | REJECTED | PAUSED …
  body        text not null,
  components  jsonb not null default '[]',
  meta_id     text,
  reason      text,                              -- motivo de rechazo, si lo hay
  synced_at   timestamptz not null default now()
);

-- ── Gasto en anuncios (para costo por lead / por cita) ───────────────────
create table ad_spend (
  ad_id       text primary key,
  amount      numeric(12, 2) not null check (amount >= 0),
  currency    text not null default 'PEN',
  note        text,
  updated_at  timestamptz not null default now()
);
create index leads_ad_idx on leads (ad_id) where ad_id is not null;

-- ── Fusionar dos contactos (el mismo cliente con dos identidades) ────────
-- Mueve mensajes, notas, citas y consentimientos del contacto `p_source` al `p_target` y elimina el sobrante.
create function merge_leads(p_target uuid, p_source uuid) returns void
language plpgsql as $$
declare
  t_conv uuid; s_conv uuid;
  s leads%rowtype;
begin
  if p_target = p_source then raise exception 'No se puede fusionar un contacto consigo mismo'; end if;
  select * into s from leads where id = p_source;
  if not found then raise exception 'El contacto origen no existe'; end if;
  perform 1 from leads where id = p_target;
  if not found then raise exception 'El contacto destino no existe'; end if;

  select id into t_conv from conversations where lead_id = p_target;
  select id into s_conv from conversations where lead_id = p_source;

  if s_conv is not null then
    if t_conv is null then
      update conversations set lead_id = p_target where id = s_conv;
    else
      update messages set conversation_id = t_conv where conversation_id = s_conv;
      update conversation_notes set conversation_id = t_conv where conversation_id = s_conv;
      update agent_runs set conversation_id = t_conv where conversation_id = s_conv;
      delete from conversations where id = s_conv;
    end if;
  end if;

  update appointments set lead_id = p_target where lead_id = p_source;
  update consent_log set lead_id = p_target where lead_id = p_source;

  -- Se liberan los identificadores únicos del origen para poder copiarlos al destino.
  update leads set phone = null, bsuid = null where id = p_source;
  update leads t set
    phone = coalesce(t.phone, s.phone),
    bsuid = coalesce(t.bsuid, s.bsuid),
    nombre = coalesce(t.nombre, s.nombre),
    email = coalesce(t.email, s.email),
    branch_id = coalesce(t.branch_id, s.branch_id),
    ad_id = coalesce(t.ad_id, s.ad_id),
    ctwa_clid = coalesce(t.ctwa_clid, s.ctwa_clid),
    tags = (select coalesce(array_agg(distinct x), '{}') from unnest(t.tags || s.tags) x),
    notes = nullif(concat_ws(E'\n---\n', t.notes, s.notes), ''),
    opt_out = t.opt_out or s.opt_out,
    promo_consent = t.promo_consent and s.promo_consent
  where t.id = p_target;
  delete from leads where id = p_source;
end $$;

-- ── Medios de los chats (imágenes, notas de voz, documentos): almacenamiento privado ──
insert into storage.buckets (id, name, public) values ('chat-media', 'chat-media', false) on conflict (id) do nothing;

-- ── RLS y permisos ───────────────────────────────────────────────────────
alter table jobs              enable row level security;   -- sin políticas: solo el servidor
alter table agent_runs        enable row level security;
alter table message_templates enable row level security;
alter table ad_spend          enable row level security;

create policy agent_runs_admin_read on agent_runs for select to authenticated using (is_admin());
create policy templates_read on message_templates for select to authenticated using (is_admin());
create policy ad_spend_admin on ad_spend for all to authenticated using (is_admin()) with check (is_admin());

grant all on jobs, agent_runs, message_templates, ad_spend to service_role;
grant select on agent_runs, message_templates to authenticated;
grant select, insert, update, delete on ad_spend to authenticated;
grant execute on function claim_jobs(int), merge_leads(uuid, uuid) to service_role;
