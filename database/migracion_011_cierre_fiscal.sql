-- =====================================================================
-- Purissima Cloud - Migración 011: cierre fiscal
--
-- Agrega al cierre de caja los datos que salen de la máquina fiscal al
-- hacer el reporte Z del día:
--
--   Último reporte Z    el número del reporte anterior, tal como lo
--                       imprime la máquina
--   N° Reporte Z        el número del reporte del día, que debe ser el
--                       siguiente del anterior
--   Exento              lo vendido sin IVA (el agua, básicamente)
--   Base imponible 16%  lo vendido gravado, sin el IVA
--   Última factura      el número de la última factura emitida
--
-- El IVA en sí ya estaba: es la columna impuestos_fiscales_bs.
--
-- POR QUÉ ADMITEN NULO
-- Los cierres anteriores a esto no tienen estos datos y no se pueden
-- inventar. Que sean obligatorios en los cierres NUEVOS lo exige la
-- aplicación, no la base: así el histórico sigue siendo válido y lo que
-- entre de ahora en adelante viene completo.
--
-- Es idempotente y ADITIVA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Los datos del reporte Z
--
--    Los dos números del reporte Z son enteros porque avanzan de uno en
--    uno. Se guardan LOS DOS que la cajera copia del papel: el anterior y
--    el del día. El sistema no inventa ninguno; lo que hace es revisar
--    que vengan seguidos y, además, que el anterior que trae el papel sea
--    el mismo que quedó guardado en el cierre pasado. Si algo no coincide
--    avisa, pero no impide guardar: el número que vale es el del papel.
--
--    La base deja pasar el cero; que el reporte sea de 1 en adelante lo
--    exige la aplicación. La lección de la migración 010 es que una regla
--    de negocio metida en un CHECK inutiliza las filas viejas el día que
--    haya que tocarlas. Por lo mismo, que los dos números vengan seguidos
--    NO es un CHECK: es un aviso.
--
--    La última factura va como texto para no perder los ceros de
--    adelante, que las máquinas fiscales suelen imprimir (00010237). Se
--    acota a dígitos para que siga siendo comparable si algún día hace
--    falta.
-- ---------------------------------------------------------------------
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS reporte_z_anterior integer;
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS reporte_z integer;
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS exento_bs numeric(14,2);
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS base_imponible_bs numeric(14,2);
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS ultima_factura varchar(20);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierres_reporte_z') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierres_reporte_z
      CHECK (reporte_z IS NULL OR reporte_z >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierres_reporte_z_anterior') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierres_reporte_z_anterior
      CHECK (reporte_z_anterior IS NULL OR reporte_z_anterior >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierres_exento') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierres_exento
      CHECK (exento_bs IS NULL OR exento_bs >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierres_base_imponible') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierres_base_imponible
      CHECK (base_imponible_bs IS NULL OR base_imponible_bs >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierres_ultima_factura') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierres_ultima_factura
      CHECK (ultima_factura IS NULL OR ultima_factura ~ '^[0-9]{1,20}$');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Para revisar la secuencia de reportes Z
--
--    El aviso de que un reporte Z no sigue al anterior NO se guarda: se
--    calcula comparando los números de cada cierre y los cierres entre
--    sí. Así, si se corrige un número o se anula un cierre, el aviso se
--    corrige o desaparece solo; guardado como registro quedaría
--    señalando un error ya resuelto.
--
--    Este índice es para que ese cálculo sea rápido.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_cierres_reporte_z
  ON cierres_caja (fecha)
  WHERE reporte_z IS NOT NULL AND NOT anulado;

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
-- Deben salir las cinco columnas nuevas
SELECT 'columnas nuevas' AS comprobacion,
       coalesce(string_agg(column_name, ', ' ORDER BY column_name), 'NINGUNA') AS valor,
       count(*) AS cuantas
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'cierres_caja'
   AND column_name IN ('reporte_z_anterior', 'reporte_z', 'exento_bs',
                       'base_imponible_bs', 'ultima_factura');

-- Los cierres que ya existen quedan con estas columnas vacías: es lo esperado
SELECT fecha, total_cierre_bs, impuestos_fiscales_bs,
       reporte_z_anterior, reporte_z, exento_bs, base_imponible_bs, ultima_factura
  FROM cierres_caja WHERE NOT anulado
 ORDER BY fecha DESC LIMIT 5;
