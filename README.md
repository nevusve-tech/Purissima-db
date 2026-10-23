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
| `migracion_004_tanda3.sql` | subcategorías de mercancía y costos operativos del cierre en dólares |
| `migracion_005_permisos.sql` | funciones especiales por empleado (`permisos_especiales`) |
| `migracion_006_roles.sql` | tabla `roles`: los cargos los crea el Master y cada uno guarda sus permisos |
| `migracion_007_fotos.sql` | almacén privado de fotos, las tres del checklist de motos y la de la factura |
| `migracion_009_credito.sql` | proveedores a crédito, proveedor obligatorio en solicitudes de mercancía y puntos del checklist en reparación |
| `migracion_010_arreglo_solicitud.sql` | retira la restricción de la 009 que impedía anular o recibir una solicitud vieja sin proveedor |
| `migracion_008_mejoras.sql` | km exacto del cambio de aceite, combustible, recepción contra solicitud, tipo de factura por proveedor, apertura de tienda y ajustes del Master |

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
5. Para las fotos: `SUPABASE_URL` (Project Settings → Data API → Project URL) y `SUPABASE_SERVICE_KEY` (Project Settings → API Keys → `service_role`, **secreta**). Sin estas dos el sistema funciona igual, sólo que no acepta fotos y lo dice; las tres del checklist dejan de ser obligatorias para no bloquear al motorizado.

El build compila el frontend e instala el backend en los servidores de Render.

## Modelo de datos

| Tabla | Notas |
|---|---|
| `roles` | Los cargos del equipo, creados por el Master. Cada uno es un **perfil**: guarda su `nombre` y, dentro, los `modulos_permitidos` y `permisos_especiales` que trae. `es_master` marca al dueño del sistema y `protegido` impide editarlo o borrarlo: sólo `admin` tiene ambos, y no se conceden desde la aplicación. `usuarios.rol` es una llave foránea contra esta tabla, con `ON UPDATE CASCADE` y `ON DELETE RESTRICT` |
| `usuarios` | Se entra con `usuario` (único, sin espacios); `nombre` y `apellido` son para mostrar. `modulos_permitidos` (JSONB) define qué formularios ve cada empleado. `estado` vale `activo`, `pausado` o `eliminado`, y un disparador mantiene `activo` en sincronía. `intentos_fallidos` y `bloqueado_hasta` sostienen el bloqueo por intentos |
| `motos` | `tipo_modelo`: `sbr_150cc`, `carguera_200cc` u `otro`. CHECK: el km del último aceite nunca supera el kilometraje |
| `checklist_motos` | un único checklist por moto y día, con índice único sobre la fecha local de Caracas |
| `cierres_caja` | un único cierre por fecha. Incluye tasa del día, dólares vendidos, impuestos y costos operativos |
| `productos` | `empaquetado` (`caja`, `gavera` o `brazo`) y `unidades_por_empaquetado`: los pedidos se hacen por bulto, no por unidad suelta. `subcategoria` (`bebidas`, `snacks`, `artesanales`, `insumos_agua`) es obligatoria cuando la categoría es mercancía |
| `solicitudes`, `incidencias` | con estado, tipo y notas del Master, para los reportes operativos |
| los seis registros | `anulado`, `anulado_por`, `anulado_en` y `motivo_anulacion`. Los índices únicos de checklist y caja son **parciales** (`WHERE NOT anulado`), así que anular libera el día |

Las claves primarias son UUID en las tablas de movimiento (checklist, caja, entradas, solicitudes, incidencias) y enteras en las de catálogo (usuarios, motos, proveedores, productos).

## Reglas implementadas

- **Seguridad**: JWT HS256 firmado a mano con `crypto.createHmac` y comparado con `timingSafeEqual`; límite de 10 intentos por IP; bloqueo de 15 minutos por usuario; hash de relleno para igualar tiempos cuando el usuario no existe; payload máximo 50 kb; `trust proxy`; PIN con Bcrypt vía `crypt()` de pgcrypto.
- **Cargos como perfiles**: el Master crea los roles que necesite desde Accesos y cada uno guarda sus permisos. Al asignarle un rol a alguien, esa persona **hereda** lo que el rol trae; encima se le puede marcar algo extra que sólo tenga ella. El permiso efectivo es la **suma** de los dos, recalculada en cada petición: editar un rol cambia de inmediato a todos los que lo tengan. La clave interna se deriva del nombre (“Gerente de Recursos Humanos” → `gerente_de_recursos_humanos`), así que el Master sólo escribe el nombre. Un rol que alguien tenga asignado no se puede borrar.
- **Permisos en dos niveles**, releídos de la base en cada petición y nunca del token, así que quitar uno surte efecto de inmediato:
  - `modulos_permitidos` — qué formularios puede llenar. El menú del frontend se construye desde ese arreglo.
  - `permisos_especiales` — funciones que antes eran sólo del Master, concedidas una a una. Ocho de **ver** (`ver_reportes`, `ver_reporte_motos`, `ver_finanzas`, `ver_accesos`, `ver_apertura_diaria`, `ver_pedidos_credito`, `ver_de_todos`, `ver_anulados`) y ocho de **hacer** (`anular_registros`, `gestionar_empleados`, `gestionar_motos`, `editar_catalogo`, `eliminar_catalogo`, `resolver_solicitudes`, `resolver_incidencias`, `corregir_caja`). El rol `admin` las tiene todas implícitamente.
- **Contra la escalada de privilegios**: conceder permisos (`/permisos` y `/especiales`) y administrar roles (`/api/roles`) siguen atados al nivel Master y no se delegan en ninguna función, porque quien pudiera concederlos —o armarse un rol con todo— se concedería todo. Los roles que crea el Master nunca son de nivel Master. Además, nadie que no sea Master puede crear una cuenta de Master ni tocar una existente: sin eso, alguien con "gestionar empleados" podría cambiarle el PIN al Master y quedarse con el sistema. Y **nadie puede asignar un cargo que conceda más de lo que él mismo tiene**: quien tuviera "gestionar empleados" podría crear una cuenta con un cargo más poderoso que el suyo y entrar con ella, que no es escalar por encima del Master pero sí por encima de sí mismo.
- **Transaccionalidad**: `BEGIN/COMMIT/ROLLBACK` con `FOR UPDATE` en motos, caja y stock. El cierre de caja usa además `pg_advisory_xact_lock` y el índice único por fecha.
- **Contabilidad**: `redondearMoneda` corrige el error de punto flotante IEEE 754. `total_cierre_bs` debe cuadrar al centavo con pago móvil + efectivo + punto, validado en la API y por un CHECK en la base. `total_ingreso_dolar` se calcula en el servidor como `total_cierre_bs / tasa_dolar`. Los costos operativos se escriben en dólares y su equivalente en bolívares (`USD × tasa`) es lo que resta al neto. La tasa se guarda con 4 decimales.
- **Proveedores por rubro**: los de agua sólo aparecen al registrar o pedir agua, los de mercancía sólo en mercancía, y los marcados como "ambos" en las dos.
- **Checklists**: listas exactas por `tipo_modelo`, validadas en el servidor. Una falla genera automáticamente una incidencia de tipo `moto` con severidad alta y dispara un correo.
- **Reporte de motos** (solo Master): historial por moto de checklists, cambios de aceite e incidencias, con un aviso al entrar si hay incidencias sin cerrar, puntos marcados como negativos en los últimos 30 días o el cambio de aceite vencido (umbral `KM_AVISO_ACEITE`, por defecto 3000 km).
- **Cuentas**: el Master puede editar los datos de un empleado, pausarlo (sin acceso temporal) o quitarle el acceso de forma permanente. En ningún caso se borra su historial de gestión.
- **Anulación** (solo Master): un registro mal hecho no se borra. Se marca como anulado con quién, cuándo y por qué; deja de contar en los totales y libera el día o la fecha para rehacerlo. Aplica a checklists, cierres de caja, entradas de agua y mercancía, solicitudes e incidencias. Si al anular un checklist el kilometraje quedó mal, se corrige en la ficha de la moto, dentro del reporte de motos.
- **Solicitudes separadas**: "del negocio" (insumos generales, mantenimiento, permisos) y "de productos" (mercancía, agua), cada una con su propio permiso. Las de mercancía se arman eligiendo productos del catálogo e indicando cuántos bultos; las de agua piden litraje y proveedor. En ambas se puede dar de alta un producto o un proveedor sin salir de la pantalla.
- **Apertura de la tienda**: una fila por día en `aperturas_tienda`, con la hora que pone el servidor (no se escribe a mano). Sin apertura no se puede cerrar la caja de ese día, porque la apertura es lo que le dice al sistema que la tienda trabajó y de eso dependen todos los promedios. Un día puede estar `abierta`, `cerrada` a propósito con su motivo, o **sin registrar**: lo último sólo es un problema si era día laborable, y entonces el sistema lo señala. Los días que no se espera abrir salen de los ajustes (de fábrica, lunes a sábado). El Master puede corregir una hora mal registrada: la original se conserva en `hora_original` y la corrección queda firmada.
- **Promedios de facturación**: el promedio diario divide entre los **días que la tienda abrió**, no entre los días del calendario, porque un domingo cerrado no es un día flojo sino un día que no existió. Se cuentan como días operados los que tengan apertura marcada o cierre de caja, unidos sin repetir: lo segundo hace que el cálculo funcione hacia atrás, antes de que existiera el registro de aperturas, y que un olvido de marcar la apertura no borre un día que sí trabajó. Las cifras principales van en **dólares**, que es lo único comparable entre periodos: en bolívares, una tasa que se movió hace parecer que el negocio creció cuando vendió lo mismo. La semana va de lunes a domingo y la semana en curso no entra a los promedios, porque todavía no terminó.
- **Cambio de aceite**: el motorizado escribe el kilometraje **al momento del cambio**, que puede ser igual o mayor al del arranque del día pero nunca menor. Ese número es la marca desde la cual se cuentan los kilómetros hasta el próximo, y antes se usaba el del arranque, que quedaba corto. El umbral y la anticipación del aviso salen de los ajustes (de fábrica, 1.500 km y 200 de aviso). El kilometraje de una moto nunca retrocede: el odómetro queda en el mayor de los números conocidos y uno menor al último registrado se rechaza.
- **Combustible**: `combustible_motos` guarda litros, monto en bolívares y método de pago (transferencia, pago móvil o tarjeta de débito), con la fecha automática. Lo registra quien tenga la función "Reporte de motos", porque el que echa gasolina es el motorizado. Se anula como cualquier otro registro y no entra a los costos operativos del cierre de caja.
- **Recepción contra solicitud**: al recibir mercancía se puede elegir una solicitud pendiente y marcar producto por producto si llegó completo, si llegó otra cantidad o si no llegó. Lo que no llegó entra con cantidad cero: queda constancia de que se pidió y no vino, y no suma al stock. Una solicitud llega en una sola entrega y queda `completada`; si la recepción se anula, la solicitud vuelve a `pendiente` y puede recibirse de nuevo (lo garantiza un índice único parcial sobre `solicitud_id` con `WHERE NOT anulado`). El método manual de cargar productos a mano queda intacto.
- **Tipo de factura por proveedor**: `proveedores.tipo_factura` vale `fisica`, `digital` o `ambas`, y decide si la foto de la factura es obligatoria al recibir. Es una característica del proveedor y no una decisión de quien recibe: dejarlo a su criterio abriría la salida de marcar "digital" el día que se pierda el papel, que es justo el día en que el respaldo hace falta. Todos arrancan en `fisica`, que es el caso que exige respaldo, para que nadie quede sin foto por omisión.
- **Ajustes del Master**: la tabla `configuracion` guarda los días que se espera abrir, cada cuántos kilómetros toca el aceite y con cuánta anticipación avisa. Antes estaban escritos en el código y cambiarlos exigía un despliegue. Se leen con una caché de veinte segundos, para no consultar la base en cada petición pero que un cambio surta efecto casi de inmediato.
- **Proveedores a crédito**: `proveedores.metodo_pago` vale `contado` o `credito`, con sus `dias_credito`. Un proveedor a crédito no entrega factura al recibir, sino una nota de entrega, así que no se le puede pedir la foto: en su lugar quien recibe anota el monto de esa nota **en dólares** y el pedido queda en «pedidos por pagar» con su vencimiento, contado desde la recepción. La foto se pide el día que se le paga, que es cuando el proveedor por fin entrega la factura: el respaldo no se pierde, sólo se aplaza hasta que el papel exista. El monto va en dólares aunque se pague en bolívares, porque una deuda a plazo en bolívares no significa nada: lo que se debe en términos reales cambia con la tasa. **Nada de esto entra a la contabilidad**: ni a finanzas, ni a los costos operativos, ni a los promedios. Verlo exige la función `ver_pedidos_credito`, para que no lo tenga delante todo el que recibe mercancía.
- **Puntos del checklist en reparación**: una incidencia de moto guarda en `items_afectados` qué puntos reportó. Mientras no se cierre, esos puntos salen bloqueados en el checklist y se arrastran como malos sin generar una incidencia nueva. Antes el motorizado podía reportar la misma falla todos los días, acumulando incidencias duplicadas de lo mismo.
- **Campos pensados para un teléfono**: el teclado numérico de un móvil no trae punto decimal ni dos puntos, así que los montos se escriben como en una caja registradora —se teclean dígitos y los centavos se llenan primero: `12345` es `123,45`— y la hora se escribe `0815` y se muestra `08:15`. Los formularios no se envían incompletos: el botón queda inhabilitado y dice qué falta (*«Falta el proveedor»*), en vez de dejar que el navegador saque su globo en inglés.
- **Fotos**: no viven en la base (una pesa mil veces más que una fila), sino en el almacén de archivos de Supabase, en el bucket `fotos`, que es **privado**. En la base queda sólo la ruta. El teléfono comprime antes de subir: 1600 px de lado largo y la calidad baja por pasos hasta que la imagen entra en unos 200 kB, así que una foto de 6 MB llega como 200 kB y sube rápido con señal móvil. Se pide la orientación `from-image` para que una foto tomada de lado no salga acostada. El cuerpo viaja como imagen cruda y no como JSON, para no cargar con el 33 % que agregaría codificarla en texto; `express.json` sólo mira las peticiones `application/json`, así que el límite de 50 kb del resto de la API queda intacto y las fotos tienen el suyo de 2 MB. El tipo real se deduce de los primeros bytes y no de la cabecera del navegador, de modo que nadie sube un archivo cualquiera diciendo que es una imagen. Para ver una foto hay que pedirle al backend un enlace firmado que caduca en una hora: no se puede abrir adivinando la dirección. Las rutas se acotan tanto en el backend como con un CHECK en la base, que rechaza mayúsculas, rutas absolutas y cualquier `..`.
- **Checklist con fotos obligatorias**: tablero (que se lea el kilometraje), frontal y contrapicado trasero. Se exigen sólo cuando el almacén está configurado; si faltan las variables de entorno, el checklist se guarda sin fotos y lo advierte, porque es peor dejar al motorizado sin poder registrar. Los checklists anteriores a esto siguen siendo válidos sin fotos.
- **API pública cerrada**: Supabase expone el esquema `public` por REST con las llaves `anon` y `authenticated`. El esquema activa RLS sin políticas y revoca privilegios a esos roles, así que la única vía de entrada es el backend (que conecta con el rol `postgres` y omite RLS). Sin esto, cualquiera con la llave pública podría leer la caja y los usuarios.
