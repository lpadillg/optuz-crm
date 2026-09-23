-- ── «Nuevo» = nunca le hemos respondido ─────────────────────────────────
-- Antes, el primer mensaje del cliente mandaba la tarjeta directo a «En seguimiento», así que «Nuevo» estaba
-- siempre vacía, incluso con el agente apagado. Ahora:
--   · Un cliente que escribe y al que nadie ha respondido NUNCA se queda en «Nuevo».
--   · En cuanto sale la primera respuesta (del bot o de una persona) pasa a «En seguimiento» y ya no vuelve.
-- Con el agente encendido la tarjeta pasa por «Nuevo» unos segundos; apagado, ahí se acumula la gente por atender.

create or replace function leads_on_inbound_message() returns trigger
language plpgsql as $$
declare v_lead uuid; v_stage lead_stage; v_reason text; v_archived timestamptz; v_last timestamptz; v_answered boolean;
begin
  if new.direction <> 'in' then return new; end if;

  select l.id, l.stage, l.archive_reason, l.archived_at, c.last_message_at
    into v_lead, v_stage, v_reason, v_archived, v_last
    from conversations c join leads l on l.id = c.lead_id
   where c.id = new.conversation_id;
  if v_lead is null then return new; end if;

  -- Volvió tras un silencio largo: se anota para tratarlo como quien regresa.
  if v_last is not null and new.created_at - v_last > interval '7 days' then
    update leads set returned_at = new.created_at where id = v_lead;
  end if;

  -- ¿Le hemos respondido alguna vez? Si no, sigue siendo «Nuevo».
  select exists (select 1 from messages where conversation_id = new.conversation_id and direction = 'out') into v_answered;

  -- Tener cita por delante manda sobre todo: escribir no borra que ya la tiene.
  if v_stage <> 'cita_agendada' then
    update leads set stage = case when v_answered then 'seguimiento'::lead_stage else 'nuevo'::lead_stage end
     where id = v_lead;
  end if;

  -- Vuelve al tablero salvo que se archivara por no ser un cliente (proveedor, spam, equivocado).
  if v_archived is not null and coalesce(v_reason, '') <> 'no_es_cliente' then
    update leads set archived_at = null, archive_reason = null where id = v_lead;
  end if;
  return new;
end $$;

-- La primera respuesta (del bot o de una persona) lo saca de «Nuevo».
create function leads_on_outbound_message() returns trigger
language plpgsql as $$
begin
  if new.direction <> 'out' then return new; end if;
  update leads l set stage = 'seguimiento'
    from conversations c
   where c.id = new.conversation_id and l.id = c.lead_id and l.stage = 'nuevo';
  return new;
end $$;
create trigger messages_lead_answered after insert on messages
  for each row execute function leads_on_outbound_message();

-- Lo que ya existe, con la regla nueva.
update leads l set stage = 'seguimiento'
 where l.stage = 'nuevo'
   and exists (select 1 from conversations c join messages m on m.conversation_id = c.id
                where c.lead_id = l.id and m.direction = 'out');
update leads l set stage = 'nuevo'
 where l.stage = 'seguimiento'
   and exists (select 1 from conversations c where c.lead_id = l.id)
   and not exists (select 1 from conversations c join messages m on m.conversation_id = c.id
                    where c.lead_id = l.id and m.direction = 'out');
