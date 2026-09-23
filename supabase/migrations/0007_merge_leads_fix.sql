-- Corrige merge_leads: vaciar phone/bsuid del contacto origen violaba lead_has_identity (todo contacto necesita teléfono o bsuid).
-- Ahora se guarda una copia del origen, se mueve todo lo suyo al destino, se elimina el origen (liberando sus identificadores únicos)
-- y recién entonces se completan los datos vacíos del destino con los del origen.
create or replace function merge_leads(p_target uuid, p_source uuid) returns void
language plpgsql as $$
declare
  t_conv uuid; s_conv uuid;
  s leads%rowtype;
begin
  if p_target = p_source then raise exception 'No se puede fusionar un contacto consigo mismo'; end if;
  select * into s from leads where id = p_source;
  if not found then raise exception 'El contacto origen no existe'; end if;
  perform 1 from leads where id = p_target;
  if not found then raise exception 'El contacto destino no existe'; end if;

  select id into t_conv from conversations where lead_id = p_target;
  select id into s_conv from conversations where lead_id = p_source;

  if s_conv is not null then
    if t_conv is null then
      update conversations set lead_id = p_target where id = s_conv;
    else
      update messages set conversation_id = t_conv where conversation_id = s_conv;
      update conversation_notes set conversation_id = t_conv where conversation_id = s_conv;
      update agent_runs set conversation_id = t_conv where conversation_id = s_conv;
      delete from conversations where id = s_conv;
    end if;
  end if;

  update appointments set lead_id = p_target where lead_id = p_source;
  update consent_log set lead_id = p_target where lead_id = p_source;

  -- Al eliminar el origen quedan libres su teléfono y su bsuid (únicos) para copiarlos al destino.
  delete from leads where id = p_source;

  update leads t set
    phone = coalesce(t.phone, s.phone),
    bsuid = coalesce(t.bsuid, s.bsuid),
    nombre = coalesce(t.nombre, s.nombre),
    email = coalesce(t.email, s.email),
    branch_id = coalesce(t.branch_id, s.branch_id),
    ad_id = coalesce(t.ad_id, s.ad_id),
    ctwa_clid = coalesce(t.ctwa_clid, s.ctwa_clid),
    tags = (select coalesce(array_agg(distinct x), '{}') from unnest(t.tags || s.tags) x),
    notes = nullif(concat_ws(E'\n---\n', t.notes, s.notes), ''),
    opt_out = t.opt_out or s.opt_out,
    promo_consent = t.promo_consent and s.promo_consent
  where t.id = p_target;
end $$;
