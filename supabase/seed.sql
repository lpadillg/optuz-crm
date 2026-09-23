-- Datos maestros de las 5 sucursales (docs/optuz-crm-spec.md → "Sucursales y datos maestros").
-- google_calendar_id y meta_campaign_ids se completan cuando existan los calendarios y las campañas.
insert into branches (nombre, direccion) values
  ('Huánuco',     'Jr. 28 de Julio 1131, frente al Ministerio Público'),
  ('Tingo María', 'Av. Tito Jaime 343, costado de FerroHogar'),
  ('Aucayacu',    'Jr. Grau 180, costado de Mifarma'),
  ('Tocache',     'Jr. Freddy Aliaga 754, frente a residencial Bolívar'),
  ('Uchiza',      'Av. Leoncio Prado 615, Plaza de Armas')
on conflict (nombre) do nothing;
