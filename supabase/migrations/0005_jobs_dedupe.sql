-- La clave de deduplicación solo aplica a tareas PENDIENTES: si el agente está trabajando (running) y llega un mensaje
-- nuevo, debe poder encolarse otra tarea para él (antes se perdía). Los recordatorios siguen sin duplicarse.
drop index if exists jobs_live_dedupe;
create unique index jobs_live_dedupe on jobs (dedupe_key) where dedupe_key is not null and status = 'pending';
