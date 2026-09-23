-- ── Los que no vinieron, a la vista ─────────────────────────────────────
-- Hasta ahora, marcar «faltó» dejaba al cliente donde estuviera: la cita ya había ocurrido y el tablero daba
-- por cumplido su trabajo. En la práctica esa gente se perdía — nadie volvía a escribirle —, y es la más fácil
-- de recuperar: ya quiso venir y ya eligió sucursal. Ahora cae en su propia columna del tablero.
alter type lead_stage add value if not exists 'no_asistio';
