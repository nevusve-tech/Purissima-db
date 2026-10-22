-- =====================================================================
-- Purissima Cloud - Migración 007: fotos
--
-- Agrega las fotos que pediste:
--   * la foto de la factura al recibir mercancía
--   * las tres del checklist de motos: tablero, frontal y contrapicado
--     trasero
--
-- DÓNDE VIVEN LAS FOTOS
-- No en la base de datos. Una foto pesa mil veces más que una fila, y la
-- base del plan gratuito tiene 500 MB que conviene dejar para los datos.
-- Las fotos van al almacén de archivos de Supabase (Storage), que tiene
-- su propio gigabyte aparte. En la base sólo se guarda la RUTA del
-- archivo, que es un texto corto.
--
-- El almacén se crea PRIVADO: nadie puede abrir una foto con sólo
-- adivinar su dirección. El backend firma un enlace temporal cada vez
-- que alguien autorizado necesita verla.
--
-- COLUMNAS QUE SE REUTILIZAN
-- El esquema original ya traía dos columnas de foto, pensadas para pegar
-- a mano un enlace de otro sitio, y el sistema nunca las llegó a usar:
--
--   entradas_mercancia.foto_factura_url  -> la factura
--   checklist_motos.foto_falla_url       -> la foto de la falla
--
-- Se aprovechan esas mismas en vez de crear otras al lado, para no
-- terminar con dos columnas para lo mismo. Lo único que hace falta es
-- ampliar su restricción: exigía que el valor empezara por http:// o
-- https://, y ahora también puede ser una ruta del almacén, que no es
-- una dirección web. Lo que ya estuviera guardado sigue siendo válido.
--
-- Sólo son nuevas las tres del checklist, que antes no existían.
--
-- QUÉ NO CAMBIA
--   * Los checklists y las entradas ya guardados no se tocan y se
--     siguen viendo igual, sin foto.
--   * Las columnas aceptan nulo, así que nada falla mientras el almacén
--     no esté configurado. Que las tres fotos del checklist sean
--     obligatorias lo exige la aplicación, no la base: así lo viejo
--     sigue siendo válido y lo nuevo se pide completo.
--
-- Es idempotente y ADITIVA: no borra nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. El almacén de fotos, privado y sólo para imágenes
--
--    2 MB por archivo es un techo de seguridad con mucho margen: el
--    teléfono comprime a unos 200 KB antes de subir.
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('fotos', 'fotos', false, 2097152, ARRAY['image/jpeg', 'image/webp', 'image/png'])
ON CONFLICT (id) DO NOTHING;

-- Si ya existía de una corrida anterior, se asegura que quede privado.
UPDATE storage.buckets
   SET public = false,
       file_size_limit = 2097152,
       allowed_mime_types = ARRAY['image/jpeg', 'image/webp', 'image/png']
 WHERE id = 'fotos'
   AND (public IS DISTINCT FROM false OR file_size_limit IS DISTINCT FROM 2097152);

-- ---------------------------------------------------------------------
-- 2. Las tres fotos nuevas del checklist de motos
--
--    Se guarda la ruta dentro del almacén, no una dirección web:
--    motos/<fecha>/tablero-<aleatorio>.jpg
-- ---------------------------------------------------------------------
ALTER TABLE checklist_motos ADD COLUMN IF NOT EXISTS foto_tablero text;
ALTER TABLE checklist_motos ADD COLUMN IF NOT EXISTS foto_frontal text;
ALTER TABLE checklist_motos ADD COLUMN IF NOT EXISTS foto_trasera text;

-- ---------------------------------------------------------------------
-- 3. Ampliar las restricciones de las dos columnas que ya existían
--
--    Se buscan por la columna a la que se aplican, no por su nombre,
--    porque el nombre lo puso Postgres solo.
--
--    La ruta se acota a propósito: sólo minúsculas, números y unos pocos
--    signos, y nunca ".." en medio. Así la base rechaza por su cuenta un
--    intento de salirse de su carpeta, además de lo que valida el
--    backend.
--
--    El tope de repetición es 250 y no más: Postgres no admite conteos
--    por encima de 255 en una expresión regular.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  objetivo record;
  n_col    smallint;
  c        record;
BEGIN
  FOR objetivo IN
    SELECT * FROM (VALUES ('checklist_motos', 'foto_falla_url'),
                          ('entradas_mercancia', 'foto_factura_url')) AS t(tabla, columna)
  LOOP
    SELECT attnum INTO n_col FROM pg_attribute
      WHERE attrelid = objetivo.tabla::regclass
        AND attname = objetivo.columna AND NOT attisdropped;

    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = objetivo.tabla::regclass
                AND contype = 'c'
                AND conkey = ARRAY[n_col]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', objetivo.tabla, c.conname);
      RAISE NOTICE 'Ampliada la restricción de %.%: %', objetivo.tabla, objetivo.columna, c.conname;
    END LOOP;
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_checklist_foto_falla') THEN
    ALTER TABLE checklist_motos ADD CONSTRAINT ck_checklist_foto_falla
      CHECK (
        foto_falla_url IS NULL
        OR foto_falla_url ~* '^https?://'                          -- enlace pegado a mano
        OR (foto_falla_url ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'        -- ruta del almacén
            AND position('..' in foto_falla_url) = 0)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_mercancia_foto_factura') THEN
    ALTER TABLE entradas_mercancia ADD CONSTRAINT ck_mercancia_foto_factura
      CHECK (
        foto_factura_url IS NULL
        OR foto_factura_url ~* '^https?://'
        OR (foto_factura_url ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
            AND position('..' in foto_factura_url) = 0)
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Las tres fotos nuevas sólo admiten rutas del almacén
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_checklist_rutas_fotos') THEN
    ALTER TABLE checklist_motos ADD CONSTRAINT ck_checklist_rutas_fotos
      CHECK (
        (foto_tablero IS NULL OR (foto_tablero ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                  AND position('..' in foto_tablero) = 0))
        AND (foto_frontal IS NULL OR (foto_frontal ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                  AND position('..' in foto_frontal) = 0))
        AND (foto_trasera IS NULL OR (foto_trasera ~ '^[a-z0-9][a-z0-9/_.-]{3,250}$'
                                  AND position('..' in foto_trasera) = 0))
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
SELECT id AS almacen, public AS es_publico,
       file_size_limit AS limite_bytes, allowed_mime_types AS tipos
  FROM storage.buckets WHERE id = 'fotos';

SELECT table_name AS tabla, column_name AS columna
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name LIKE 'foto%'
 ORDER BY table_name, column_name;

SELECT conrelid::regclass AS tabla, conname AS restriccion
  FROM pg_constraint
 WHERE conname IN ('ck_checklist_foto_falla', 'ck_mercancia_foto_factura',
                   'ck_checklist_rutas_fotos')
 ORDER BY 1, 2;
