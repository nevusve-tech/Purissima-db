# Notas de trabajo con Simón

Este archivo es para quien retome el proyecto en otra conversación. No es
documentación del sistema: eso está en `README.md`. Esto es cómo trabajar.

## Reglas que puso el dueño del proyecto

**Preguntar antes de cambiar cualquier cosa.** Textual: *"Es muy importante
que las mejoras no impliquen eliminar nada o cambiar nada del código base que
ya tenemos a menos que muy explícitamente te lo pida. Si es así, debes
asegurarte antes. Antes de hacer cualquier cambio de cualquier tipo siempre
debes preguntar."*

Esto incluye borrar una línea que parezca sobrante, renombrar algo, o
"limpiar" código. Si parece que algo debería cambiar, se propone y se espera
respuesta. Las migraciones son **aditivas**: nada de `DROP COLUMN` ni de
reescribir tablas con datos vivos.

**Enlaces directos, siempre.** No describir rutas por el panel ("ve a
Settings, luego a…"). Pasar el enlace que abre exactamente la pantalla que
hace falta. Describir rutas nos costó una tarde entera: él estaba editando
las variables de entorno de otro servicio de Render y ninguno de los dos lo
notó durante cinco intentos.

**Él conoce poco de infraestructura y lo dice sin problema.** Cuando haya que
hacer algo en Supabase o Render, va un paso a paso concreto: dónde hacer clic,
qué copiar, qué pegar. Nada de "configura la variable X".

## Secretos

**Nunca pedir ni aceptar por el chat** la clave `service_role` de Supabase ni
la cadena de conexión de la base. Él las pega directamente en Render. Si hace
falta una captura de una pantalla con secretos, se le pide con esa parte
tapada.

El `SUPABASE_URL` sí es público y se puede manejar con libertad. De hecho se
puede poner desde las herramientas de Render, que **fusionan** las variables
en vez de reemplazarlas (`replace: false`), así que no hay riesgo de borrar
`DATABASE_URL` ni `JWT_SECRET`.

## Orden de despliegue: el SQL va primero

Render despliega solo al recibir un push. Si el código nuevo lee columnas que
la migración todavía no creó, **el sistema se cae para todos** hasta que se
corra el SQL. El chequeo de esquema al arrancar sólo avisa en el registro, no
bloquea el tráfico.

Así que la secuencia es siempre:

1. Escribir la migración y verificarla **en modo lectura** contra la base real
2. Mandarle el archivo y esperar a que la corra
3. Comprobar que se aplicó, también en modo lectura
4. Recién ahí hacer el push

Hay un gancho que insiste en subir los commits pendientes. Cuando el push
rompería el sistema, no se sube: se le explica por qué y se espera.

## Verificar antes de escribir

Dos veces casi metí la pata por suponer en vez de mirar:

- Apunté una migración a `incidencias` cuando la columna estaba en
  `checklist_motos`
- Iba a crear `foto_factura` sin ver que ya existía `foto_factura_url`, sin
  usar, desde el esquema original

Conviene consultar el esquema real (`information_schema`, `pg_constraint`)
antes de escribir una migración, y buscar en el código si la columna ya se usa
en algún lado.

Para probar DDL sin tocar nada: tablas `TEMP`, que desaparecen solas. Para
probar las funciones del backend: extraerlas del archivo real por texto y
correrlas con `node`, en vez de reescribirlas en la prueba.

## Cosas del entorno que conviene saber

**npm no funciona desde este contenedor**: el proxy devuelve 403 para el
registro, así que no se puede instalar nada ni compilar el frontend aquí. La
compilación se verifica dejando que Render la haga. Para revisar la sintaxis:
`node --check` para el backend, y el parser de TypeScript (que está instalado
globalmente) para el JSX.

**Plan gratuito de Render**: el servicio se duerme tras unos 15 minutos sin
uso y tarda unos 40 segundos en despertar. Un despertar **no** es un reinicio:
no vuelve a leer las variables de entorno. Para que lea una variable nueva hay
que desplegar.

**Supabase gratuito**: 500 MB de base, 1 GB de almacén de archivos, y el
proyecto se pausa tras una semana sin actividad.

## Identificadores

- Repositorio: `nevusve-tech/Purissima-db`, rama `main`
- Servicio de Render: `srv-dbcoeq5g1s2s73e0bmag` (`purissima-cloud`)
- Proyecto de Supabase: `akpnummbmragiquaojrs` (`Purissima DB`)

Enlaces directos:

- Sistema: https://purissima-cloud.onrender.com
- Variables: https://dashboard.render.com/web/srv-dbcoeq5g1s2s73e0bmag/env
- Registro: https://dashboard.render.com/web/srv-dbcoeq5g1s2s73e0bmag/logs
- SQL: https://supabase.com/dashboard/project/akpnummbmragiquaojrs/sql/new
- Almacén de fotos: https://supabase.com/dashboard/project/akpnummbmragiquaojrs/storage/buckets/fotos

## Idioma

Todo en español: el código, los comentarios, los mensajes de error que ve el
empleado, los nombres de las columnas y los mensajes de commit. Los mensajes
de error se escriben para que los entienda alguien que está cargando mercancía
con el teléfono en una mano, no para un programador.
