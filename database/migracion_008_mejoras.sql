-- =====================================================================
-- Purissima Cloud - Migración 008: las 21 mejoras
--
-- Un solo archivo con todo lo que las mejoras necesitan de la base.
-- Nada de lo que ya existe se borra ni se reescribe: sólo se agregan
-- columnas y tablas nuevas, y se amplía una restricción.
--
-- QUÉ TRAE
--   1. El kilometraje exacto del cambio de aceite en el checklist
--   2. La tabla de combustible
--   3. El enlace entre una recepción de mercancía y la solicitud que
--      la originó
--   4. Cómo factura cada proveedor (física, digital o ambas)
--   5. La apertura diaria de la tienda
--   6. Las confirmaciones de que alguien vio la apertura del día
--   7. La tabla de ajustes: qué días se abre y cada cuántos kilómetros
--      toca el aceite
--
-- Es idempotente y ADITIVA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. El kilometraje al momento del cambio de aceite
--
--    Hasta ahora el sistema usaba el kilometraje del arranque del día
--    como marca para contar hasta el próximo cambio. Pero el aceite se
--    cambia durante o después de la jornada, así que ese número podía
--    quedar corto. Ahora se pide aparte.
--
--    Puede ser igual o mayor al del arranque, nunca menor: eso lo
--    valida el backend, que es el que conoce los dos números al mismo
--    tiempo. Aquí sólo se exige que no sea negativo.
-- ---------------------------------------------------------------------
ALTER TABLE checklist_motos
  ADD COLUMN IF NOT EXISTS km_cambio_aceite integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_checklist_km_aceite') THEN
    ALTER TABLE checklist_motos ADD CONSTRAINT ck_checklist_km_aceite
      CHECK (km_cambio_aceite IS NULL OR km_cambio_aceite >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Combustible
--
--    Lleva las columnas de anulación como el resto de los registros:
--    una carga mal hecha no se borra, se anula y deja de contar.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS combustible_motos (
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

CREATE INDEX IF NOT EXISTS ix_combustible_moto  ON combustible_motos (moto_id, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS ix_combustible_fecha ON combustible_motos (fecha_hora DESC);

-- ---------------------------------------------------------------------
-- 3. El enlace entre una recepción y la solicitud que la originó
--
--    Una solicitud se recibe en una sola entrega, así que basta con
--    guardar de qué solicitud vino. El índice único parcial impide que
--    la misma solicitud se reciba dos veces, salvo que la recepción se
--    haya anulado.
-- ---------------------------------------------------------------------
ALTER TABLE entradas_mercancia
  ADD COLUMN IF NOT EXISTS solicitud_id uuid REFERENCES solicitudes (id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mercancia_solicitud
  ON entradas_mercancia (solicitud_id)
  WHERE solicitud_id IS NOT NULL AND NOT anulado;

-- ---------------------------------------------------------------------
-- 4. Cómo factura cada proveedor
--
--    'fisica'  -> entrega el papel en la mano: la foto es obligatoria
--    'digital' -> la manda al correo de la empresa: no se pide foto
--    'ambas'   -> depende de la entrega: el empleado lo indica
--
--    Arrancan todos en 'fisica', que es el caso que exige respaldo. Así
--    nadie queda sin foto por omisión: el Master va marcando los
--    digitales a medida que corresponda.
-- ---------------------------------------------------------------------
ALTER TABLE proveedores
  ADD COLUMN IF NOT EXISTS tipo_factura varchar(10) NOT NULL DEFAULT 'fisica';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_proveedores_tipo_factura') THEN
    ALTER TABLE proveedores ADD CONSTRAINT ck_proveedores_tipo_factura
      CHECK (tipo_factura IN ('fisica', 'digital', 'ambas'));
  END IF;
END $$;

-- Queda registrado cuándo una factura se cargó como digital, para que en
-- el reporte se distinga de una a la que simplemente le falta la foto.
ALTER TABLE entradas_mercancia
  ADD COLUMN IF NOT EXISTS factura_digital boolean NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------
-- 5. La apertura diaria de la tienda
--
--    Una fila por día. La hora la pone el servidor al momento de marcar
--    la apertura: no se escribe a mano, igual que el usuario de una
--    anulación.
--
--    abierta = false es un día cerrado a propósito (feriado, inventario)
--    y lleva su motivo. Un día laborable que no tenga fila es un día
--    "sin registrar", que es distinto: ahí falta algo y el sistema lo
--    señala.
--
--    Si alguien olvida marcar la apertura y la marca tarde, el Master
--    puede corregir la hora. La original se conserva en hora_original
--    para que la corrección quede a la vista.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aperturas_tienda (
  fecha          date        PRIMARY KEY,
  abierta        boolean     NOT NULL,
  hora_apertura  timestamptz,
  usuario_id     integer     REFERENCES usuarios (id),
  motivo_cierre  text,
  hora_original  timestamptz,
  corregida_por  integer     REFERENCES usuarios (id),
  corregida_en   timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  -- Si está abierta, tiene hora y quién la abrió. Si no, tiene motivo.
  CONSTRAINT ck_apertura_coherente CHECK (
    (abierta AND hora_apertura IS NOT NULL AND usuario_id IS NOT NULL)
    OR (NOT abierta AND motivo_cierre IS NOT NULL AND length(trim(motivo_cierre)) > 0)
  )
);

-- ---------------------------------------------------------------------
-- 6. Quién vio la apertura del día
--
--    Una fila por persona y por día. Sirve para que la tarjeta no vuelva
--    a aparecer después de confirmarla, y para que el Master vea quién
--    se enteró y quién no.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS confirmaciones_apertura (
  fecha          date        NOT NULL,
  usuario_id     integer     NOT NULL REFERENCES usuarios (id),
  confirmado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fecha, usuario_id)
);

-- ---------------------------------------------------------------------
-- 7. Ajustes del Master
--
--    Valores que antes estaban escritos en el código y que ahora el
--    Master cambia desde la aplicación, sin esperar un despliegue.
--
--    dias_apertura usa la numeración ISO de Postgres: 1 es lunes y 7 es
--    domingo. Arranca de lunes a sábado.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS configuracion (
  clave           varchar(40) PRIMARY KEY,
  valor           jsonb       NOT NULL,
  actualizado_por integer     REFERENCES usuarios (id),
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO configuracion (clave, valor) VALUES
  ('dias_apertura',        '[1,2,3,4,5,6]'::jsonb),
  ('km_aceite',            '1500'::jsonb),
  ('km_aviso_anticipacion', '200'::jsonb)
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------
-- 8. Rellenar el kilometraje de aceite de los checklists ya guardados
--
--    Los checklists viejos que marcaron cambio de aceite no tienen el
--    número nuevo. Se les copia el kilometraje del arranque, que es lo
--    que el sistema venía usando: así las cuentas de esos registros no
--    cambian y el histórico queda consistente.
-- ---------------------------------------------------------------------
UPDATE checklist_motos
   SET km_cambio_aceite = kilometraje_inicial
 WHERE cambio_aceite_realizado
   AND km_cambio_aceite IS NULL
   AND kilometraje_inicial IS NOT NULL;

-- ---------------------------------------------------------------------
-- 9. Clausura de la API pública para las tablas nuevas
--
--    Igual que el resto: RLS sin políticas y privilegios revocados a
--    anon y authenticated, para que la única entrada sea el backend.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['combustible_motos', 'aperturas_tienda',
                           'confirmaciones_apertura', 'configuracion']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE 'Roles anon/authenticated no existen (fuera de Supabase): se omite el REVOKE';
    END;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
SELECT 'tablas nuevas' AS comprobacion,
       string_agg(table_name, ', ' ORDER BY table_name) AS valor
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('combustible_motos', 'aperturas_tienda',
                      'confirmaciones_apertura', 'configuracion')
UNION ALL
SELECT 'columnas nuevas',
       string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name, column_name)
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name, column_name) IN (
     ('checklist_motos', 'km_cambio_aceite'),
     ('entradas_mercancia', 'solicitud_id'),
     ('entradas_mercancia', 'factura_digital'),
     ('proveedores', 'tipo_factura'))
UNION ALL
SELECT 'checklists de aceite rellenados',
       count(*)::text FROM checklist_motos
 WHERE cambio_aceite_realizado AND km_cambio_aceite IS NOT NULL;

SELECT clave, valor FROM configuracion ORDER BY clave;

SELECT nombre, tipo, tipo_factura FROM proveedores ORDER BY nombre;
