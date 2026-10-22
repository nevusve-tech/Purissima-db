-- =====================================================================
-- Purissima Cloud - Migración 004 (tanda 3, primera parte)
--
-- Agrega:
--   1. Subcategorías dentro de "mercancía": bebidas, snacks, artesanales
--      e insumos de agua
--   2. Costos operativos del cierre de caja expresados en dólares
--
-- Es idempotente y ADITIVA: no borra ninguna columna ni ningún dato.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. SUBCATEGORÍAS DE MERCANCÍA
--    La categoría sigue siendo mercancía / insumo de tienda / agua.
--    La subcategoría describe mejor la mercancía y sólo aplica a ella.
-- ---------------------------------------------------------------------
ALTER TABLE productos ADD COLUMN IF NOT EXISTS subcategoria varchar(20);

-- Lo que ya estaba cargado como mercancía queda en "bebidas";
-- se puede cambiar desde la aplicación (Recepción -> tocar el producto).
UPDATE productos SET subcategoria = 'bebidas'
 WHERE categoria = 'mercancia' AND subcategoria IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_productos_subcategoria') THEN
    ALTER TABLE productos ADD CONSTRAINT ck_productos_subcategoria
      CHECK (subcategoria IS NULL
             OR subcategoria IN ('bebidas', 'snacks', 'artesanales', 'insumos_agua'));
  END IF;
  -- Si es mercancía, la subcategoría es obligatoria
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_productos_subcat_mercancia') THEN
    ALTER TABLE productos ADD CONSTRAINT ck_productos_subcat_mercancia
      CHECK (categoria <> 'mercancia' OR subcategoria IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_productos_subcategoria ON productos (subcategoria);

-- ---------------------------------------------------------------------
-- 2. COSTOS OPERATIVOS EN DÓLARES
--
--    Se escriben en dólares. La columna en bolívares se conserva y pasa
--    a guardar el equivalente, calculado como USD x tasa del día, que es
--    lo que se resta para obtener el neto en bolívares.
--
--    "dolares_vendidos" se conserva en la base pero sale del formulario:
--    los cierres nuevos la guardan en 0.
-- ---------------------------------------------------------------------
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS costos_operativos_usd numeric(14,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierre_costos_usd') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierre_costos_usd
      CHECK (costos_operativos_usd >= 0);
  END IF;
END $$;

-- Cierres anteriores: se deduce el equivalente en dólares de lo que ya
-- estaba en bolívares, usando la tasa guardada en ese mismo cierre.
UPDATE cierres_caja
   SET costos_operativos_usd = ROUND(costos_operativos_bs / tasa_dolar, 2)
 WHERE costos_operativos_usd = 0 AND costos_operativos_bs > 0 AND tasa_dolar > 0;

-- ---------------------------------------------------------------------
-- 3. Comprobación
-- ---------------------------------------------------------------------
SELECT id, nombre, categoria, subcategoria, empaquetado, unidades_por_empaquetado
  FROM productos ORDER BY id;
