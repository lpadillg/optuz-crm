-- ── De dónde viene cada cliente ─────────────────────────────────────────
-- `source` solo distinguía 'ctwa' (llegó por un anuncio de Click-to-WhatsApp) de 'otro', así que todo lo demás
-- caía en el mismo saco: los que ven una publicación sin pagar, los clientes antiguos que nunca agendaron y los
-- que llegan recomendados. Sin separarlos no se puede saber qué traer clientes de verdad.
create type lead_origin as enum ('anuncio', 'redes_organico', 'cliente_antiguo', 'recomendado', 'otro');

alter table leads add column origin lead_origin not null default 'otro';

-- Lo que ya se sabe: quien trajo identificador de anuncio vino de un anuncio.
update leads set origin = 'anuncio' where source = 'ctwa' or ad_id is not null;

create index leads_origin_idx on leads (origin);
