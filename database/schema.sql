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
DROP TABLE IF EXISTS confirmaciones_apertura CASCADE;
DROP TABLE IF EXISTS aperturas_tienda   CASCADE;
DROP TABLE IF EXISTS combustible_motos  CASCADE;
DROP TABLE IF EXISTS configuracion      CASCADE;
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
DROP TABLE IF EXISTS roles              CASCADE;
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
-- ROLES (los cargos del equipo)
--
-- Cada rol es un PERFIL: lleva su nombre y, guardados dentro, qué
-- módulos trae y qué funciones especiales concede. Quien lo tenga hereda
-- todo eso; encima se le puede marcar algo extra a una persona concreta,
-- y el permiso efectivo es la suma de los dos.
--
-- El Master los crea y edita desde "Accesos". 'admin' queda protegido
-- para que el sistema nunca se quede sin dueño, y el nivel Master
-- (es_master) no se concede desde la aplicación.
-- =====================================================================
CREATE TABLE roles (
  clave               varchar(30)  PRIMARY KEY
                                   CHECK (clave ~ '^[a-z][a-z0-9_]{2,29}$'),
  nombre              varchar(60)  NOT NULL,
  modulos_permitidos  jsonb        NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(modulos_permitidos) = 'array'),
  permisos_especiales jsonb        NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(permisos_especiales) = 'array'),
  es_master           boolean      NOT NULL DEFAULT FALSE,
  protegido           boolean      NOT NULL DEFAULT FALSE,
  activo              boolean      NOT NULL DEFAULT TRUE,
  creado_en           timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_roles_nombre ON roles (lower(nombre));
CREATE INDEX ix_roles_activo ON roles (activo);

-- Los tres de arranque. Nacen SIN permisos propios a propósito: así cada
-- empleado lleva lo suyo en su ficha y el Master decide después qué
-- conviene subir al cargo.
INSERT INTO roles (clave, nombre, es_master, protegido) VALUES
  ('admin',       'Master',     TRUE,  TRUE),
  ('tienda',      'Tienda',     FALSE, FALSE),
  ('motorizados', 'Motorizado', FALSE, FALSE);

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
  -- El cargo sale de la tabla "roles": no se borra un rol que alguien
  -- tenga asignado, y renombrar su clave arrastra a sus empleados.
  rol                 varchar(30)  NOT NULL REFERENCES roles (clave)
                                   ON UPDATE CASCADE ON DELETE RESTRICT,
  pin_hash            varchar(120) NOT NULL,
  -- Qué formularios puede llenar
  modulos_permitidos  jsonb        NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(modulos_permitidos) = 'array'),
  -- Funciones del Master concedidas una a una (ver_* y hacer).
  -- Conceder permisos NO está aquí: sigue siendo exclusivo del rol admin.
  permisos_especiales jsonb        NOT NULL DEFAULT '[]'::jsonb
                                   CHECK (jsonb_typeof(permisos_especiales) = 'array'),
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
  -- Las fotos NO viven aquí: viven en el almacén de archivos de Supabase
  -- (bucket "fotos", privado) y aquí sólo se guarda su ruta. Se acepta
  -- también un enlace http pegado a mano, como antes.
  foto_falla_url           text        CHECK (
                                         foto_falla_url IS NULL
                                         OR foto_falla_url ~* '^https?://'
                                         OR (foto_falla_url ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                             AND position('..' in foto_falla_url) = 0)),
  -- El kilometraje AL MOMENTO del cambio de aceite, que es la marca desde
  -- la cual se cuenta hasta el próximo. Puede ser igual o mayor al del
  -- arranque del día, nunca menor: eso lo valida el backend, que conoce
  -- los dos números a la vez.
  km_cambio_aceite         integer     CHECK (km_cambio_aceite IS NULL OR km_cambio_aceite >= 0),
  -- Las tres del día: tablero (que se lea el km), frontal y contrapicado
  -- trasero. Que sean obligatorias lo exige la aplicación, no la base,
  -- para que los checklists viejos sigan siendo válidos.
  foto_tablero             text        CHECK (foto_tablero IS NULL
                                         OR (foto_tablero ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                             AND position('..' in foto_tablero) = 0)),
  foto_frontal             text        CHECK (foto_frontal IS NULL
                                         OR (foto_frontal ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                             AND position('..' in foto_frontal) = 0)),
  foto_trasera             text        CHECK (foto_trasera IS NULL
                                         OR (foto_trasera ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                             AND position('..' in foto_trasera) = 0)),
  CONSTRAINT ck_checklist_km_si_uso CHECK (NOT se_uso_hoy OR kilometraje_inicial IS NOT NULL),
  CONSTRAINT ck_checklist_obs_si_falla CHECK (
    NOT tiene_falla OR (observacion_falla IS NOT NULL AND length(trim(observacion_falla)) > 0)
  )
);
-- El índice único por día se crea más abajo, junto con la anulación
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
  -- Cómo factura: decide si al recibir su mercancía la foto de la factura
  -- es obligatoria. Es una característica del proveedor y no una decisión
  -- de quien recibe, para que no exista la salida de marcar "digital" el
  -- día que se pierda el papel.
  tipo_factura varchar(10) NOT NULL DEFAULT 'fisica'
                           CHECK (tipo_factura IN ('fisica', 'digital', 'ambas')),
  activo    boolean      NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX ux_proveedores_nombre ON proveedores (lower(nombre));

CREATE TABLE productos (
  id                     integer       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                 varchar(120)  NOT NULL CHECK (length(trim(nombre)) >= 2),
  categoria              varchar(20)   NOT NULL
                         CHECK (categoria IN ('mercancia', 'insumo_tienda', 'agua')),
  -- Dentro de "mercancía", para describirla mejor. Obligatoria sólo ahí.
  subcategoria           varchar(20)
                         CHECK (subcategoria IS NULL OR subcategoria IN
                                ('bebidas', 'snacks', 'artesanales', 'insumos_agua')),
  proveedor_habitual_id  integer       REFERENCES proveedores (id),
  sku                    varchar(40),
  -- Los productos se piden por bulto: caja, gavera (vidrio) o brazo (snacks)
  empaquetado            varchar(10)   NOT NULL DEFAULT 'caja'
                                       CHECK (empaquetado IN ('caja', 'gavera', 'brazo')),
  unidades_por_empaquetado integer     NOT NULL DEFAULT 1 CHECK (unidades_por_empaquetado > 0),
  precio_usd             numeric(12,2) NOT NULL DEFAULT 0 CHECK (precio_usd >= 0),
  stock                  numeric(14,2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  activo                 boolean       NOT NULL DEFAULT TRUE,
  CONSTRAINT ck_productos_subcat_mercancia
    CHECK (categoria <> 'mercancia' OR subcategoria IS NOT NULL)
);
CREATE UNIQUE INDEX ux_productos_nombre ON productos (lower(nombre));
CREATE INDEX ix_productos_subcategoria ON productos (subcategoria);
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
  -- Igual que las del checklist: ruta del almacén, o un enlace pegado
  foto_factura_url  text        CHECK (
                                  foto_factura_url IS NULL
                                  OR foto_factura_url ~* '^https?://'
                                  OR (foto_factura_url ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                      AND position('..' in foto_factura_url) = 0)),
  -- Queda registrado cuando la factura se cargó como digital, para
  -- distinguirla de una a la que simplemente le falta la foto.
  factura_digital   boolean     NOT NULL DEFAULT FALSE,
  -- De qué solicitud vino esta recepción, si vino de alguna. La llave
  -- foránea se agrega más abajo, porque "solicitudes" se crea después.
  solicitud_id      uuid,
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
  -- Los costos operativos se escriben en dólares; la columna en bolívares
  -- guarda el equivalente (USD x tasa del día), que es lo que resta al neto.
  costos_operativos_usd  numeric(14,2) NOT NULL DEFAULT 0 CHECK (costos_operativos_usd >= 0),
  costos_operativos_bs   numeric(14,2) NOT NULL DEFAULT 0 CHECK (costos_operativos_bs >= 0),
  observacion            text,
  CONSTRAINT ck_cierre_total_cuadra CHECK (
    total_cierre_bs = pago_movil_bs + efectivo_bs + punto_venta_bs
  )
);
-- El índice único por fecha se crea más abajo, junto con la anulación
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
  proveedor_id    integer      REFERENCES proveedores (id),
  fecha_hora      timestamptz  NOT NULL DEFAULT now(),
  actualizado_en  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ix_solicitudes_fecha ON solicitudes (fecha_hora);
CREATE INDEX ix_solicitudes_proveedor ON solicitudes (proveedor_id);
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
-- ANULACIÓN DE REPORTES (exclusiva del Master)
--
-- Un registro mal hecho no se borra: se marca como anulado, con quién lo
-- anuló, cuándo y por qué. Deja de contar en los totales y libera el día
-- para que se pueda rehacer.
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checklist_motos', 'cierres_caja', 'entradas_agua',
                           'entradas_mercancia', 'solicitudes', 'incidencias']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN anulado boolean NOT NULL DEFAULT false', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN anulado_por integer REFERENCES usuarios (id)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN anulado_en timestamptz', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN motivo_anulacion text', t);
    EXECUTE format('CREATE INDEX ix_%s_anulado ON %I (anulado) WHERE anulado', t, t);
  END LOOP;
END $$;

-- Índices únicos PARCIALES: lo anulado deja de ocupar el lugar.
-- timezone(text, timestamptz) es IMMUTABLE, así que sirve en un índice.
CREATE UNIQUE INDEX ux_checklist_moto_dia
  ON checklist_motos (moto_id, ((fecha AT TIME ZONE 'America/Caracas')::date))
  WHERE NOT anulado;

CREATE UNIQUE INDEX ux_cierres_fecha ON cierres_caja (fecha) WHERE NOT anulado;

-- La recepción que vino de una solicitud. El índice único es PARCIAL: una
-- solicitud se recibe una sola vez, pero si esa recepción se anula, vuelve
-- a poder recibirse.
ALTER TABLE entradas_mercancia
  ADD CONSTRAINT fk_mercancia_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (id);
CREATE UNIQUE INDEX ux_mercancia_solicitud ON entradas_mercancia (solicitud_id)
  WHERE solicitud_id IS NOT NULL AND NOT anulado;

-- =====================================================================
-- APERTURA DE LA TIENDA
--
-- Una fila por día. La hora la pone el servidor al marcar la apertura: no
-- se escribe a mano, igual que el usuario de una anulación.
--
-- Es el cimiento de los promedios de finanzas: el promedio diario divide
-- entre los días que la tienda abrió, no entre los del calendario. Un
-- domingo cerrado no es un día flojo, es un día que no existió.
--
-- Sin apertura no se puede cerrar la caja de ese día.
-- =====================================================================
CREATE TABLE aperturas_tienda (
  fecha          date        PRIMARY KEY,
  abierta        boolean     NOT NULL,
  hora_apertura  timestamptz,
  usuario_id     integer     REFERENCES usuarios (id),
  -- Cuando el día se cierra a propósito: feriado, inventario, lo que sea
  motivo_cierre  text,
  -- Si el Master corrige una hora mal registrada, la original se conserva
  hora_original  timestamptz,
  corregida_por  integer     REFERENCES usuarios (id),
  corregida_en   timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_apertura_coherente CHECK (
    (abierta AND hora_apertura IS NOT NULL AND usuario_id IS NOT NULL)
    OR (NOT abierta AND motivo_cierre IS NOT NULL AND length(trim(motivo_cierre)) > 0)
  )
);

-- Quién vio la apertura del día: una fila por persona y por día, para que
-- la tarjeta no reaparezca y para saber quién se enteró y quién no.
CREATE TABLE confirmaciones_apertura (
  fecha         date        NOT NULL,
  usuario_id    integer     NOT NULL REFERENCES usuarios (id),
  confirmado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fecha, usuario_id)
);

-- =====================================================================
-- COMBUSTIBLE
--
-- El monto va en bolívares, que es con lo que se paga en la bomba. No
-- entra a los costos operativos del cierre de caja: esa gestión se lleva
-- aparte. Lleva las columnas de anulación como el resto de los registros.
-- =====================================================================
CREATE TABLE combustible_motos (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  moto_id          integer       NOT NULL REFERENCES motos (id),
  usuario_id       integer       NOT NULL REFERENCES usuarios (id),
  litros           numeric(10,2) NOT NULL CHECK (litros > 0),
  monto_bs         numeric(14,2) NOT NULL DEFAULT 0 CHECK (monto_bs >= 0),
  metodo_pago      varchar(20)   NOT NULL CHECK (metodo_pago IN
                                 ('transferencia', 'pago_movil', 'tarjeta_debito')),
  fecha_hora       timestamptz   NOT NULL DEFAULT now(),
  observacion      text,
  anulado          boolean       NOT NULL DEFAULT FALSE,
  anulado_por      integer       REFERENCES usuarios (id),
  anulado_en       timestamptz,
  motivo_anulacion text
);
CREATE INDEX ix_combustible_moto  ON combustible_motos (moto_id, fecha_hora DESC);
CREATE INDEX ix_combustible_fecha ON combustible_motos (fecha_hora DESC);

-- =====================================================================
-- AJUSTES DEL MASTER
--
-- Valores que antes estaban escritos en el código y cambiarlos exigía un
-- despliegue. dias_apertura usa la numeración ISO: 1 es lunes, 7 domingo.
-- =====================================================================
CREATE TABLE configuracion (
  clave           varchar(40) PRIMARY KEY,
  valor           jsonb       NOT NULL,
  actualizado_por integer     REFERENCES usuarios (id),
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO configuracion (clave, valor) VALUES
  ('dias_apertura',         '[1,2,3,4,5,6]'::jsonb),
  ('km_aceite',             '1500'::jsonb),
  ('km_aviso_anticipacion', '200'::jsonb);

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
  FOREACH t IN ARRAY ARRAY['roles', 'usuarios', 'motos', 'checklist_motos', 'proveedores', 'productos',
                           'aperturas_tienda', 'confirmaciones_apertura',
                           'combustible_motos', 'configuracion',
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
-- ALMACÉN DE FOTOS
--
-- Las fotos (facturas y checklist de motos) no caben en la base: una
-- pesa mil veces más que una fila. Van al almacén de archivos de
-- Supabase, que tiene su propio gigabyte, y en la base queda sólo la
-- ruta.
--
-- Se crea PRIVADO: nadie abre una foto adivinando su dirección. El
-- backend firma un enlace temporal cada vez que alguien autorizado
-- necesita verla. El tope de 2 MB es un techo de seguridad: el teléfono
-- comprime a unos 200 kB antes de subir.
-- =====================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('fotos', 'fotos', false, 2097152, ARRAY['image/jpeg', 'image/webp', 'image/png'])
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- SEMILLA: un único usuario Master
-- Se entra con el usuario "Master" y el PIN 123456
-- CAMBIE EL PIN EN EL PRIMER INGRESO (👤 -> Cambiar PIN)
-- =====================================================================
INSERT INTO usuarios (usuario, nombre, apellido, rol, pin_hash, modulos_permitidos)
VALUES ('Master', 'Master', '', 'admin', crypt('123456', gen_salt('bf', 10)),
        '["motos","caja","recepcion","solicitudes_negocio","solicitudes_productos","incidencias"]'::jsonb);
