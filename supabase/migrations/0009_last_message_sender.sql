-- La bandeja no distinguía un chat donde el cliente escribió lo último de uno que ya respondimos.
-- Se guarda quién envió el último mensaje, igual que ya se guardaba su texto y su hora.
alter table conversations add column last_message_sender message_sender;

create or replace function sync_conversation_last_message() returns trigger
language plpgsql as $$
begin
  update conversations
     set last_message_at = new.created_at,
         last_message_preview = left(coalesce(nullif(new.content, ''), '📎 Archivo adjunto'), 120),
         last_message_sender = new.sender
   where id = new.conversation_id;
  return new;
end $$;

-- Las conversaciones que ya existen: se toma el remitente de su último mensaje.
update conversations c
   set last_message_sender = m.sender
  from (
    select distinct on (conversation_id) conversation_id, sender
      from messages
     order by conversation_id, created_at desc
  ) m
 where m.conversation_id = c.id;
