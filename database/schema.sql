-- Habilitar pgcrypto para hashing seguro de PINs (Bcrypt)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Forzar zona horaria operativa para que CURRENT_DATE refleje la hora local y no UTC
ALTER DATABASE postgres SET timezone TO 'America/Caracas';

-- =========================================================================
-- 1. Tabla de Usuarios (Con hashing real y protección contra fuerza bruta)
-- =========================================================================
CREATE TABLE usuarios (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    rol VARCHAR(50) NOT NULL CHECK (rol IN ('motorizados', 'tienda', 'admin')),
    pin_hash VARCHAR(255) NOT NULL,
    intentos_fallidos SMALLINT NOT NULL DEFAULT 0 CHECK (intentos_fallidos >= 0),
    bloqueado_hasta TIMESTAMPTZ,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Precargar usuarios con PINs hasheados usando Bcrypt (PINs: 1234, 5678, 0000 -> CAMBIAR EN PRODUCCIÓN)
INSERT INTO usuarios (nombre, rol, pin_hash) VALUES 
('Gerente de Motorizados', 'motorizados', crypt('1234', gen_salt('bf', 10))),
('Gerente de Tienda', 'tienda', crypt('5678', gen_salt('bf', 10))),
('Administrador General', 'admin', crypt('0000', gen_salt('bf', 10)));

-- =========================================================================
-- 2. Tabla de Motos (Flota)
-- =========================================================================
CREATE TABLE motos (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    color VARCHAR(50) NOT NULL,
    placa VARCHAR(50) NOT NULL UNIQUE,
    tipo_modelo VARCHAR(50) NOT NULL CHECK (tipo_modelo IN ('carguera_200cc', 'sbr_150cc', 'otro')),
    ultimo_kilometraje INT NOT NULL DEFAULT 0 CHECK (ultimo_kilometraje >= 0),
    ultimo_cambio_aceite_km INT NOT NULL DEFAULT 0 CHECK (ultimo_cambio_aceite_km >= 0),
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_aceite_vs_kilometraje CHECK (ultimo_cambio_aceite_km <= ultimo_kilometraje)
);

INSERT INTO motos (nombre, color, placa, tipo_modelo, ultimo_kilometraje, ultimo_cambio_aceite_km) VALUES 
('Moto 1 - Bera Carguera 200cc', 'Azul', 'POR-DEFINIR-1', 'carguera_200cc', 0, 0),
('Moto 2 - Bera SBR 150cc', 'Gris', 'POR-DEFINIR-2', 'sbr_150cc', 0, 0);

-- =========================================================================
-- 3. Tabla de Checklist de Motos
-- =========================================================================
CREATE TABLE checklist_motos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    moto_id INT NOT NULL REFERENCES motos(id) ON DELETE RESTRICT,
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    se_uso_hoy BOOLEAN NOT NULL,
    kilometraje_inicial INT CHECK (kilometraje_inicial >= 0),
    cambio_aceite_realizado BOOLEAN NOT NULL DEFAULT FALSE,
    detalles_items JSONB CHECK (detalles_items IS NULL OR jsonb_typeof(detalles_items) IN ('object', 'array')),
    tiene_falla BOOLEAN NOT NULL DEFAULT FALSE,
    observacion_falla TEXT,
    foto_falla_url TEXT CHECK (foto_falla_url IS NULL OR foto_falla_url ~* '^https?://'),
    CONSTRAINT chk_uso_requiere_km CHECK (NOT se_uso_hoy OR kilometraje_inicial IS NOT NULL),
    CONSTRAINT chk_falla_requiere_observacion CHECK (NOT tiene_falla OR (observacion_falla IS NOT NULL AND length(trim(observacion_falla)) > 0))
);

-- =========================================================================
-- 4. Tabla de Proveedores
-- =========================================================================
CREATE TABLE proveedores (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL UNIQUE,
    tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('agua', 'mercancia', 'ambos')),
    contacto VARCHAR(100),
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- =========================================================================
-- 5. Tabla de Productos
-- =========================================================================
CREATE TABLE productos (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL UNIQUE,
    categoria VARCHAR(50) NOT NULL CHECK (categoria IN ('mercancia', 'insumo_tienda', 'agua')),
    proveedor_habitual_id INT REFERENCES proveedores(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- =========================================================================
-- 6. Bitácora de Llegada de Agua
-- =========================================================================
CREATE TABLE entradas_agua (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    proveedor_id INT NOT NULL REFERENCES proveedores(id) ON DELETE RESTRICT,
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    litraje NUMERIC(10,2) NOT NULL CHECK (litraje > 0),
    observaciones TEXT,
    tiene_incidencia BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT chk_incidencia_agua_obs CHECK (NOT tiene_incidencia OR (observaciones IS NOT NULL AND length(trim(observaciones)) > 0))
);

-- =========================================================================
-- 7. Recepción de Mercancía
-- =========================================================================
CREATE TABLE entradas_mercancia (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    proveedor_id INT NOT NULL REFERENCES proveedores(id) ON DELETE RESTRICT,
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    items_recibidos JSONB NOT NULL CHECK (jsonb_typeof(items_recibidos) IN ('array', 'object')),
    foto_factura_url TEXT CHECK (foto_factura_url IS NULL OR foto_factura_url ~* '^https?://'),
    observaciones TEXT
);

-- =========================================================================
-- 8. Solicitudes Internas
-- =========================================================================
CREATE TABLE solicitudes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tipo_solicitud VARCHAR(50) NOT NULL CHECK (tipo_solicitud IN ('mercancia', 'agua', 'insumos_generales')),
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aprobada', 'en_proceso', 'completada', 'rechazada')),
    detalle_items JSONB NOT NULL CHECK (jsonb_typeof(detalle_items) IN ('array', 'object'))
);

-- =========================================================================
-- 9. Cierres de Caja Financieros (Con Idempotencia de Fecha única Cloud)
-- =========================================================================
CREATE TABLE cierres_caja (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pago_movil_bs NUMERIC(14,2) NOT NULL CHECK (pago_movil_bs >= 0),
    efectivo_bs NUMERIC(14,2) NOT NULL CHECK (efectivo_bs >= 0),
    punto_venta_bs NUMERIC(14,2) NOT NULL CHECK (punto_venta_bs >= 0),
    total_cierre_bs NUMERIC(14,2) NOT NULL CHECK (total_cierre_bs >= 0),
    tasa_dolar NUMERIC(12,4) NOT NULL CHECK (tasa_dolar > 0),
    dolares_vendidos NUMERIC(12,2) NOT NULL CHECK (dolares_vendidos >= 0),
    total_ingreso_dolar NUMERIC(12,2) NOT NULL CHECK (total_ingreso_dolar >= 0),
    impuestos_fiscales_bs NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (impuestos_fiscales_bs >= 0),
    costos_operativos_bs NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (costos_operativos_bs >= 0),
    CONSTRAINT chk_cuadre_caja_bs CHECK (total_cierre_bs = (pago_movil_bs + efectivo_bs + punto_venta_bs))
);

-- EVITA DUPLICADOS: Solo permite un cierre de caja por día calendario (Idempotencia Cloud)
CREATE UNIQUE INDEX idx_unico_cierre_por_dia ON cierres_caja (fecha);

-- =========================================================================
-- 10. Incidencias
-- =========================================================================
CREATE TABLE incidencias (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('financiera_caja', 'cliente', 'operativa_tienda')),
    cierre_caja_id UUID REFERENCES cierres_caja(id) ON DELETE RESTRICT,
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    descripcion TEXT NOT NULL CHECK (length(trim(descripcion)) > 0),
    CONSTRAINT chk_incidencia_financiera_requiere_cierre CHECK (tipo <> 'financiera_caja' OR cierre_caja_id IS NOT NULL)
);

-- =========================================================================
-- 11. Índices de Rendimiento Cloud
-- =========================================================================
CREATE INDEX idx_checklist_moto_fecha ON checklist_motos(moto_id, fecha DESC);
CREATE INDEX idx_checklist_usuario ON checklist_motos(usuario_id);
CREATE INDEX idx_entradas_agua_fecha ON entradas_agua(fecha_hora DESC);
CREATE INDEX idx_entradas_mercancia_fecha ON entradas_mercancia(fecha_hora DESC);
CREATE INDEX idx_solicitudes_estado_fecha ON solicitudes(estado, fecha_hora DESC);
CREATE INDEX idx_cierres_caja_fecha ON cierres_caja(fecha DESC);
CREATE INDEX idx_incidencias_tipo_fecha ON incidencias(tipo, fecha_hora DESC);