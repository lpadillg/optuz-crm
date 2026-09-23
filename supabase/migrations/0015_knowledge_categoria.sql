-- ── Categoría de cada ficha de conocimiento ─────────────────────────────
-- Con 18 fichas la pantalla era una lista plana e ilegible: no se veía qué temas están cubiertos ni cuáles faltan.
-- Es `text` con una restricción, no un enum: agregar una categoría nueva no debería costar una migración.
alter table knowledge_base
  add column categoria text not null default 'otros'
  check (categoria in ('atencion', 'productos', 'compra', 'tienda', 'otros'));

-- Las fichas ya cargadas, repartidas por su tema (el resto queda en 'otros').
update knowledge_base set categoria = 'atencion'
  where titulo in ('La evaluación visual', 'Qué traer a tu cita', 'Atención a niños', 'Venir sin cita', 'Tu receta y tu historial');
update knowledge_base set categoria = 'productos'
  where titulo in ('Tipos de luna', 'Tratamientos para las lunas', 'Monturas', 'Lentes de contacto', 'Lentes de sol y cambio de lunas', 'Lentes de lectura listos');
update knowledge_base set categoria = 'compra'
  where titulo in ('Formas de pago', 'Entrega de tus lentes', 'Garantía, mantenimiento y cambios', 'Seguros');
update knowledge_base set categoria = 'tienda'
  where titulo in ('Estacionamiento y envíos', 'Campañas y visitas a empresas', 'Redes sociales');
