-- Equipo simple: este canal es de citas y normalmente lo atienden 1 o 2 personas, no una por sucursal.
-- Un asesor (rol `vendedor`) SIN sucursal atiende TODAS; con sucursal, solo la suya (como antes).

alter table users drop constraint vendedor_requires_branch;

-- Quien ve todas las sucursales: administradores y asesores sin sucursal. (Solo el administrador configura: is_admin() no cambia.)
create function sees_all_branches() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_user_role() = 'admin' or (current_user_role() = 'vendedor' and current_user_branch() is null), false)
$$;
grant execute on function sees_all_branches() to authenticated, service_role;

-- Las políticas de RLS se suman (OR): estas dan al asesor sin sucursal el mismo alcance de lectura/edición que ya tenía por sucursal,
-- pero en todas. No se le da nada que solo tuviera el administrador (borrar, configurar, equipo, sistema).
create policy branches_read_all on branches for select to authenticated using (sees_all_branches());

-- Compañeros: los de mi sucursal (política existente) y los que atienden todas (administradores y asesores sin sucursal).
create policy users_read_all on users for select to authenticated using (sees_all_branches() or branch_id is null);

create policy leads_read_all   on leads for select to authenticated using (sees_all_branches());
create policy leads_update_all on leads for update to authenticated using (sees_all_branches()) with check (sees_all_branches());
create policy leads_insert_all on leads for insert to authenticated with check (sees_all_branches());

create policy conversations_read_all   on conversations for select to authenticated using (sees_all_branches());
create policy conversations_update_all on conversations for update to authenticated using (sees_all_branches()) with check (sees_all_branches());
create policy conversations_insert_all on conversations for insert to authenticated with check (sees_all_branches());

create policy messages_read_all on messages for select to authenticated using (sees_all_branches());

create policy notes_read_all   on conversation_notes for select to authenticated using (sees_all_branches());
create policy notes_insert_all on conversation_notes for insert to authenticated with check (author_id = auth.uid() and sees_all_branches());

create policy appointments_read_all   on appointments for select to authenticated using (sees_all_branches());
create policy appointments_update_all on appointments for update to authenticated using (sees_all_branches()) with check (sees_all_branches());

create policy promotions_read_all on promotions for select to authenticated using (sees_all_branches());

create policy consent_log_read_all on consent_log for select to authenticated using (sees_all_branches());

-- Derivación: se asigna al asesor de la sucursal del cliente si lo hay; si no, a uno que atienda todas.
-- Entre los candidatos gana el que tenga menos chats pendientes (rotación); si empatan, al azar.
create or replace function conversations_on_handoff_before() returns trigger
language plpgsql as $$
declare v uuid;
begin
  if new.requires_human and not old.requires_human then
    new.escalated_at := null;
    if new.assigned_to is null then
      select u.id into v
        from users u join leads l on l.id = new.lead_id
       where u.role = 'vendedor' and (u.branch_id is null or u.branch_id = l.branch_id)
       order by (u.branch_id is null),                       -- primero el de esa sucursal, luego los que atienden todas
                (select count(*) from conversations c where c.assigned_to = u.id and c.requires_human),
                random()
       limit 1;
      new.assigned_to := v;
    end if;
  end if;
  return new;
end $$;
