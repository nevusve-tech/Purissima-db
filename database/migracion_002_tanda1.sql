-- =====================================================================
-- Purissima Cloud - Migración 002 (tanda 1)
--
-- ADITIVA: no borra tablas ni datos. Agrega a "usuarios":
--   - usuario   : el nombre con el que se entra al sistema
--   - apellido  : para mostrar el nombre completo en pantalla
--   - estado    : activo | pausado | eliminado
--
-- Es idempotente: puede ejecutarse varias veces sin efectos adicionales.
--
-- ÚNICA SUPRESIÓN: el índice único sobre lower(nombre) se reemplaza por
-- uno sobre lower(usuario). Es necesario, porque a partir de ahora dos
-- personas pueden llamarse igual pero su usuario de ingreso debe ser único.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columnas nuevas
-- ---------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS usuario  varchar(40);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apellido varchar(80) NOT NULL DEFAULT '';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado   varchar(10) NOT NULL DEFAULT 'activo';

-- ---------------------------------------------------------------------
-- 2. Datos de las cuentas que ya existen
--    En un solo UPDATE: todos los CASE leen el nombre ORIGINAL.
-- ---------------------------------------------------------------------
UPDATE usuarios SET
  usuario = CASE lower(nombre)
              WHEN 'master'        THEN 'Master'
              WHEN 'eduardo yanez' THEN 'eyanez'
              WHEN 'noryana'       THEN 'Noryana'
              ELSE usuario END,
  apellido = CASE lower(nombre)
              WHEN 'master'        THEN 'Arreaza'
              WHEN 'eduardo yanez' THEN 'Yanez'
              ELSE apellido END,
  nombre  = CASE lower(nombre)
              WHEN 'master'        THEN 'Simón'
              WHEN 'eduardo yanez' THEN 'Eduardo'
              ELSE nombre END
WHERE lower(nombre) IN ('master', 'eduardo yanez', 'noryana');

-- Cualquier otra cuenta que existiera: su usuario pasa a ser su nombre actual
UPDATE usuarios SET usuario = nombre WHERE usuario IS NULL OR trim(usuario) = '';

-- ---------------------------------------------------------------------
-- 3. El usuario pasa a ser obligatorio y único
-- ---------------------------------------------------------------------
ALTER TABLE usuarios ALTER COLUMN usuario SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_usuario_lower ON usuarios (lower(usuario));
DROP INDEX IF EXISTS ux_usuarios_nombre_lower;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_usuarios_usuario') THEN
    ALTER TABLE usuarios ADD CONSTRAINT ck_usuarios_usuario
      CHECK (length(trim(usuario)) >= 3 AND usuario !~ '\s');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Estado de la cuenta
--    activo    : entra normalmente
--    pausado   : sin acceso temporal, se puede reactivar
--    eliminado : sin acceso permanente, pero su historial se conserva
-- ---------------------------------------------------------------------
UPDATE usuarios SET estado = 'pausado' WHERE NOT activo AND estado = 'activo';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_usuarios_estado') THEN
    ALTER TABLE usuarios ADD CONSTRAINT ck_usuarios_estado
      CHECK (estado IN ('activo', 'pausado', 'eliminado'));
  END IF;
END $$;

-- La columna "activo" se conserva y se mantiene sola en sincronía con el
-- estado, para que nada de lo que ya funcionaba deje de funcionar.
CREATE OR REPLACE FUNCTION sync_usuario_activo() RETURNS trigger AS $fn$
BEGIN
  NEW.activo = (NEW.estado = 'activo');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usuarios_estado ON usuarios;
CREATE TRIGGER trg_usuarios_estado BEFORE INSERT OR UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION sync_usuario_activo();

CREATE INDEX IF NOT EXISTS ix_usuarios_estado ON usuarios (estado);

-- ---------------------------------------------------------------------
-- 5. Comprobación: así quedan las cuentas
-- ---------------------------------------------------------------------
SELECT id, usuario, nombre, apellido, rol, estado, activo FROM usuarios ORDER BY id;
