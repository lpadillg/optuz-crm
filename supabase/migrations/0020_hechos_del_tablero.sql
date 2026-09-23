-- ── Lo que el tablero necesita saber, guardado como hecho ────────────────
-- El tablero calculaba «este lead llegó a ver horarios» leyendo las últimas 3.000 corridas del agente con su
-- JSON de herramientas, en CADA carga de la página. Eso arrastraba megas por visita y, peor, dejaba de
-- funcionar en silencio para los leads más antiguos —justo los de «Sin respuesta», que es donde se usa—
-- en cuanto el historial pasaba de 3.000 filas.
--
-- Es un hecho con fecha: se anota cuando ocurre y se lee directo. Lo mismo con la próxima cita, que además
-- permite ordenar «Cita agendada» por cercanía sin traerse la tabla de citas entera.
alter table leads add column saw_slots_at        timestamptz;
alter table leads add column next_appointment_at timestamptz;

comment on column leads.saw_slots_at is 'Cuándo se le mostraron horarios concretos. Estuvo a un paso de agendar: es quien más conviene recuperar.';
comment on column leads.next_appointment_at is 'Inicio de su próxima cita (agendada o confirmada). Lo mantiene syncStageFromAppointments.';

-- El tablero ordena cada columna por estos campos y pide solo las primeras de cada una.
create index leads_stage_orden_idx on leads (stage, saw_slots_at desc nulls last, updated_at desc) where archived_at is null;
create index leads_next_appointment_idx on leads (next_appointment_at) where next_appointment_at is not null;

-- Rellenar lo que ya ocurrió, para no empezar con el tablero en blanco.
update leads l
   set saw_slots_at = r.ultima
  from (
    select lead_id, max(created_at) as ultima
      from agent_runs
     where lead_id is not null
       and tool_calls @> '[{"name": "get_availability"}]'::jsonb
        or tool_calls @> '[{"name": "next_available_slots"}]'::jsonb
     group by lead_id
  ) r
 where r.lead_id = l.id;

update leads l
   set next_appointment_at = a.proxima
  from (
    select lead_id, min(scheduled_at) as proxima
      from appointments
     where status in ('agendada', 'confirmada')
       and scheduled_at > now()
     group by lead_id
  ) a
 where a.lead_id = l.id;
