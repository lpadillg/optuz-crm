-- ── El tablero pasa a medir una sola cosa: llegar a la cita ──────────────
--
-- Antes: nuevo · contactado · cita_agendada · atendido · perdido. «Contactado» se ponía solo en cuanto el bot
-- respondía, así que todo el mundo acababa ahí y el tablero no decía nada; «atendido» y «perdido» eran manuales
-- y nadie los movía.
--
-- Ahora, cuatro etapas que se deducen de hechos, sin que nadie clasifique a mano:
--   nuevo         escribió y aún no hay conversación de ida y vuelta
--   seguimiento   conversación viva
--   sin_respuesta el último mensaje es nuestro y el cliente lleva 24 h sin contestar
--   cita_agendada tiene una cita por delante  ← el objetivo del canal
--
-- Lo que pasa DESPUÉS de la cita (vino o no vino) vive en Citas, no aquí: el embudo ya cumplió.
-- Lo que no pertenece al embudo (proveedores, equivocados, los que dijeron que no) se archiva y sale del tablero.

create type lead_stage as enum ('nuevo', 'seguimiento', 'sin_respuesta', 'cita_agendada');

alter table leads
  add column stage lead_stage not null default 'nuevo',
  -- Fuera del tablero. `archive_reason` decide si vuelve solo cuando el cliente escribe de nuevo.
  add column archived_at timestamptz,
  add column archive_reason text check (archive_reason in ('no_interesa', 'no_es_cliente', 'inactivo', 'atendido')),
  -- Atribución: `ad_id` es el anuncio con el que llegó la PRIMERA vez; este es el de la última vez que volvió.
  -- Sin esto, una campaña nueva que reactiva clientes viejos no se lleva ningún crédito.
  add column last_ad_id text,
  add column last_ad_at timestamptz,
  -- Para saludarlo como lo que es: alguien que regresa.
  add column returned_at timestamptz;

-- Traducción de lo que ya existe.
update leads set stage = case
  when status = 'cita_agendada' then 'cita_agendada'::lead_stage
  when status = 'nuevo' then 'nuevo'::lead_stage
  else 'seguimiento'::lead_stage
end;

-- Los que ya estaban fuera del embudo salen del tablero, con su motivo.
update leads set archived_at = now(), archive_reason = 'atendido' where status = 'atendido';
update leads set archived_at = now(), archive_reason = 'no_interesa' where status = 'perdido';

-- `status` se conserva por ahora (lo leen exportaciones y vistas antiguas); el tablero usa `stage`.
create index leads_stage_idx on leads (stage, updated_at desc);
create index leads_archived_idx on leads (archived_at) where archived_at is not null;

-- ── El cliente escribe: el chat vuelve a estar vivo ──────────────────────
create function leads_on_inbound_message() returns trigger
language plpgsql as $$
declare v_lead uuid; v_stage lead_stage; v_reason text; v_archived timestamptz; v_last timestamptz;
begin
  if new.direction <> 'in' then return new; end if;

  select l.id, l.stage, l.archive_reason, l.archived_at, c.last_message_at
    into v_lead, v_stage, v_reason, v_archived, v_last
    from conversations c join leads l on l.id = c.lead_id
   where c.id = new.conversation_id;
  if v_lead is null then return new; end if;

  -- Volvió tras un silencio largo: se anota para tratarlo como quien regresa (y para avisar al agente).
  if v_last is not null and new.created_at - v_last > interval '7 days' then
    update leads set returned_at = new.created_at where id = v_lead;
  end if;

  -- Tener cita por delante manda sobre todo: escribir no borra que ya la tiene.
  if v_stage <> 'cita_agendada' then
    update leads set stage = 'seguimiento' where id = v_lead;
  end if;

  -- Vuelve al tablero salvo que se archivara por no ser un cliente (proveedor, spam, equivocado).
  if v_archived is not null and coalesce(v_reason, '') <> 'no_es_cliente' then
    update leads set archived_at = null, archive_reason = null where id = v_lead;
  end if;
  return new;
end $$;
create trigger messages_lead_stage after insert on messages
  for each row execute function leads_on_inbound_message();

grant execute on function leads_on_inbound_message() to service_role;
