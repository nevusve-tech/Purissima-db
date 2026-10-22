-- =====================================================================
-- Purissima Cloud - Migración 003 (tanda 2)
--
-- Agrega:
--   1. Anulación de reportes desde el Master, en los seis tipos de registro
--   2. Empaquetado de productos (caja / gavera / brazo) + unidades por empaque
--   3. Proveedor en las solicitudes de agua
--   4. Permisos separados: solicitudes del negocio / solicitudes de productos
--
-- Es idempotente: puede ejecutarse varias veces sin efectos adicionales.
--
-- DOS SUPRESIONES, ambas autorizadas expresamente:
--   a) Se borra el único producto cargado ("Pepsicola de 2l") y la columna
--      "unidad", que se reemplaza por "empaquetado". Los productos se
--      vuelven a cargar desde la aplicación.
--   b) Dos índices únicos se recrean como parciales, para que un registro
--      anulado libere el espacio y se pueda rehacer.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ANULACIÓN
--    Un registro anulado no se borra: queda marcado, con quién lo anuló,
--    cuándo y por qué. Deja de contar en los totales y libera el día.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checklist_motos', 'cierres_caja', 'entradas_agua',
                           'entradas_mercancia', 'solicitudes', 'incidencias']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS anulado_por integer REFERENCES usuarios (id)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS anulado_en timestamptz', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS motivo_anulacion text', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%s_anulado ON %I (anulado) WHERE anulado', t, t);
  END LOOP;
END $$;

-- Un checklist anulado libera ese día para que se haga de nuevo
DROP INDEX IF EXISTS ux_checklist_moto_dia;
CREATE UNIQUE INDEX IF NOT EXISTS ux_checklist_moto_dia
  ON checklist_motos (moto_id, ((fecha AT TIME ZONE 'America/Caracas')::date))
  WHERE NOT anulado;

-- Un cierre de caja anulado libera esa fecha
DROP INDEX IF EXISTS ux_cierres_fecha;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cierres_fecha
  ON cierres_caja (fecha) WHERE NOT anulado;

-- ---------------------------------------------------------------------
-- 2. EMPAQUETADO DE PRODUCTOS
--    Los productos se piden por bulto, no por unidad suelta:
--      caja   : lo habitual
--      gavera : botellas de vidrio
--      brazo  : snacks
-- ---------------------------------------------------------------------
DELETE FROM productos;  -- autorizado: se vuelven a cargar desde la aplicación

ALTER TABLE productos DROP COLUMN IF EXISTS unidad;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS empaquetado varchar(10) NOT NULL DEFAULT 'caja';
ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidades_por_empaquetado integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_productos_empaquetado') THEN
    ALTER TABLE productos ADD CONSTRAINT ck_productos_empaquetado
      CHECK (empaquetado IN ('caja', 'gavera', 'brazo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_productos_unidades') THEN
    ALTER TABLE productos ADD CONSTRAINT ck_productos_unidades
      CHECK (unidades_por_empaquetado > 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. PROVEEDOR EN LAS SOLICITUDES
--    Lo necesitan las solicitudes de agua.
-- ---------------------------------------------------------------------
ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS proveedor_id integer REFERENCES proveedores (id);
CREATE INDEX IF NOT EXISTS ix_solicitudes_proveedor ON solicitudes (proveedor_id);

-- ---------------------------------------------------------------------
-- 4. PERMISOS SEPARADOS
--    "solicitudes" se divide en dos módulos independientes:
--      solicitudes_negocio   -> insumos generales, mantenimiento, permisos
--      solicitudes_productos -> mercancía y agua
--    Quien tenía el permiso viejo recibe los dos, para no perder acceso.
-- ---------------------------------------------------------------------
UPDATE usuarios
   SET modulos_permitidos =
       (modulos_permitidos - 'solicitudes')
       || '["solicitudes_negocio","solicitudes_productos"]'::jsonb
 WHERE modulos_permitidos ? 'solicitudes';

-- ---------------------------------------------------------------------
-- 5. Comprobación
-- ---------------------------------------------------------------------
SELECT usuario, nombre, rol, modulos_permitidos FROM usuarios ORDER BY id;
