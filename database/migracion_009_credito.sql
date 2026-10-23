-- =====================================================================
-- Purissima Cloud - Migración 009: crédito, proveedor en la solicitud
-- e ítems en reparación
--
-- QUÉ TRAE
--   1. Método de pago y días de crédito del proveedor
--   2. En la recepción: si fue a crédito, cuánto se debe en dólares,
--      cuándo vence y cuándo se pagó
--   3. El proveedor pasa a ser obligatorio en las solicitudes de
--      mercancía
--   4. Qué puntos del checklist tiene afectados una incidencia, para
--      poder bloquearlos mientras la falla siga abierta
--
-- SOBRE LAS DEUDAS
-- El monto va en DÓLARES aunque se pague en bolívares: una deuda a 15 o
-- 30 días en bolívares no significa nada, porque lo que se debe en
-- términos reales cambia con la tasa.
--
-- Y este registro NO entra a la contabilidad de la aplicación: ni a
-- finanzas, ni a los costos operativos, ni a los promedios. Es un
-- recordatorio de lo que hay que pagar y de cuándo se pagó, nada más.
--
-- Es idempotente y ADITIVA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cómo se le paga a cada proveedor
--
--    'contado' -> se paga al recibir, y la factura llega con la entrega
--    'credito' -> entrega una nota y la factura llega cuando se le paga
--
--    Arrancan todos en 'contado', que es el caso que ya venía
--    funcionando. Los días de crédito cuentan desde la recepción.
-- ---------------------------------------------------------------------
ALTER TABLE proveedores
  ADD COLUMN IF NOT EXISTS metodo_pago varchar(10) NOT NULL DEFAULT 'contado';
ALTER TABLE proveedores
  ADD COLUMN IF NOT EXISTS dias_credito integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_proveedores_metodo_pago') THEN
    ALTER TABLE proveedores ADD CONSTRAINT ck_proveedores_metodo_pago
      CHECK (metodo_pago IN ('contado', 'credito'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_proveedores_dias_credito') THEN
    ALTER TABLE proveedores ADD CONSTRAINT ck_proveedores_dias_credito
      CHECK (dias_credito >= 0 AND dias_credito <= 365);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. La deuda de una recepción a crédito
--
--    monto_nota_usd lo escribe quien recibe, leyéndolo de la nota de
--    entrega que le dejan en la mano. Admite nulo porque las
--    recepciones anteriores a esto no lo tienen; que sea obligatorio
--    cuando la entrega es a crédito lo exige la aplicación.
--
--    vence_el se calcula al recibir: fecha de recepción más los días de
--    crédito del proveedor.
-- ---------------------------------------------------------------------
ALTER TABLE entradas_mercancia ADD COLUMN IF NOT EXISTS a_credito boolean NOT NULL DEFAULT FALSE;
ALTER TABLE entradas_mercancia ADD COLUMN IF NOT EXISTS monto_nota_usd numeric(14,2);
ALTER TABLE entradas_mercancia ADD COLUMN IF NOT EXISTS vence_el date;
ALTER TABLE entradas_mercancia ADD COLUMN IF NOT EXISTS pagado_en timestamptz;
ALTER TABLE entradas_mercancia ADD COLUMN IF NOT EXISTS pagado_por integer REFERENCES usuarios (id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mercancia_monto_nota') THEN
    ALTER TABLE entradas_mercancia ADD CONSTRAINT ck_mercancia_monto_nota
      CHECK (monto_nota_usd IS NULL OR monto_nota_usd >= 0);
  END IF;
  -- Sólo una entrega a crédito puede quedar pagada: lo de contado se
  -- paga en el acto y no pasa por esta cuenta.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mercancia_pago_solo_credito') THEN
    ALTER TABLE entradas_mercancia ADD CONSTRAINT ck_mercancia_pago_solo_credito
      CHECK (pagado_en IS NULL OR a_credito);
  END IF;
END $$;

-- Para la alerta de pedidos por pagar: lo que está a crédito, sin pagar
-- y sin anular, ordenado por el que vence primero.
CREATE INDEX IF NOT EXISTS ix_mercancia_por_pagar
  ON entradas_mercancia (vence_el)
  WHERE a_credito AND pagado_en IS NULL AND NOT anulado;

-- ---------------------------------------------------------------------
-- 3. El proveedor, obligatorio en las solicitudes de mercancía
--
--    Sin proveedor, al recibir la solicitud el sistema no sabe de quién
--    es y no puede decidir si pedir la foto de la factura ni si la
--    entrega es a crédito. De hecho ni se podía recibir, porque la
--    recepción exige proveedor.
--
--    La restricción se agrega como NOT VALID a propósito: las
--    solicitudes que ya existen sin proveedor se respetan, y la
--    exigencia aplica sólo a las nuevas. A las viejas se les puede
--    elegir el proveedor al momento de recibirlas.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_solicitudes_proveedor_mercancia') THEN
    ALTER TABLE solicitudes ADD CONSTRAINT ck_solicitudes_proveedor_mercancia
      CHECK (tipo_solicitud <> 'mercancia' OR proveedor_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Qué puntos del checklist afecta una incidencia
--
--    Hasta ahora los puntos con falla sólo quedaban escritos dentro del
--    texto de la descripción, así que el sistema no podía saber cuáles
--    eran. Con esta lista puede bloquear esos puntos mientras la
--    incidencia siga abierta, y así el motorizado no reporta la misma
--    falla todos los días.
-- ---------------------------------------------------------------------
ALTER TABLE incidencias
  ADD COLUMN IF NOT EXISTS items_afectados jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_incidencias_items_array') THEN
    ALTER TABLE incidencias ADD CONSTRAINT ck_incidencias_items_array
      CHECK (jsonb_typeof(items_afectados) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_incidencias_moto_abiertas
  ON incidencias (moto_id)
  WHERE estado <> 'cerrada' AND NOT anulado;

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
SELECT nombre, tipo, tipo_factura, metodo_pago, dias_credito
  FROM proveedores ORDER BY nombre;

SELECT 'columnas nuevas' AS comprobacion,
       string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name, column_name) AS valor
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name, column_name) IN (
     ('proveedores', 'metodo_pago'),
     ('proveedores', 'dias_credito'),
     ('entradas_mercancia', 'a_credito'),
     ('entradas_mercancia', 'monto_nota_usd'),
     ('entradas_mercancia', 'vence_el'),
     ('entradas_mercancia', 'pagado_en'),
     ('entradas_mercancia', 'pagado_por'),
     ('incidencias', 'items_afectados'));

SELECT 'solicitudes de mercancia sin proveedor' AS comprobacion,
       count(*)::text AS valor
  FROM solicitudes WHERE tipo_solicitud = 'mercancia' AND proveedor_id IS NULL AND NOT anulado;
