-- =====================================================================
-- Purissima Cloud - Migración 006: roles creados por el Master
--
-- Hasta ahora el cargo de cada empleado era uno de tres valores fijos,
-- escritos a mano dentro de la base: 'motorizados', 'tienda' y 'admin'.
-- Para agregar un cargo nuevo había que modificar el código.
--
-- Esta migración convierte los cargos en una tabla que el Master
-- administra desde la pantalla de Accesos. Cada rol es un PERFIL: lleva
-- su nombre y, guardados dentro, qué módulos ve y qué funciones
-- especiales trae. Al asignarle un rol a un empleado, el empleado hereda
-- todo eso; si después se edita el rol, cambia para todos los que lo
-- tengan.
--
-- Encima de lo heredado se le puede seguir marcando algo extra a una
-- persona concreta. El permiso efectivo es la suma de los dos.
--
-- QUÉ NO CAMBIA
--   * Nadie gana ni pierde acceso al aplicar esto. Los tres roles que ya
--     existían se crean con los permisos VACÍOS, así que cada empleado
--     sigue teniendo exactamente lo que tiene marcado hoy en su ficha.
--   * 'admin' (Master) queda marcado como protegido: no se puede editar,
--     renombrar ni borrar, para que el sistema nunca se quede sin dueño.
--   * Los roles nuevos nunca son Master. Esa condición no se concede
--     desde la aplicación.
--
-- LO ÚNICO QUE SE RETIRA es la restricción CHECK que limitaba la columna
-- "rol" a esos tres textos: la reemplaza una llave foránea contra la
-- tabla nueva, que es más estricta (sólo admite roles que existan) y
-- además impide borrar un rol que alguien esté usando. No se borra
-- ningún dato.
--
-- Es idempotente y ADITIVA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. La columna debe admitir claves más largas que 20 caracteres
--    ('gerente_recursos_humanos' tiene 24)
-- ---------------------------------------------------------------------
ALTER TABLE usuarios ALTER COLUMN rol TYPE varchar(30);

-- ---------------------------------------------------------------------
-- 2. La tabla de roles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  clave               varchar(30)  PRIMARY KEY,
  nombre              varchar(60)  NOT NULL,
  modulos_permitidos  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  permisos_especiales jsonb        NOT NULL DEFAULT '[]'::jsonb,
  -- es_master: el dueño del sistema. Lo tiene sólo 'admin' y no se
  -- concede desde la aplicación.
  es_master           boolean      NOT NULL DEFAULT false,
  -- protegido: no se puede editar ni borrar desde la aplicación
  protegido           boolean      NOT NULL DEFAULT false,
  activo              boolean      NOT NULL DEFAULT true,
  creado_en           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_roles_clave CHECK (clave ~ '^[a-z][a-z0-9_]{2,29}$'),
  CONSTRAINT ck_roles_modulos  CHECK (jsonb_typeof(modulos_permitidos) = 'array'),
  CONSTRAINT ck_roles_permisos CHECK (jsonb_typeof(permisos_especiales) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_roles_nombre ON roles (lower(nombre));
CREATE INDEX IF NOT EXISTS ix_roles_activo ON roles (activo);

-- ---------------------------------------------------------------------
-- 3. Los tres roles que ya existían, con permisos VACÍOS a propósito
--    (ver nota arriba: así nadie gana ni pierde acceso hoy)
-- ---------------------------------------------------------------------
INSERT INTO roles (clave, nombre, es_master, protegido) VALUES
  ('admin',        'Master',     true,  true),
  ('tienda',       'Tienda',     false, false),
  ('motorizados',  'Motorizado', false, false)
ON CONFLICT (clave) DO NOTHING;

-- Por si la tabla ya existía de una corrida anterior: 'admin' siempre
-- debe quedar como Master y protegido.
UPDATE roles SET es_master = true, protegido = true, activo = true
  WHERE clave = 'admin' AND (es_master IS DISTINCT FROM true OR protegido IS DISTINCT FROM true);

-- Cualquier rol que alguien tenga asignado y que no figure en la tabla
-- se da de alta solo, para que el paso 4 no pueda fallar.
INSERT INTO roles (clave, nombre)
  SELECT DISTINCT u.rol, initcap(replace(u.rol, '_', ' '))
    FROM usuarios u
   WHERE u.rol IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.clave = u.rol)
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Reemplazar el CHECK de tres valores por la llave foránea
--
--    Se busca el CHECK por su definición (sobre la columna "rol" y nada
--    más), no por su nombre, porque el nombre lo puso Postgres solo.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_rol smallint;
  c     record;
BEGIN
  SELECT attnum INTO n_rol FROM pg_attribute
    WHERE attrelid = 'usuarios'::regclass AND attname = 'rol' AND NOT attisdropped;

  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'usuarios'::regclass
              AND contype = 'c'
              AND conkey = ARRAY[n_rol]
  LOOP
    EXECUTE format('ALTER TABLE usuarios DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'Retirada la restricción fija de roles: %', c.conname;
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_usuarios_rol') THEN
    ALTER TABLE usuarios ADD CONSTRAINT fk_usuarios_rol
      FOREIGN KEY (rol) REFERENCES roles (clave)
      ON UPDATE CASCADE    -- renombrar la clave de un rol arrastra a sus empleados
      ON DELETE RESTRICT;  -- no se borra un rol que alguien esté usando
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. Misma clausura que el resto de las tablas: la API pública de
--    Supabase no puede ver ni tocar esto
-- ---------------------------------------------------------------------
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON TABLE roles FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Roles anon/authenticated no existen (fuera de Supabase): se omite el REVOKE';
END $$;

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
SELECT clave, nombre, es_master, protegido, activo,
       modulos_permitidos, permisos_especiales
  FROM roles ORDER BY es_master DESC, nombre;

SELECT u.usuario, u.nombre, u.rol, r.nombre AS cargo,
       u.modulos_permitidos AS modulos_propios,
       u.permisos_especiales AS extras_propios
  FROM usuarios u JOIN roles r ON r.clave = u.rol
 ORDER BY u.id;
