-- ── El borrador de la cita que se está armando ───────────────────────────
-- Hasta ahora, en qué paso iba una cita se deducía leyendo lo que el modelo había escrito: si su texto parecía
-- preguntar la sucursal, es que faltaba la sucursal. Eso obliga a reconocer infinitas formas de decir lo mismo
-- y falla por una tilde o por un signo de interrogación que no está.
--
-- Con el borrador, el paso siguiente sale de un hecho: qué datos hay y cuáles faltan. El código pregunta lo
-- que falta, con botones, y reconoce sus propias opciones al responder el cliente. El modelo se queda con lo
-- que sí hace bien: entender a la gente y responder a todo lo que no es el guion.
--
-- Es un borrador, no una cita: vive mientras se arma y se borra al agendar, al cancelar o al empezar de cero.
alter table conversations add column cita jsonb;

comment on column conversations.cita is
  'Borrador de la cita en curso: { sucursal, fecha, franja, hora, paciente }. Se borra al agendarla o al empezar otra.';
