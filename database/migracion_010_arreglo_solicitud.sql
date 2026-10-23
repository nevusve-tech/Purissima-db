-- =====================================================================
-- Purissima Cloud - Migración 010: quitar la restricción que bloqueaba
-- las solicitudes viejas
--
-- QUÉ PASÓ
-- La migración 009 agregó una restricción para exigir el proveedor en
-- las solicitudes de mercancía, y la marcó NOT VALID para que las
-- solicitudes anteriores —hechas cuando el proveedor era opcional— se
-- respetaran.
--
-- Eso fue un error de mi parte. NOT VALID no perdona una fila para
-- siempre: sólo evita revisar las filas existentes EN EL MOMENTO de
-- crear la restricción. Después, cualquier UPDATE de una de esas filas
-- vuelve a pasar por la revisión y falla.
--
-- Resultado: la solicitud vieja sin proveedor no se podía anular (es un
-- UPDATE) ni recibir (al recibirla se le marca el estado, que también es
-- un UPDATE). El empleado veía "los datos no cumplen las reglas de
-- validación" sin ninguna pista de por qué.
--
-- LA CORRECCIÓN
-- Se retira la restricción. Que el proveedor sea obligatorio al crear una
-- solicitud de mercancía lo exige el backend, que es donde corresponde:
-- ahí se puede dar un mensaje claro y distinguir una solicitud nueva de
-- una vieja. La base no gana nada repitiendo esa regla y en cambio
-- inutiliza registros que ya existían.
--
-- No se pierde nada: las solicitudes nuevas siguen sin poder crearse sin
-- proveedor, y las viejas vuelven a poder anularse y recibirse. Al
-- recibir una vieja, el sistema pide de qué proveedor llegó.
-- =====================================================================

ALTER TABLE solicitudes DROP CONSTRAINT IF EXISTS ck_solicitudes_proveedor_mercancia;

-- ---------------------------------------------------------------------
-- Comprobación: debe decir que ya no existe, y la solicitud vieja debe
-- poder actualizarse.
-- ---------------------------------------------------------------------
SELECT CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'ck_solicitudes_proveedor_mercancia'
       ) THEN 'TODAVIA EXISTE (algo salió mal)'
         ELSE 'Restricción retirada correctamente'
       END AS resultado;

SELECT id, titulo, estado, proveedor_id,
       CASE WHEN proveedor_id IS NULL
            THEN 'sin proveedor: al recibirla el sistema lo pedirá'
            ELSE 'con proveedor' END AS nota
  FROM solicitudes
 WHERE tipo_solicitud = 'mercancia' AND NOT anulado
 ORDER BY fecha_hora DESC;
