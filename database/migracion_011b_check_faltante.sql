-- =====================================================================
-- Purissima Cloud - Migración 011b: la restricción que faltó
--
-- Al correr la 011 entraron las cinco columnas, el índice y cuatro de las
-- cinco restricciones. La de reporte_z_anterior no quedó. Esto la agrega
-- y no hace nada más.
--
-- No es urgente: el backend ya rechaza un número negativo antes de
-- llegar a la base. Esto es por consistencia con las otras cuatro.
--
-- Se puede correr varias veces sin problema.
-- =====================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cierres_reporte_z_anterior') THEN
    ALTER TABLE cierres_caja ADD CONSTRAINT ck_cierres_reporte_z_anterior
      CHECK (reporte_z_anterior IS NULL OR reporte_z_anterior >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Comprobación: deben salir las CINCO
-- ---------------------------------------------------------------------
SELECT count(*) AS restricciones_del_cierre_fiscal,
       string_agg(conname, ', ' ORDER BY conname) AS cuales
  FROM pg_constraint
 WHERE conrelid = 'public.cierres_caja'::regclass
   AND conname IN ('ck_cierres_reporte_z', 'ck_cierres_reporte_z_anterior',
                   'ck_cierres_exento', 'ck_cierres_base_imponible',
                   'ck_cierres_ultima_factura');
