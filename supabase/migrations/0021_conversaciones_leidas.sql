-- ── Qué chats están sin leer ─────────────────────────────────────────────
-- En la bandeja todos los chats se veían igual, así que con varios mensajes nuevos no había forma de saber
-- cuáles había visto alguien y cuáles no: había que abrirlos uno a uno y acordarse.
--
-- Se guarda cuándo se abrió por última vez, no un booleano: así un mensaje nuevo vuelve a dejar el chat sin
-- leer sin que nadie tenga que marcar nada. Es una marca del equipo, no de cada persona: son una o dos las
-- que atienden y lo que importa es que el cliente no se quede esperando, no quién lo miró.
alter table conversations add column last_read_at timestamptz;

comment on column conversations.last_read_at is 'Última vez que alguien del equipo abrió este chat. Un mensaje del cliente posterior lo deja «sin leer».';
