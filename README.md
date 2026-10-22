# Purissima Cloud

Gestión interna para recarga de agua y tienda física. PostgreSQL (Supabase) + Node/Express (`pg` crudo, sin ORM) + React/Vite/Tailwind (PWA mobile-first).

```
database/schema.sql   Esquema completo desde cero (borra y recrea)
backend/              API (server.js, package.json, .env.example)
frontend/             Vite + React + Tailwind (src/PurissimaApp.jsx)
render.yaml           Blueprint de despliegue en Render
```

## Paso 1: crear el esquema

**Instalación nueva:** Supabase → **SQL Editor** → pegar `database/schema.sql` → **Run**.

> **Ojo:** ese script empieza con `DROP TABLE ... CASCADE`. Borra todo lo que haya y deja la base limpia.

Al terminar queda un único usuario: se entra con `Master` y PIN `123456`. **Cambie ese PIN en el primer ingreso** (👤 → Cambiar PIN). Luego cree a los empleados desde la vista **Accesos** y márqueles los módulos que cada uno puede ver y llenar.

**Instalación que ya está en marcha:** aplicar en orden las migraciones de `database/`, que son aditivas e idempotentes y no borran datos:

| Archivo | Qué agrega |
|---|---|
| `migracion_002_tanda1.sql` | `usuario` de ingreso, `apellido` y `estado` en la tabla de usuarios |
| `migracion_003_tanda2.sql` | anulación de reportes, empaquetado de productos, proveedor en solicitudes y permisos de solicitudes separados |

## Paso 2: arranque local

```bash
cd backend && cp .env.example .env     # pegar DATABASE_URL de Supabase y un JWT_SECRET
npm install && npm start               # http://localhost:3000

cd frontend && npm install && npm run dev   # http://localhost:5173 (proxy /api -> :3000)
```

Con `npm run build` en `frontend/`, el backend sirve `frontend/dist` y todo queda en un solo servicio.

## Paso 3: despliegue en Render

1. Subir el repositorio a GitHub.
2. Render → **New → Blueprint** y seleccionar el repo (usa `render.yaml`).
3. Definir `DATABASE_URL` con la cadena de Supabase (se recomienda el *Connection pooler*, puerto 6543). `JWT_SECRET` se genera solo.
4. Opcional, para correos: `ADMIN_EMAIL` y `SMTP_*`, o `RESEND_API_KEY`.

El build compila el frontend e instala el backend en los servidores de Render.

## Modelo de datos

| Tabla | Notas |
|---|---|
| `usuarios` | Se entra con `usuario` (único, sin espacios); `nombre` y `apellido` son para mostrar. `modulos_permitidos` (JSONB) define qué formularios ve cada empleado. `estado` vale `activo`, `pausado` o `eliminado`, y un disparador mantiene `activo` en sincronía. `intentos_fallidos` y `bloqueado_hasta` sostienen el bloqueo por intentos |
| `motos` | `tipo_modelo`: `sbr_150cc`, `carguera_200cc` u `otro`. CHECK: el km del último aceite nunca supera el kilometraje |
| `checklist_motos` | un único checklist por moto y día, con índice único sobre la fecha local de Caracas |
| `cierres_caja` | un único cierre por fecha. Incluye tasa del día, dólares vendidos, impuestos y costos operativos |
| `productos` | `empaquetado` (`caja`, `gavera` o `brazo`) y `unidades_por_empaquetado`: los pedidos se hacen por bulto, no por unidad suelta |
| `solicitudes`, `incidencias` | con estado, tipo y notas del Master, para los reportes operativos |
| los seis registros | `anulado`, `anulado_por`, `anulado_en` y `motivo_anulacion`. Los índices únicos de checklist y caja son **parciales** (`WHERE NOT anulado`), así que anular libera el día |

Las claves primarias son UUID en las tablas de movimiento (checklist, caja, entradas, solicitudes, incidencias) y enteras en las de catálogo (usuarios, motos, proveedores, productos).

## Reglas implementadas

- **Seguridad**: JWT HS256 firmado a mano con `crypto.createHmac` y comparado con `timingSafeEqual`; límite de 10 intentos por IP; bloqueo de 15 minutos por usuario; hash de relleno para igualar tiempos cuando el usuario no existe; payload máximo 50 kb; `trust proxy`; PIN con Bcrypt vía `crypt()` de pgcrypto.
- **Permisos dinámicos**: `modulos_permitidos` se relee de la base en cada petición, nunca del token, así que quitar un permiso surte efecto de inmediato. El menú del frontend se construye desde ese arreglo; el Master añade Reportes, Finanzas y Accesos.
- **Transaccionalidad**: `BEGIN/COMMIT/ROLLBACK` con `FOR UPDATE` en motos, caja y stock. El cierre de caja usa además `pg_advisory_xact_lock` y el índice único por fecha.
- **Contabilidad**: `redondearMoneda` corrige el error de punto flotante IEEE 754. `total_cierre_bs` debe cuadrar al centavo con pago móvil + efectivo + punto, validado en la API y por un CHECK en la base. `total_ingreso_dolar` se calcula en el servidor como `total_cierre_bs / tasa_dolar + dolares_vendidos`. La tasa se guarda con 4 decimales.
- **Checklists**: listas exactas por `tipo_modelo`, validadas en el servidor. Una falla genera automáticamente una incidencia de tipo `moto` con severidad alta y dispara un correo.
- **Reporte de motos** (solo Master): historial por moto de checklists, cambios de aceite e incidencias, con un aviso al entrar si hay incidencias sin cerrar, puntos marcados como negativos en los últimos 30 días o el cambio de aceite vencido (umbral `KM_AVISO_ACEITE`, por defecto 3000 km).
- **Cuentas**: el Master puede editar los datos de un empleado, pausarlo (sin acceso temporal) o quitarle el acceso de forma permanente. En ningún caso se borra su historial de gestión.
- **Anulación** (solo Master): un registro mal hecho no se borra. Se marca como anulado con quién, cuándo y por qué; deja de contar en los totales y libera el día o la fecha para rehacerlo. Aplica a checklists, cierres de caja, entradas de agua y mercancía, solicitudes e incidencias. Si al anular un checklist el kilometraje quedó mal, se corrige en la ficha de la moto, dentro del reporte de motos.
- **Solicitudes separadas**: "del negocio" (insumos generales, mantenimiento, permisos) y "de productos" (mercancía, agua), cada una con su propio permiso. Las de mercancía se arman eligiendo productos del catálogo e indicando cuántos bultos; las de agua piden litraje y proveedor. En ambas se puede dar de alta un producto o un proveedor sin salir de la pantalla.
- **API pública cerrada**: Supabase expone el esquema `public` por REST con las llaves `anon` y `authenticated`. El esquema activa RLS sin políticas y revoca privilegios a esos roles, así que la única vía de entrada es el backend (que conecta con el rol `postgres` y omite RLS). Sin esto, cualquiera con la llave pública podría leer la caja y los usuarios.
