-- La página «Sistema» (solo administradores) necesita ver la cola de trabajos. Escribir sigue siendo solo del servidor.
create policy jobs_admin_read on jobs for select to authenticated using (is_admin());
grant select on jobs to authenticated;
