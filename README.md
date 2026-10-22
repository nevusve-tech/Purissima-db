# Purissima Cloud

Gestión interna para recarga de agua y tienda física. PostgreSQL (Supabase) + Node/Express (`pg` crudo, sin ORM) + React/Vite/Tailwind (PWA mobile-first).

```
database/schema.sql   Esquema completo desde cero (borra y recrea)
backend/              API (server.js, package.json, .env.example)
frontend/             Vite + React + Tailwind (src/PurissimaApp.jsx)
render.yaml           Blueprint de despliegue en Render
```

## Paso 1: crear el esquema

Supabase → **SQL Editor** → pegar `database/schema.sql` → **Run**.

> **Ojo:** el script empieza con `DROP TABLE ... CASCADE`. Borra todo lo que haya y deja la base limpia.

Al terminar queda un único usuario:

| Usuario | PIN | Rol |
|---|---|---|
| `Master` | `123456` | admin |

**Cambie ese PIN en el primer ingreso** (👤 → Cambiar PIN). Luego cree a los empleados desde la vista **Accesos** y márqueles los módulos que cada uno puede ver y llenar.

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
| `usuarios` | `modulos_permitidos` (JSONB) define qué formularios ve cada empleado. `intentos_fallidos` y `bloqueado_hasta` sostienen el bloqueo por intentos |
| `motos` | `tipo_modelo`: `sbr_150cc`, `carguera_200cc` u `otro`. CHECK: el km del último aceite nunca supera el kilometraje |
| `checklist_motos` | un único checklist por moto y día, con índice único sobre la fecha local de Caracas |
| `cierres_caja` | un único cierre por fecha. Incluye tasa del día, dólares vendidos, impuestos y costos operativos |
| `solicitudes`, `incidencias` | con estado, tipo y notas del Master, para los reportes operativos |

Las claves primarias son UUID en las tablas de movimiento (checklist, caja, entradas, solicitudes, incidencias) y enteras en las de catálogo (usuarios, motos, proveedores, productos).

## Reglas implementadas

- **Seguridad**: JWT HS256 firmado a mano con `crypto.createHmac` y comparado con `timingSafeEqual`; límite de 10 intentos por IP; bloqueo de 15 minutos por usuario; hash de relleno para igualar tiempos cuando el usuario no existe; payload máximo 50 kb; `trust proxy`; PIN con Bcrypt vía `crypt()` de pgcrypto.
- **Permisos dinámicos**: `modulos_permitidos` se relee de la base en cada petición, nunca del token, así que quitar un permiso surte efecto de inmediato. El menú del frontend se construye desde ese arreglo; el Master añade Reportes, Finanzas y Accesos.
- **Transaccionalidad**: `BEGIN/COMMIT/ROLLBACK` con `FOR UPDATE` en motos, caja y stock. El cierre de caja usa además `pg_advisory_xact_lock` y el índice único por fecha.
- **Contabilidad**: `redondearMoneda` corrige el error de punto flotante IEEE 754. `total_cierre_bs` debe cuadrar al centavo con pago móvil + efectivo + punto, validado en la API y por un CHECK en la base. `total_ingreso_dolar` se calcula en el servidor como `total_cierre_bs / tasa_dolar + dolares_vendidos`. La tasa se guarda con 4 decimales.
- **Checklists**: listas exactas por `tipo_modelo`, validadas en el servidor. Una falla genera automáticamente una incidencia de tipo `moto` con severidad alta y dispara un correo.
- **API pública cerrada**: Supabase expone el esquema `public` por REST con las llaves `anon` y `authenticated`. El esquema activa RLS sin políticas y revoca privilegios a esos roles, así que la única vía de entrada es el backend (que conecta con el rol `postgres` y omite RLS). Sin esto, cualquiera con la llave pública podría leer la caja y los usuarios.
