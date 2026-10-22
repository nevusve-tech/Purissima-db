-- =====================================================================
-- Purissima Cloud - Esquema completo (instalación desde cero)
--
-- ATENCIÓN: este script BORRA las tablas existentes y las vuelve a crear.
-- Pensado para arrancar limpio, sin los datos de pruebas anteriores.
--
-- Zona horaria: America/Caracas
-- Probado contra PostgreSQL 17 (Supabase).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET timezone TO 'America/Caracas';

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'America/Caracas');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No se pudo fijar la zona horaria de la base: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------
-- Limpieza (el orden no importa por el CASCADE)
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS checklist_motos    CASCADE;
DROP TABLE IF EXISTS entradas_agua      CASCADE;
DROP TABLE IF EXISTS entradas_mercancia CASCADE;
DROP TABLE IF EXISTS incidencias        CASCADE;
DROP TABLE IF EXISTS solicitudes        CASCADE;
DROP TABLE IF EXISTS cierres_caja       CASCADE;
DROP TABLE IF EXISTS productos          CASCADE;
DROP TABLE IF EXISTS proveedores        CASCADE;
DROP TABLE IF EXISTS motos              CASCADE;
DROP TABLE IF EXISTS usuarios           CASCADE;
DROP FUNCTION IF EXISTS set_actualizado_en() CASCADE;
DROP FUNCTION IF EXISTS sync_usuario_activo() CASCADE;

-- ---------------------------------------------------------------------
-- Utilidad: mantener la columna actualizado_en
-- ---------------------------------------------------------------------
CREATE FUNCTION set_actualizado_en() RETURNS trigger AS $fn$
BEGIN
  NEW.actualizado_en = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- =====================================================================
-- USUARIOS
-- modulos_permitidos (JSONB) controla de forma dinámica qué formularios
-- ve y puede llenar cada empleado. El Master lo edita desde "Accesos".
-- =====================================================================
CREATE TABLE usuarios (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario             varchar(40)  NOT NULL
                                   CHECK (length(trim(usuario)) >= 3 AND usuario !~ '\s'),
  nombre              varchar(80)  NOT NULL CHECK (length(trim(nombre)) >= 2),
  apellido            varchar(80)  NOT NULL DEFAULT '',
  rol                 varchar(20)  NOT NULL CHECK (rol IN ('motorizados', 'tienda', 'admin')),
  pin_hash            varchar(120) NOT NULL,
  modulos_permitidos  jsonb        NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(modulos_permitidos) = 'array'),
  estado              varchar(10)  NOT NULL DEFAULT 'activo'
                                   CHECK (estado IN ('activo', 'pausado', 'eliminado')),
  intentos_fallidos   smallint     NOT NULL DEFAULT 0 CHECK (intentos_fallidos >= 0),
  bloqueado_hasta     timestamptz,
  activo              boolean      NOT NULL DEFAULT TRUE,
  creado_en           timestamptz  NOT NULL DEFAULT now(),
  actualizado_en      timestamptz  NOT NULL DEFAULT now()
);
-- Se entra con "usuario": el índice único evita ambigüedad.
-- El nombre puede repetirse (dos empleados pueden llamarse igual).
CREATE UNIQUE INDEX ux_usuarios_usuario_lower ON usuarios (lower(usuario));
CREATE INDEX ix_usuarios_rol ON usuarios (rol);
CREATE INDEX ix_usuarios_estado ON usuarios (estado);

CREATE TRIGGER trg_usuarios_actualizado BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();

-- "activo" se mantiene solo en sincronía con "estado"
CREATE FUNCTION sync_usuario_activo() RETURNS trigger AS $fn$
BEGIN
  NEW.activo = (NEW.estado = 'activo');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_usuarios_estado BEFORE INSERT OR UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION sync_usuario_activo();

-- =====================================================================
-- MOTOS
-- =====================================================================
CREATE TABLE motos (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                   varchar(80) NOT NULL CHECK (length(trim(nombre)) >= 2),
  color                    varchar(40) NOT NULL CHECK (length(trim(color)) >= 2),
  placa                    varchar(20) NOT NULL CHECK (length(trim(placa)) >= 3),
  tipo_modelo              varchar(20) NOT NULL
                           CHECK (tipo_modelo IN ('sbr_150cc', 'carguera_200cc', 'otro')),
  ultimo_kilometraje       integer     NOT NULL DEFAULT 0 CHECK (ultimo_kilometraje >= 0),
  ultimo_cambio_aceite_km  integer     NOT NULL DEFAULT 0 CHECK (ultimo_cambio_aceite_km >= 0),
  activa                   boolean     NOT NULL DEFAULT TRUE,
  CONSTRAINT ck_motos_aceite_le_km CHECK (ultimo_cambio_aceite_km <= ultimo_kilometraje)
);
CREATE UNIQUE INDEX ux_motos_placa ON motos (placa);
CREATE INDEX ix_motos_activa ON motos (activa);

-- =====================================================================
-- CHECKLIST DE MOTOS
-- Reglas: si se usó hoy, el kilometraje inicial es obligatorio.
--         si tiene falla, la observación es obligatoria.
--         un solo checklist por moto por día (fecha local de Caracas).
-- =====================================================================
CREATE TABLE checklist_motos (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  moto_id                  integer     NOT NULL REFERENCES motos (id),
  usuario_id               integer     NOT NULL REFERENCES usuarios (id),
  fecha                    timestamptz NOT NULL DEFAULT now(),
  se_uso_hoy               boolean     NOT NULL DEFAULT TRUE,
  kilometraje_inicial      integer     CHECK (kilometraje_inicial IS NULL OR kilometraje_inicial >= 0),
  cambio_aceite_realizado  boolean     NOT NULL DEFAULT FALSE,
  detalles_items           jsonb       CHECK (detalles_items IS NULL
                                              OR jsonb_typeof(detalles_items) IN ('object', 'array')),
  tiene_falla              boolean     NOT NULL DEFAULT FALSE,
  observacion_falla        text,
  foto_falla_url           text        CHECK (foto_falla_url IS NULL OR foto_falla_url ~* '^https?://'),
  CONSTRAINT ck_checklist_km_si_uso CHECK (NOT se_uso_hoy OR kilometraje_inicial IS NOT NULL),
  CONSTRAINT ck_checklist_obs_si_falla CHECK (
    NOT tiene_falla OR (observacion_falla IS NOT NULL AND length(trim(observacion_falla)) > 0)
  )
);
-- timezone(text, timestamptz) es IMMUTABLE, así que sirve en un índice
CREATE UNIQUE INDEX ux_checklist_moto_dia
  ON checklist_motos (moto_id, ((fecha AT TIME ZONE 'America/Caracas')::date));
CREATE INDEX ix_checklist_fecha ON checklist_motos (fecha);
CREATE INDEX ix_checklist_usuario ON checklist_motos (usuario_id);
CREATE INDEX ix_checklist_falla ON checklist_motos (tiene_falla) WHERE tiene_falla;

-- =====================================================================
-- PROVEEDORES Y PRODUCTOS
-- =====================================================================
CREATE TABLE proveedores (
  id        integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre    varchar(120) NOT NULL CHECK (length(trim(nombre)) >= 2),
  tipo      varchar(20)  NOT NULL CHECK (tipo IN ('agua', 'mercancia', 'ambos')),
  contacto  varchar(120),
  rif       varchar(20),
  telefono  varchar(30),
  activo    boolean      NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX ux_proveedores_nombre ON proveedores (lower(nombre));

CREATE TABLE productos (
  id                     integer       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                 varchar(120)  NOT NULL CHECK (length(trim(nombre)) >= 2),
  categoria              varchar(20)   NOT NULL
                         CHECK (categoria IN ('mercancia', 'insumo_tienda', 'agua')),
  proveedor_habitual_id  integer       REFERENCES proveedores (id),
  sku                    varchar(40),
  unidad                 varchar(20)   NOT NULL DEFAULT 'unidad',
  precio_usd             numeric(12,2) NOT NULL DEFAULT 0 CHECK (precio_usd >= 0),
  stock                  numeric(14,2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  activo                 boolean       NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX ux_productos_nombre ON productos (lower(nombre));
CREATE UNIQUE INDEX ux_productos_sku ON productos (sku) WHERE sku IS NOT NULL;
CREATE INDEX ix_productos_proveedor ON productos (proveedor_habitual_id);

-- =====================================================================
-- ENTRADAS DE AGUA Y MERCANCÍA
-- =====================================================================
CREATE TABLE entradas_agua (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id      integer       NOT NULL REFERENCES proveedores (id),
  usuario_id        integer       NOT NULL REFERENCES usuarios (id),
  fecha_hora        timestamptz   NOT NULL DEFAULT now(),
  litraje           numeric(12,2) NOT NULL CHECK (litraje > 0),
  observaciones     text,
  tiene_incidencia  boolean       NOT NULL DEFAULT FALSE
);
CREATE INDEX ix_entradas_agua_fecha ON entradas_agua (fecha_hora);
CREATE INDEX ix_entradas_agua_usuario ON entradas_agua (usuario_id);
CREATE INDEX ix_entradas_agua_proveedor ON entradas_agua (proveedor_id);

CREATE TABLE entradas_mercancia (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id      integer     NOT NULL REFERENCES proveedores (id),
  usuario_id        integer     NOT NULL REFERENCES usuarios (id),
  fecha_hora        timestamptz NOT NULL DEFAULT now(),
  items_recibidos   jsonb       NOT NULL CHECK (jsonb_typeof(items_recibidos) IN ('array', 'object')),
  foto_factura_url  text        CHECK (foto_factura_url IS NULL OR foto_factura_url ~* '^https?://'),
  observaciones     text
);
CREATE INDEX ix_entradas_merc_fecha ON entradas_mercancia (fecha_hora);
CREATE INDEX ix_entradas_merc_usuario ON entradas_mercancia (usuario_id);
CREATE INDEX ix_entradas_merc_proveedor ON entradas_mercancia (proveedor_id);

-- =====================================================================
-- CIERRES DE CAJA
-- Idempotencia estricta: un único cierre por fecha.
-- Cuadre: total_cierre_bs = pago móvil + efectivo + punto de venta.
-- total_ingreso_dolar lo calcula el backend como
--   total_cierre_bs / tasa_dolar + dolares_vendidos
-- =====================================================================
CREATE TABLE cierres_caja (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id             integer       NOT NULL REFERENCES usuarios (id),
  fecha                  date          NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Caracas')::date),
  creado_en              timestamptz   NOT NULL DEFAULT now(),
  pago_movil_bs          numeric(14,2) NOT NULL DEFAULT 0 CHECK (pago_movil_bs >= 0),
  efectivo_bs            numeric(14,2) NOT NULL DEFAULT 0 CHECK (efectivo_bs >= 0),
  punto_venta_bs         numeric(14,2) NOT NULL DEFAULT 0 CHECK (punto_venta_bs >= 0),
  total_cierre_bs        numeric(14,2) NOT NULL CHECK (total_cierre_bs >= 0),
  tasa_dolar             numeric(14,4) NOT NULL CHECK (tasa_dolar > 0),
  dolares_vendidos       numeric(14,2) NOT NULL DEFAULT 0 CHECK (dolares_vendidos >= 0),
  total_ingreso_dolar    numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_ingreso_dolar >= 0),
  impuestos_fiscales_bs  numeric(14,2) NOT NULL DEFAULT 0 CHECK (impuestos_fiscales_bs >= 0),
  costos_operativos_bs   numeric(14,2) NOT NULL DEFAULT 0 CHECK (costos_operativos_bs >= 0),
  observacion            text,
  CONSTRAINT ck_cierre_total_cuadra CHECK (
    total_cierre_bs = pago_movil_bs + efectivo_bs + punto_venta_bs
  )
);
CREATE UNIQUE INDEX ux_cierres_fecha ON cierres_caja (fecha);
CREATE INDEX ix_cierres_usuario ON cierres_caja (usuario_id);

-- =====================================================================
-- SOLICITUDES
-- =====================================================================
CREATE TABLE solicitudes (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id      integer      NOT NULL REFERENCES usuarios (id),
  tipo_solicitud  varchar(30)  NOT NULL CHECK (tipo_solicitud IN
                               ('mercancia', 'agua', 'insumos_generales',
                                'mantenimiento', 'permiso', 'otro')),
  titulo          varchar(120) NOT NULL CHECK (length(trim(titulo)) >= 3),
  descripcion     text         NOT NULL DEFAULT '',
  detalle_items   jsonb        NOT NULL DEFAULT '[]'::jsonb
                               CHECK (jsonb_typeof(detalle_items) IN ('array', 'object')),
  estado          varchar(20)  NOT NULL DEFAULT 'pendiente' CHECK (estado IN
                               ('pendiente', 'aprobada', 'en_proceso', 'completada', 'rechazada')),
  notas_admin     text,
  fecha_hora      timestamptz  NOT NULL DEFAULT now(),
  actualizado_en  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_solicitudes_fecha ON solicitudes (fecha_hora);
CREATE INDEX ix_solicitudes_usuario ON solicitudes (usuario_id);
CREATE INDEX ix_solicitudes_estado ON solicitudes (estado);
CREATE INDEX ix_solicitudes_tipo_estado ON solicitudes (tipo_solicitud, estado);

CREATE TRIGGER trg_solicitudes_actualizado BEFORE UPDATE ON solicitudes
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();

-- =====================================================================
-- INCIDENCIAS
-- =====================================================================
CREATE TABLE incidencias (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id      integer      NOT NULL REFERENCES usuarios (id),
  tipo            varchar(30)  NOT NULL CHECK (tipo IN
                               ('financiera_caja', 'cliente', 'operativa_tienda',
                                'moto', 'agua', 'seguridad', 'otro')),
  titulo          varchar(120) NOT NULL CHECK (length(trim(titulo)) >= 3),
  descripcion     text         NOT NULL CHECK (length(trim(descripcion)) > 0),
  severidad       varchar(10)  NOT NULL DEFAULT 'media' CHECK (severidad IN ('baja', 'media', 'alta')),
  estado          varchar(20)  NOT NULL DEFAULT 'abierta'
                               CHECK (estado IN ('abierta', 'en_revision', 'cerrada')),
  moto_id         integer      REFERENCES motos (id),
  cierre_caja_id  uuid         REFERENCES cierres_caja (id),
  notas_admin     text,
  fecha_hora      timestamptz  NOT NULL DEFAULT now(),
  actualizado_en  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_incidencias_fecha ON incidencias (fecha_hora);
CREATE INDEX ix_incidencias_usuario ON incidencias (usuario_id);
CREATE INDEX ix_incidencias_estado ON incidencias (estado);
CREATE INDEX ix_incidencias_tipo_estado ON incidencias (tipo, estado);
CREATE INDEX ix_incidencias_moto ON incidencias (moto_id);
CREATE INDEX ix_incidencias_cierre ON incidencias (cierre_caja_id);

CREATE TRIGGER trg_incidencias_actualizado BEFORE UPDATE ON incidencias
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();

-- =====================================================================
-- SEGURIDAD: cerrar la puerta de la API pública de Supabase
--
-- Supabase expone el esquema "public" por REST con las llaves anon y
-- authenticated. Esta aplicación NO usa esa vía: entra por el backend
-- con el rol "postgres", que omite RLS (BYPASSRLS).
--
-- Se activa RLS SIN políticas (todo denegado) y se revocan privilegios
-- a anon y authenticated, para que nadie con la llave pública pueda
-- leer ni escribir estas tablas.
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios', 'motos', 'checklist_motos', 'proveedores', 'productos',
                           'entradas_agua', 'entradas_mercancia', 'cierres_caja',
                           'solicitudes', 'incidencias']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE 'Roles anon/authenticated no existen (fuera de Supabase): se omite el REVOKE';
    END;
  END LOOP;
END $$;

-- =====================================================================
-- SEMILLA: un único usuario Master
-- Se entra con el usuario "Master" y el PIN 123456
-- CAMBIE EL PIN EN EL PRIMER INGRESO (👤 -> Cambiar PIN)
-- =====================================================================
INSERT INTO usuarios (usuario, nombre, apellido, rol, pin_hash, modulos_permitidos)
VALUES ('Master', 'Master', '', 'admin', crypt('123456', gen_salt('bf', 10)),
        '["motos","caja","recepcion","solicitudes","incidencias"]'::jsonb);
