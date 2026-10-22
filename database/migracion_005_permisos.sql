-- =====================================================================
-- Purissima Cloud - Migración 005: permisos especiales
--
-- Hasta ahora había un solo nivel de permiso: qué formularios podía
-- llenar cada empleado (modulos_permitidos). Todo lo demás era del
-- Master y de nadie más.
--
-- Esta migración agrega un segundo nivel: funciones que antes eran
-- exclusivas del Master y ahora se pueden conceder una por una.
-- Se dividen en dos grupos:
--
--   VER    ver_reportes, ver_reporte_motos, ver_finanzas, ver_accesos,
--          ver_de_todos, ver_anulados
--   HACER  anular_registros, gestionar_empleados, gestionar_motos,
--          editar_catalogo, eliminar_catalogo, resolver_solicitudes,
--          resolver_incidencias, corregir_caja
--
-- El Master (rol = 'admin') las tiene todas siempre, sin necesidad de
-- que figuren en la lista.
--
-- IMPORTANTE: conceder permisos NO es uno de estos permisos. Sigue
-- siendo exclusivo del rol 'admin', para que nadie pueda ampliarse a sí
-- mismo el acceso.
--
-- Es idempotente y ADITIVA: no borra nada.
-- =====================================================================

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permisos_especiales jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_usuarios_permisos_array') THEN
    ALTER TABLE usuarios ADD CONSTRAINT ck_usuarios_permisos_array
      CHECK (jsonb_typeof(permisos_especiales) = 'array');
  END IF;
END $$;

-- Nadie empieza con permisos especiales: el Master los concede uno a uno
-- desde la vista "Accesos". El propio Master no los necesita en la lista.

-- ---------------------------------------------------------------------
-- Comprobación
-- ---------------------------------------------------------------------
SELECT usuario, nombre, rol, modulos_permitidos, permisos_especiales
  FROM usuarios ORDER BY id;
