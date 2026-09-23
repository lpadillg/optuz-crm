-- ── Varias citas en el mismo horario ────────────────────────────────────
-- En cada sede atienden dos o tres personas a la vez, así que un horario no es un sí/no: son cupos.
-- Hasta ahora el índice único impedía por completo la segunda cita de las 3:00 pm, aunque hubiera
-- especialista libre, y se mandaba al cliente a otra hora sin necesidad.
--
-- `cupo` es el asiento que ocupa la cita dentro de su horario (0, 1, 2…). No significa "qué especialista
-- atiende": es solo el mecanismo que garantiza, a nivel de base de datos, que no se pase del tope aunque
-- dos conversaciones pidan la misma hora en el mismo instante. Quién atiende a quién lo decide la tienda.
alter table appointments add column cupo smallint not null default 0 check (cupo >= 0);

comment on column appointments.cupo is 'Asiento dentro del horario (0..capacidad-1). Solo sirve para que el índice único limite cuántas citas caben a la misma hora.';

drop index appointments_no_double_booking;

create unique index appointments_no_double_booking
  on appointments (branch_id, scheduled_at, cupo)
  where status in ('agendada', 'confirmada');
