-- ── Una sola verdad sobre en qué anda cada cliente ──────────────────────
-- Convivían dos sistemas: `leads.status` (manual: nuevo/contactado/cita_agendada/atendido/perdido, de la primera
-- versión) y `leads.stage` (el tablero, que se deduce de hechos). Mostraban cosas distintas del mismo cliente:
-- cambiar el estado en el chat no movía su tarjeta en el tablero. Queda solo la etapa.
alter table leads drop column status;
drop type lead_status;

-- ── Fuera «conversación resuelta» ───────────────────────────────────────
-- Cerrar un chat a mano no aportaba: el cliente vuelve a escribir y se reabre solo, y lo que de verdad ordena la
-- bandeja es quién espera respuesta. La carpeta escondía conversaciones sin que nadie entendiera por qué.
drop trigger messages_inbound on messages;

create or replace function messages_on_inbound() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'in' then
    -- Si el cliente responde, el seguimiento pendiente ya no tiene sentido.
    delete from jobs where dedupe_key = 'followup:' || new.conversation_id and status = 'pending';
  end if;
  return new;
end $$;

create trigger messages_inbound after insert on messages
  for each row execute function messages_on_inbound();

alter table conversations drop column resolved_at;
