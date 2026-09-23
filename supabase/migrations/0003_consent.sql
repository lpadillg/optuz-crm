-- Optuz CRM — Fase 3: consentimientos y derechos sobre los datos (Ley 29733 y su reglamento, DS 016-2024-JUS).
--
-- Dos finalidades distintas, que no se mezclan:
--   · atención     → responder su consulta y agendar su cita. Se pierde con la BAJA (leads.opt_out).
--   · promociones  → marketing. Solo con aceptación EXPLÍCITA (leads.promo_consent); la BAJA también la revoca.
-- Cada cambio deja una fila en consent_log: es la prueba de cuándo, por qué canal y con qué texto se otorgó o revocó.

create type consent_kind    as enum ('atencion', 'promociones');
create type consent_action  as enum ('otorgado', 'revocado');
create type consent_channel as enum ('whatsapp', 'panel', 'sistema');

alter table leads add column promo_consent boolean not null default false;

create table consent_log (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references leads (id) on delete cascade,
  kind           consent_kind not null,
  action         consent_action not null,
  channel        consent_channel not null,
  evidence       text,                                         -- lo que escribió el cliente (o el motivo del equipo)
  wa_message_id  text,                                         -- mensaje de WhatsApp que lo motivó
  actor_id       uuid references users (id) on delete set null, -- persona del equipo, si fue desde el panel
  text_version   text not null default 'v1',                   -- versión del aviso/mensaje que se le mostró
  created_at     timestamptz not null default now()
);
create index consent_log_lead_idx on consent_log (lead_id, created_at desc);

-- Constancia de que una solicitud de eliminación (derecho de cancelación) se atendió, SIN conservar el dato:
-- solo un hash del identificador, para poder demostrar que existió y cuándo se resolvió.
create table deletion_log (
  id            uuid primary key default gen_random_uuid(),
  subject_hash  text not null,                                  -- sha256 del teléfono/BSUID
  motivo        text,
  actor_id      uuid references users (id) on delete set null,
  created_at    timestamptz not null default now()
);

alter table consent_log  enable row level security;
alter table deletion_log enable row level security;

-- Lectura: quien puede ver al lead (su sucursal) o el admin. Escritura: solo el servidor (service role),
-- para que el registro no se pueda alterar desde el navegador.
create policy consent_log_read on consent_log for select to authenticated
  using (is_admin() or exists (
    select 1 from leads l where l.id = consent_log.lead_id and l.branch_id = current_user_branch()
  ));
create policy deletion_log_read on deletion_log for select to authenticated using (is_admin());

grant all on consent_log, deletion_log to service_role;
grant select on consent_log, deletion_log to authenticated;

-- Quien ya estaba dado de baja antes de este registro: se anota su revocación (sin fecha real conocida).
insert into consent_log (lead_id, kind, action, channel, evidence, text_version)
select id, k.kind, 'revocado', 'sistema', 'Baja registrada antes de existir el registro de consentimientos', 'previo'
from leads, (values ('atencion'::consent_kind), ('promociones'::consent_kind)) as k(kind)
where opt_out;
