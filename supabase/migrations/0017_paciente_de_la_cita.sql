-- ── A nombre de quién es la cita ────────────────────────────────────────
-- El nombre que da el cliente al agendar se guardaba PISANDO el nombre del contacto: una señora que agendó para
-- su hija dejó su propio WhatsApp registrado con el nombre de la hija. Son dos cosas distintas: quién escribe y
-- quién viene a la cita (un familiar, un hijo, un amigo).
alter table appointments add column paciente text;

comment on column appointments.paciente is 'Nombre de quien viene a la cita, tal como lo dio el cliente. Si es null, viene el propio contacto.';
