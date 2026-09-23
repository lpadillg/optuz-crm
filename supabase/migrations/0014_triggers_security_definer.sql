-- ── Los disparadores del sistema no dependen de quién los provoque ───────
-- Marcar un chat como «Requiere humano» desde el panel fallaba con «new row violates row-level security policy
-- for table jobs»: el disparador que programa el resumen y el escalamiento se ejecutaba con los permisos del
-- usuario del panel, y la cola de tareas solo la escribe el servidor. Hasta ahora esa marca solo la ponía el
-- servidor, por eso no había salido.
--
-- Estas funciones son lógica del sistema (programar tareas, asignar, mover etapas del tablero): se ejecutan con
-- los permisos de su dueño, con `search_path` fijo para que nadie pueda suplantar las tablas que usan.

alter function conversations_on_handoff_before() security definer set search_path = public;
alter function conversations_on_handoff_after()  security definer set search_path = public;
alter function messages_on_inbound()             security definer set search_path = public;
alter function leads_on_inbound_message()        security definer set search_path = public;
alter function leads_on_outbound_message()       security definer set search_path = public;
alter function sync_conversation_last_message()  security definer set search_path = public;
