'use strict';
/**
 * Purissima Cloud - API (Node.js + Express + pg crudo, sin ORM)
 *
 * Escrito contra el esquema REAL del proyecto Supabase "Purissima DB":
 *  - ids UUID en checklist_motos, cierres_caja, solicitudes, entradas e incidencias
 *  - checklist_motos.fecha y *.fecha_hora son timestamptz (no date)
 *  - motos.tipo_modelo: 'sbr_150cc' | 'carguera_200cc' | 'otro'
 *  - caja: total_cierre_bs, tasa_dolar, dolares_vendidos, total_ingreso_dolar,
 *          impuestos_fiscales_bs, costos_operativos_bs
 *
 * Requiere la migración database/migracion_001_modulos_y_reportes.sql
 * (agrega usuarios.modulos_permitidos y los campos de reportes).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');
const nodemailer = require('nodemailer');

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const TZ = 'America/Caracas';
const TOKEN_TTL_SEC = Number(process.env.TOKEN_TTL_SEC) || 12 * 60 * 60;
const LOGIN_MAX_INTENTOS = 10;
const LOGIN_VENTANA_MS = 15 * 60 * 1000;
const BLOQUEO_MIN = 15;

let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (IS_PROD) {
    console.error('JWT_SECRET es obligatorio en producción (mínimo 32 caracteres).');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[aviso] JWT_SECRET no definido: se usa un secreto efímero (las sesiones se pierden al reiniciar).');
}

const MODULOS_VALIDOS = Object.freeze([
  'motos', 'caja', 'recepcion', 'solicitudes_negocio', 'solicitudes_productos', 'incidencias',
]);
const ESTADOS_USUARIO = Object.freeze(['activo', 'pausado', 'eliminado']);

/**
 * Funciones que antes eran exclusivas del Master y ahora se conceden una
 * a una. El Master las tiene todas siempre.
 *
 * NO incluye conceder permisos: eso sigue atado al rol 'admin', para que
 * nadie pueda ampliarse a sí mismo el acceso.
 */
const PERMISOS_ESPECIALES = Object.freeze([
  // --- lo que puede VER ---
  { clave: 'ver_reportes', grupo: 'ver', etiqueta: 'Reportes', detalle: 'Histórico de solicitudes e incidencias de todo el equipo' },
  { clave: 'ver_reporte_motos', grupo: 'ver', etiqueta: 'Reporte de motos', detalle: 'Alertas e historial completo de cada moto' },
  { clave: 'ver_finanzas', grupo: 'ver', etiqueta: 'Finanzas', detalle: 'Los totales del negocio' },
  { clave: 'ver_accesos', grupo: 'ver', etiqueta: 'Accesos', detalle: 'La lista de empleados y sus permisos, sin poder cambiarlos' },
  { clave: 'ver_apertura_diaria', grupo: 'ver', etiqueta: 'Apertura del día', detalle: 'Al entrar cada día, si la tienda abrió y a qué hora' },
  { clave: 'ver_pedidos_credito', grupo: 'ver', etiqueta: 'Pedidos por pagar', detalle: 'Lo que se le debe a los proveedores a crédito y cuándo vence' },
  { clave: 'ver_avisos_cierre', grupo: 'ver', etiqueta: 'Avisos de cierre', detalle: 'Cuando un reporte Z no sigue al del cierre anterior' },
  { clave: 'ver_de_todos', grupo: 'ver', etiqueta: 'Registros de todo el equipo', detalle: 'En sus módulos, ver lo de todos y no sólo lo suyo' },
  { clave: 'ver_anulados', grupo: 'ver', etiqueta: 'Registros anulados', detalle: 'Ver también lo que fue anulado' },
  // --- lo que puede HACER ---
  { clave: 'anular_registros', grupo: 'hacer', etiqueta: 'Anular registros', detalle: 'Anular y reactivar lo que se hizo mal' },
  { clave: 'gestionar_empleados', grupo: 'hacer', etiqueta: 'Gestionar empleados', detalle: 'Crear, editar, pausar y cambiar PIN' },
  { clave: 'gestionar_motos', grupo: 'hacer', etiqueta: 'Gestionar motos', detalle: 'Registrar motos y corregir sus datos' },
  { clave: 'editar_catalogo', grupo: 'hacer', etiqueta: 'Editar catálogo', detalle: 'Modificar proveedores y productos' },
  { clave: 'eliminar_catalogo', grupo: 'hacer', etiqueta: 'Eliminar del catálogo', detalle: 'Dar de baja productos y proveedores' },
  { clave: 'resolver_solicitudes', grupo: 'hacer', etiqueta: 'Resolver solicitudes', detalle: 'Cambiar su estado' },
  { clave: 'resolver_incidencias', grupo: 'hacer', etiqueta: 'Resolver incidencias', detalle: 'Cambiar su estado' },
  { clave: 'corregir_caja', grupo: 'hacer', etiqueta: 'Corregir caja', detalle: 'Modificar un cierre hecho o cerrar una fecha pasada' },
]);
const CLAVES_PERMISOS = Object.freeze(PERMISOS_ESPECIALES.map((p) => p.clave));

/* Registros que el Master puede anular, con el nombre de su tabla */
const ANULABLES = Object.freeze({
  checklist: 'checklist_motos',
  caja: 'cierres_caja',
  'entrada-agua': 'entradas_agua',
  'entrada-mercancia': 'entradas_mercancia',
  solicitud: 'solicitudes',
  incidencia: 'incidencias',
  combustible: 'combustible_motos',
});

/* Formas de pagar el combustible */
const METODOS_PAGO_COMBUSTIBLE = Object.freeze(['transferencia', 'pago_movil', 'tarjeta_debito']);

/* Cómo factura un proveedor, y qué implica para la foto de la factura */
const TIPOS_FACTURA = Object.freeze(['fisica', 'digital', 'ambas']);

/*
 * Cómo se le paga a un proveedor.
 *
 * 'contado' -> se paga al recibir y la factura llega con la entrega
 * 'credito' -> deja una nota de entrega y la factura llega al pagarle
 *
 * Un proveedor a crédito no entrega factura al recibir, así que no se le
 * puede pedir la foto: en su lugar se anota cuánto se debe y cuándo
 * vence, y la foto se pide el día que se le paga.
 */
const METODOS_PAGO_PROVEEDOR = Object.freeze(['contado', 'credito']);

/* ------------------------------------------------------------------ */
/* Ajustes que el Master cambia desde la aplicación                    */
/*                                                                     */
/* Antes estaban escritos en el código y cambiarlos exigía un          */
/* despliegue. Ahora viven en la tabla "configuracion".                */
/*                                                                     */
/* dias_apertura usa la numeración ISO de Postgres: 1 es lunes y 7 es  */
/* domingo.                                                            */
/* ------------------------------------------------------------------ */
const AJUSTES_POR_DEFECTO = Object.freeze({
  dias_apertura: [1, 2, 3, 4, 5, 6],
  km_aceite: 1500,
  km_aviso_anticipacion: 200,
});

/*
 * Se guardan en memoria unos segundos para no consultar la base en cada
 * petición, pero poco tiempo: así un cambio del Master surte efecto casi
 * de inmediato sin tener que reiniciar nada.
 */
const AJUSTES_TTL_MS = 20000;
let cacheAjustes = { valores: null, vence: 0 };

async function leerAjustes() {
  if (cacheAjustes.valores && Date.now() < cacheAjustes.vence) return cacheAjustes.valores;
  const valores = { ...AJUSTES_POR_DEFECTO };
  try {
    const { rows } = await pool.query('SELECT clave, valor FROM configuracion');
    for (const r of rows) {
      if (Object.prototype.hasOwnProperty.call(AJUSTES_POR_DEFECTO, r.clave)) valores[r.clave] = r.valor;
    }
  } catch (err) {
    // Si la tabla no existe todavía, se sigue con los valores por defecto
    console.warn('[ajustes] No se pudieron leer, se usan los valores por defecto:', err.message);
  }
  cacheAjustes = { valores, vence: Date.now() + AJUSTES_TTL_MS };
  return valores;
}

const olvidarAjustes = () => { cacheAjustes = { valores: null, vence: 0 }; };

/** ¿Se espera que la tienda abra ese día, según los ajustes? */
function esDiaLaborable(fechaISO, ajustes) {
  // getUTCDay sobre una fecha pura: 0 es domingo, 1 lunes. Se pasa a ISO.
  const dia = new Date(`${fechaISO}T00:00:00Z`).getUTCDay();
  const iso = dia === 0 ? 7 : dia;
  const dias = Array.isArray(ajustes.dias_apertura) ? ajustes.dias_apertura : AJUSTES_POR_DEFECTO.dias_apertura;
  return dias.includes(iso);
}

/* Listas exactas e inmodificables, indexadas por motos.tipo_modelo */
const CHECKLISTS = Object.freeze({
  sbr_150cc: Object.freeze([
    'Nivel de aceite', 'Calidad de aceite', 'Frenos delanteros', 'Frenos traseros',
    'Bomba de freno delantera', 'Tensión de la cadena', 'Lubricación de la cadena',
    'Caucho delantero', 'Caucho trasero', 'Luz delantera (alta y baja)', 'Luces de cruce',
    'Bocina', 'Tablero de instrumentos', 'Soldadura de cajas', 'Tuercas y tornillos',
    'Retrovisores', 'Acelerador', 'Documentación',
  ]),
  carguera_200cc: Object.freeze([
    'Nivel de aceite', 'Calidad de aceite', 'Frenos delanteros', 'Frenos traseros',
    'Freno de estacionamiento', 'Bomba de freno delantero', 'Caucho delantero',
    'Caucho trasero izquierdo', 'Caucho trasero derecho', 'Pernos y tuercas de ruedas traseras',
    'Suspensión trasera (Resortes / Ballestas)', 'Luz delantera (alta y baja)',
    'Luces de cruce y cocuyos traseros', 'Bocina (Corneta)', 'Tablero de instrumentos',
    'Soldadura y estructura de la batea', 'Tuercas y tornillos generales',
    'Espejos retrovisores', 'Acelerador y guayas',
  ]),
  otro: Object.freeze([]),
});
const TIPOS_MOTO = Object.keys(CHECKLISTS);

const TIPOS_SOLICITUD = ['mercancia', 'agua', 'insumos_generales', 'mantenimiento', 'permiso', 'otro'];
/* Las solicitudes van en dos secciones separadas, cada una con su permiso */
const TIPOS_SOLICITUD_PRODUCTOS = ['mercancia', 'agua'];
const TIPOS_SOLICITUD_NEGOCIO = ['insumos_generales', 'mantenimiento', 'permiso', 'otro'];
const moduloDeSolicitud = (tipo) =>
  (TIPOS_SOLICITUD_PRODUCTOS.includes(tipo) ? 'solicitudes_productos' : 'solicitudes_negocio');
const ESTADOS_SOLICITUD = ['pendiente', 'aprobada', 'en_proceso', 'completada', 'rechazada'];
const TIPOS_INCIDENCIA = ['financiera_caja', 'cliente', 'operativa_tienda', 'moto', 'agua', 'seguridad', 'otro'];
const ESTADOS_INCIDENCIA = ['abierta', 'en_revision', 'cerrada'];
const SEVERIDADES = ['baja', 'media', 'alta'];
const TIPOS_PROVEEDOR = ['agua', 'mercancia', 'ambos'];
const CATEGORIAS_PRODUCTO = ['mercancia', 'insumo_tienda', 'agua'];
/* Los productos se piden por bulto, no por unidad suelta */
const EMPAQUETADOS = ['caja', 'gavera', 'brazo'];
/* Subcategorías dentro de "mercancía", para describirla mejor */
const SUBCATEGORIAS = ['bebidas', 'snacks', 'artesanales', 'insumos_agua'];

/* ------------------------------------------------------------------ */
/* Base de datos                                                       */
/* ------------------------------------------------------------------ */
types.setTypeParser(1082, (v) => v); // DATE -> 'YYYY-MM-DD' sin corrimiento de zona
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // NUMERIC -> number
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // BIGINT -> number

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable de entorno DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
// La zona horaria se fija a nivel de base de datos (ALTER DATABASE ... SET timezone),
// así que no hace falta ajustarla en cada conexión. Se comprueba al arrancar.
pool.on('error', (err) => console.error('[pg] error en cliente inactivo:', err.message));

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignorar */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Comprueba que la migración esté aplicada antes de aceptar tráfico. */
const COLUMNAS_REQUERIDAS = [
  ['usuarios', 'modulos_permitidos'],
  ['usuarios', 'usuario'],
  ['usuarios', 'apellido'],
  ['usuarios', 'estado'],
  ['usuarios', 'permisos_especiales'],
  ['roles', 'clave'],
  ['roles', 'es_master'],
  ['configuracion', 'clave'],
  ['aperturas_tienda', 'abierta'],
  ['confirmaciones_apertura', 'confirmado_en'],
  ['combustible_motos', 'litros'],
  ['checklist_motos', 'km_cambio_aceite'],
  ['entradas_mercancia', 'solicitud_id'],
  ['entradas_mercancia', 'factura_digital'],
  ['proveedores', 'tipo_factura'],
  ['proveedores', 'metodo_pago'],
  ['proveedores', 'dias_credito'],
  ['entradas_mercancia', 'a_credito'],
  ['entradas_mercancia', 'monto_nota_usd'],
  ['entradas_mercancia', 'vence_el'],
  ['incidencias', 'items_afectados'],
  ['checklist_motos', 'foto_tablero'],
  ['checklist_motos', 'foto_frontal'],
  ['checklist_motos', 'foto_trasera'],
  ['solicitudes', 'titulo'],
  ['solicitudes', 'descripcion'],
  ['solicitudes', 'notas_admin'],
  ['incidencias', 'estado'],
  ['incidencias', 'severidad'],
  ['incidencias', 'titulo'],
  ['incidencias', 'moto_id'],
  ['incidencias', 'notas_admin'],
  ['cierres_caja', 'observacion'],
  ['productos', 'stock'],
  ['productos', 'precio_usd'],
  ['proveedores', 'telefono'],
  ['productos', 'empaquetado'],
  ['productos', 'unidades_por_empaquetado'],
  ['productos', 'subcategoria'],
  ['cierres_caja', 'costos_operativos_usd'],
  ['cierres_caja', 'reporte_z_anterior'],
  ['cierres_caja', 'reporte_z'],
  ['cierres_caja', 'exento_bs'],
  ['cierres_caja', 'base_imponible_bs'],
  ['cierres_caja', 'ultima_factura'],
  ['solicitudes', 'proveedor_id'],
  ['checklist_motos', 'anulado'],
  ['cierres_caja', 'anulado'],
  ['entradas_agua', 'anulado'],
  ['entradas_mercancia', 'anulado'],
  ['solicitudes', 'anulado'],
  ['incidencias', 'anulado'],
];

async function verificarEsquema() {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const presentes = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const faltan = COLUMNAS_REQUERIDAS.filter(([t, c]) => !presentes.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`);
  if (faltan.length) {
    console.error('\n=============================================================');
    console.error(' FALTA APLICAR LA MIGRACIÓN');
    console.error(' Columnas ausentes:', faltan.join(', '));
    console.error(' Aplique las migraciones pendientes de database/ en orden.');
    console.error(' (Supabase -> SQL Editor -> pegar el archivo -> Run)');
    console.error('=============================================================\n');
    return false;
  }
  const { rows: tz } = await pool.query("SELECT current_setting('TimeZone') AS zona");
  if (tz[0].zona !== TZ) {
    console.error(`\n[esquema] AVISO: la base responde en zona "${tz[0].zona}" y no en ${TZ}.`);
    console.error(`[esquema] Corrija con: ALTER DATABASE <base> SET timezone TO '${TZ}';\n`);
  }

  console.log(`[esquema] Verificado: columnas completas, zona horaria ${tz[0].zona}.`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

/**
 * Formatea una cantidad para un mensaje de error que lee un empleado:
 * sin decimales cuando son enteros, con dos cuando hacen falta.
 */
const nf2 = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

/** Redondeo contable a 2 decimales corrigiendo el error de punto flotante IEEE 754. */
function redondearMoneda(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return NaN;
  const signo = n < 0 ? -1 : 1;
  return (signo * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}
const aCentavos = (n) => Math.round(redondearMoneda(n) * 100);

function escapeHtml(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hoyCaracas() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Aritmética de fechas sobre el texto AAAA-MM-DD, en UTC a propósito.
 *
 * Se trabaja con la fecha "pura" y no con instantes: hoyCaracas() ya
 * resolvió en qué día estamos en Caracas, y a partir de ahí sumar días o
 * buscar el lunes de la semana es aritmética de calendario. Usar UTC
 * evita que un cambio de horario corra un día.
 */
function sumarDias(fechaISO, n) {
  const d = new Date(`${fechaISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** El lunes de la semana a la que pertenece esa fecha. */
function lunesDe(fechaISO) {
  const d = new Date(`${fechaISO}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 domingo, 1 lunes
  const retroceder = dow === 0 ? 6 : dow - 1;
  return sumarDias(fechaISO, -retroceder);
}

/**
 * Las últimas N semanas COMPLETAS antes de la semana en curso, de lunes a
 * domingo. La semana actual no entra porque todavía no terminó y
 * promediarla contra semanas completas daría un número más bajo que no
 * significa nada.
 */
function semanasCompletas(hoyISO, cuantas) {
  const lunesEstaSemana = lunesDe(hoyISO);
  const semanas = [];
  for (let i = cuantas; i >= 1; i -= 1) {
    const lunes = sumarDias(lunesEstaSemana, -7 * i);
    semanas.push({ desde: lunes, hasta: sumarDias(lunes, 6) });
  }
  return semanas;
}

function fechaValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function leerFecha(valor, defecto, nombre) {
  if (valor === undefined || valor === null || valor === '') return defecto;
  if (!fechaValida(valor)) throw bad(`${nombre} debe tener formato AAAA-MM-DD válido`);
  return valor;
}

function entero(valor, nombre, { min = 0, max = 2147483647, requerido = true } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (requerido) throw bad(`${nombre} es obligatorio`);
    return null;
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${nombre} debe ser un entero entre ${min} y ${max}`);
  return n;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(valor, nombre) {
  if (typeof valor !== 'string' || !RE_UUID.test(valor)) throw bad(`${nombre} no es un identificador válido`);
  return valor;
}

function monto(valor, nombre, { requerido = false, min = 0 } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (requerido) throw bad(`${nombre} es obligatorio`);
    return 0;
  }
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > 1e12) throw bad(`${nombre} debe ser un número válido no menor a ${min}`);
  return redondearMoneda(n);
}

/** Igual que monto, pero con 4 decimales: la tasa del día suele tenerlos. */
function montoTasa(valor, nombre) {
  if (valor === undefined || valor === null || valor === '') throw bad(`${nombre} es obligatoria`);
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw bad(`${nombre} debe ser un número mayor a 0`);
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function texto(valor, nombre, { min = 0, max = 2000, requerido = false } = {}) {
  if (valor === undefined || valor === null) {
    if (requerido) throw bad(`${nombre} es obligatorio`);
    return '';
  }
  if (typeof valor !== 'string') throw bad(`${nombre} debe ser texto`);
  const t = valor.trim();
  if (requerido && t.length < Math.max(min, 1)) throw bad(`${nombre} es obligatorio`);
  if (t.length > 0 && t.length < min) throw bad(`${nombre} debe tener al menos ${min} caracteres`);
  if (t.length > max) throw bad(`${nombre} no puede superar ${max} caracteres`);
  return t;
}

function unoDe(valor, lista, nombre) {
  if (!lista.includes(valor)) throw bad(`${nombre} inválido (valores: ${lista.join(', ')})`);
  return valor;
}

/** La subcategoría sólo aplica a la mercancía, y ahí es obligatoria. */
function leerSubcategoria(valor, categoria) {
  if (categoria !== 'mercancia') return null;
  return unoDe(valor, SUBCATEGORIAS, 'Subcategoría');
}

const esPinValido = (pin) => typeof pin === 'string' && /^\d{4,8}$/.test(pin);
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* JWT HS256 manual + prevención de timing attacks                     */
/* ------------------------------------------------------------------ */
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function firmarJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = b64url(JSON.stringify({ ...payload, iat: ahora, exp: ahora + TOKEN_TTL_SEC }));
  const firma = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${cuerpo}`).digest('base64url');
  return `${header}.${cuerpo}.${firma}`;
}

function verificarJwt(token) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [header, cuerpo, firma] = partes;
  const esperada = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${cuerpo}`).digest();
  let recibida;
  try { recibida = Buffer.from(firma, 'base64url'); } catch (_) { return null; }
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (h.alg !== 'HS256' || h.typ !== 'JWT') return null;
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (!p.exp || Math.floor(Date.now() / 1000) >= p.exp) return null;
    return p;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiter en memoria (10 intentos por IP)                        */
/* ------------------------------------------------------------------ */
const intentosLogin = new Map();
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, r] of intentosLogin) if (r.expira <= ahora) intentosLogin.delete(ip);
}, 60 * 1000).unref();

function limitadorLogin(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'desconocida';
  const ahora = Date.now();
  let r = intentosLogin.get(ip);
  if (!r || r.expira <= ahora) {
    r = { cuenta: 0, expira: ahora + LOGIN_VENTANA_MS };
    intentosLogin.set(ip, r);
  }
  r.cuenta += 1;
  req.limiteIp = ip;
  if (r.cuenta > LOGIN_MAX_INTENTOS) {
    const seg = Math.ceil((r.expira - ahora) / 1000);
    res.set('Retry-After', String(seg));
    return next(new HttpError(429, `Demasiados intentos. Intente de nuevo en ${Math.ceil(seg / 60)} minuto(s).`));
  }
  return next();
}

/* ------------------------------------------------------------------ */
/* Correo: Nodemailer con fallback a Resend                            */
/* ------------------------------------------------------------------ */
let transporte = null;
if (process.env.SMTP_HOST) {
  transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

async function enviarCorreo({ asunto, html, para }) {
  const destino = para || process.env.ADMIN_EMAIL;
  if (!destino) return { enviado: false, motivo: 'sin destinatario' };
  const remitente = process.env.MAIL_FROM || 'Purissima Cloud <no-reply@purissima.local>';
  if (transporte) {
    try {
      await transporte.sendMail({ from: remitente, to: destino, subject: asunto, html });
      return { enviado: true, via: 'nodemailer' };
    } catch (err) {
      console.error('[correo] Nodemailer falló:', err.message);
    }
  }
  if (process.env.RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: remitente, to: [destino], subject: asunto, html }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { enviado: true, via: 'resend' };
    } catch (err) {
      console.error('[correo] Resend falló:', err.message);
    }
  }
  return { enviado: false, motivo: 'sin proveedor de correo disponible' };
}

function notificar(asunto, filas) {
  const cuerpo = Object.entries(filas)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0"><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  const html = `<div style="font-family:Arial,sans-serif"><h2>${escapeHtml(asunto)}</h2><table>${cuerpo}</table></div>`;
  enviarCorreo({ asunto: `[Purissima] ${asunto}`, html }).catch((e) => console.error('[correo]', e.message));
}

/* ------------------------------------------------------------------ */
/* App y middlewares                                                   */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (process.env.CORS_ORIGIN) {
    res.set({
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  return next();
});
app.use(express.json({ limit: '50kb' }));

/** Une dos listas de permisos sin repetir. */
const unirClaves = (a, b) => [
  ...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]),
];

/**
 * Calcula lo que el empleado puede de verdad: lo que HEREDA de su rol
 * más lo EXTRA que se le marcó a él en particular.
 *
 * Se recalcula en cada petición leyendo de la base y nunca del token,
 * así que quitar un permiso surte efecto de inmediato y editar un rol
 * cambia a todos los que lo tengan.
 */
function calcularEfectivos(u) {
  u.es_master = u.es_master === true;
  // Un rol desactivado deja de conceder; a la persona le queda sólo lo suyo.
  const delRol = u.rol_activo === false ? { m: [], p: [] } : { m: u.rol_modulos, p: u.rol_permisos };
  u.modulos_efectivos = u.es_master
    ? [...MODULOS_VALIDOS]
    : unirClaves(delRol.m, u.modulos_permitidos);
  u.permisos_efectivos = u.es_master
    ? [...CLAVES_PERMISOS]
    : unirClaves(delRol.p, u.permisos_especiales);
  return u;
}

const SELECT_USUARIO_SESION = `
  SELECT u.id, u.usuario, u.nombre, u.apellido, u.rol, u.estado,
         u.modulos_permitidos, u.permisos_especiales,
         r.nombre   AS rol_nombre,
         r.es_master,
         r.activo   AS rol_activo,
         r.modulos_permitidos  AS rol_modulos,
         r.permisos_especiales AS rol_permisos
    FROM usuarios u
    JOIN roles r ON r.clave = u.rol`;

async function autenticar(req, res, next) {
  try {
    const cab = req.get('authorization') || '';
    const token = cab.startsWith('Bearer ') ? cab.slice(7).trim() : '';
    const payload = verificarJwt(token);
    if (!payload) throw new HttpError(401, 'Sesión inválida o vencida');
    const { rows } = await pool.query(`${SELECT_USUARIO_SESION} WHERE u.id = $1`, [payload.sub]);
    const u = rows[0];
    if (!u || u.estado !== 'activo') throw new HttpError(401, 'Su cuenta no tiene acceso. Consulte con el Master.');
    req.usuario = calcularEfectivos(u); // permisos siempre frescos desde la BD
    next();
  } catch (err) {
    next(err);
  }
}

const soloAdmin = (req, res, next) =>
  (req.usuario.es_master ? next() : next(new HttpError(403, 'Acceso exclusivo del Master')));

/** El Master tiene todas las funciones especiales sin que figuren en su lista. */
const tienePermiso = (u, clave) =>
  u.es_master || (Array.isArray(u.permisos_efectivos) && u.permisos_efectivos.includes(clave));

const requierePermiso = (clave) => (req, res, next) => {
  if (tienePermiso(req.usuario, clave)) return next();
  const p = PERMISOS_ESPECIALES.find((x) => x.clave === clave);
  return next(new HttpError(403, `No tiene la función "${p ? p.etiqueta : clave}"`));
};

const tieneModulo = (u, modulo) =>
  u.es_master || (Array.isArray(u.modulos_efectivos) && u.modulos_efectivos.includes(modulo));

const requiereModulo = (modulo) => (req, res, next) => {
  if (tieneModulo(req.usuario, modulo)) return next();
  return next(new HttpError(403, `No tiene acceso al módulo "${modulo}"`));
};

/** Para las solicitudes: basta con tener acceso a alguna de las dos secciones. */
const requiereAlgunaSolicitud = (req, res, next) => {
  if (tieneModulo(req.usuario, 'solicitudes_negocio') || tieneModulo(req.usuario, 'solicitudes_productos')) {
    return next();
  }
  return next(new HttpError(403, 'No tiene acceso a las solicitudes'));
};

const nombreCompleto = (u) => `${u.nombre || ''} ${u.apellido || ''}`.trim();

const usuarioPublico = (u) => ({
  id: u.id,
  usuario: u.usuario,
  nombre: u.nombre,
  apellido: u.apellido || '',
  nombre_completo: nombreCompleto(u),
  rol: u.rol,
  rol_nombre: u.rol_nombre || u.rol,
  es_master: u.es_master === true,
  // Lo efectivo: lo que hereda del rol más lo suyo. El frontend arma el
  // menú con esto, así que debe ser la suma y no sólo lo propio.
  modulos_permitidos: u.modulos_efectivos || u.modulos_permitidos || [],
  permisos_especiales: u.permisos_efectivos || u.permisos_especiales || [],
});

/* ------------------------------------------------------------------ */
/* Salud                                                               */
/* ------------------------------------------------------------------ */
app.get('/api/salud', asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT now() AS ahora, current_setting($1) AS zona', ['TimeZone']);
  res.json({ ok: true, hora: rows[0].ahora, zona: rows[0].zona, esquema_ok: app.locals.esquemaOk !== false });
}));

/* ------------------------------------------------------------------ */
/* Auth (con bloqueo por usuario usando intentos_fallidos)             */
/* ------------------------------------------------------------------ */
const HASH_RELLENO = '$2a$10$7EqJtq98hPqEX7fNZaFWoOHiCjKU3AqzFj2zvZ3Jrx8yHk3ZyYqZy';

app.post('/api/auth/login', limitadorLogin, asyncH(async (req, res) => {
  const b = req.body || {};
  // Se entra con "usuario"; se acepta "nombre" por compatibilidad
  const ingreso = texto(b.usuario !== undefined ? b.usuario : b.nombre, 'Usuario', { requerido: true, max: 40 });
  const pin = b.pin;
  if (!esPinValido(pin)) throw new HttpError(401, 'Credenciales inválidas');

  const { rows } = await pool.query(
    `SELECT u.id, u.usuario, u.nombre, u.apellido, u.rol, u.estado,
            u.modulos_permitidos, u.permisos_especiales,
            r.nombre AS rol_nombre, r.es_master, r.activo AS rol_activo,
            r.modulos_permitidos  AS rol_modulos,
            r.permisos_especiales AS rol_permisos,
            u.intentos_fallidos, u.bloqueado_hasta,
            (u.pin_hash = crypt($2, u.pin_hash)) AS pin_ok
       FROM usuarios u
       JOIN roles r ON r.clave = u.rol
      WHERE lower(u.usuario) = lower($1)`,
    [ingreso, pin],
  );
  const u = rows[0];
  if (!u) {
    // Mantiene el tiempo de respuesta parejo cuando el usuario no existe
    await pool.query('SELECT crypt($1, $2)', [pin, HASH_RELLENO]).catch(() => {});
    throw new HttpError(401, 'Credenciales inválidas');
  }

  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
    const min = Math.max(1, Math.ceil((new Date(u.bloqueado_hasta) - Date.now()) / 60000));
    throw new HttpError(429, `Cuenta bloqueada por intentos fallidos. Intente en ${min} minuto(s).`);
  }

  if (!u.pin_ok) {
    const intentos = (u.intentos_fallidos || 0) + 1;
    const bloquear = intentos >= LOGIN_MAX_INTENTOS;
    await pool.query(
      `UPDATE usuarios SET intentos_fallidos = $2,
              bloqueado_hasta = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE bloqueado_hasta END
         WHERE id = $1`,
      [u.id, bloquear ? 0 : intentos, bloquear, String(BLOQUEO_MIN)],
    ).catch(() => {});
    throw new HttpError(401, 'Credenciales inválidas');
  }
  if (u.estado !== 'activo') {
    throw new HttpError(403, u.estado === 'pausado'
      ? 'Su cuenta está pausada. Consulte con el Master.'
      : 'Su cuenta ya no tiene acceso al sistema.');
  }

  await pool.query(
    'UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1',
    [u.id],
  ).catch(() => {});
  intentosLogin.delete(req.limiteIp);
  res.json({ token: firmarJwt({ sub: u.id, rol: u.rol }), usuario: usuarioPublico(calcularEfectivos(u)) });
}));

app.get('/api/auth/me', autenticar, (req, res) => {
  res.json({ usuario: usuarioPublico(req.usuario) });
});

app.put('/api/auth/pin', autenticar, limitadorLogin, asyncH(async (req, res) => {
  const { pin_actual: actual, pin_nuevo: nuevo } = req.body || {};
  if (!esPinValido(actual) || !esPinValido(nuevo)) throw bad('El PIN debe tener entre 4 y 8 dígitos');
  const { rows } = await pool.query(
    'SELECT (pin_hash = crypt($2, pin_hash)) AS ok FROM usuarios WHERE id = $1',
    [req.usuario.id, actual],
  );
  if (!rows[0] || !rows[0].ok) throw new HttpError(401, 'PIN actual incorrecto');
  await pool.query(
    "UPDATE usuarios SET pin_hash = crypt($2, gen_salt('bf', 10)) WHERE id = $1",
    [req.usuario.id, nuevo],
  );
  intentosLogin.delete(req.limiteIp);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Usuarios (Master)                                                   */
/* ------------------------------------------------------------------ */
function validarModulos(valor) {
  if (!Array.isArray(valor)) throw bad('modulos_permitidos debe ser un arreglo');
  const unicos = [...new Set(valor)];
  for (const m of unicos) {
    if (!MODULOS_VALIDOS.includes(m)) throw bad(`Módulo no válido: ${String(m).slice(0, 40)}`);
  }
  return unicos;
}

const COLS_USUARIO = `id, usuario, nombre, apellido, rol, modulos_permitidos, permisos_especiales,
            estado, activo, creado_en,
            (SELECT r.nombre    FROM roles r WHERE r.clave = usuarios.rol) AS rol_nombre,
            (SELECT r.es_master FROM roles r WHERE r.clave = usuarios.rol) AS es_master,
            (SELECT r.modulos_permitidos  FROM roles r WHERE r.clave = usuarios.rol) AS rol_modulos,
            (SELECT r.permisos_especiales FROM roles r WHERE r.clave = usuarios.rol) AS rol_permisos,
            trim(nombre || ' ' || apellido) AS nombre_completo,
            (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado`;

/** ¿Esta clave de rol concede el nivel Master? */
async function esRolMaster(clave, cliente) {
  const { rows } = await (cliente || pool).query(
    'SELECT es_master FROM roles WHERE clave = $1', [clave],
  );
  return rows[0] ? rows[0].es_master === true : false;
}

/**
 * El rol debe existir en la tabla y estar activo. Reemplaza a la lista
 * fija de tres valores que había antes de la migración 006.
 */
async function validarRol(valor, cliente) {
  const clave = texto(valor, 'Rol', { requerido: true, max: 30 });
  const { rows } = await (cliente || pool).query(
    'SELECT clave, activo FROM roles WHERE clave = $1', [clave],
  );
  if (!rows[0]) throw bad(`El rol "${clave.slice(0, 30)}" no existe`);
  if (rows[0].activo === false) throw bad(`El rol "${clave.slice(0, 30)}" está desactivado`);
  return rows[0].clave;
}

/**
 * Nadie que no sea Master puede tocar una cuenta de Master ni crear una.
 * Sin esto, alguien con "gestionar empleados" podría cambiarle el PIN al
 * Master y quedarse con todo el sistema.
 */
async function protegerMaster(actor, rolObjetivo, cliente) {
  if (actor.es_master) return;
  if (await esRolMaster(rolObjetivo, cliente)) {
    throw new HttpError(403, 'Sólo el Master puede crear o modificar otra cuenta de Master');
  }
}

/**
 * Nadie puede asignar un cargo que conceda más de lo que él mismo tiene.
 *
 * Sin esto, quien tenga "gestionar empleados" podría crear una cuenta con
 * un cargo más poderoso que el suyo y entrar con ella: no sería escalar
 * por encima del Master, pero sí por encima de sí mismo, que para el caso
 * es lo mismo.
 *
 * El Master queda exento porque él es quien crea los cargos.
 */
async function exigirPuedeAsignarRol(actor, clave, cliente) {
  if (actor.es_master) return;
  const { rows } = await (cliente || pool).query(
    'SELECT nombre, modulos_permitidos, permisos_especiales FROM roles WHERE clave = $1',
    [clave],
  );
  const rol = rows[0];
  if (!rol) throw bad('El cargo no existe');

  const misFunciones = new Set(actor.permisos_efectivos || []);
  const misModulos = new Set(actor.modulos_efectivos || []);
  const faltanFunciones = (rol.permisos_especiales || []).filter((p) => !misFunciones.has(p));
  const faltanModulos = (rol.modulos_permitidos || []).filter((m) => !misModulos.has(m));

  if (faltanFunciones.length || faltanModulos.length) {
    const nombres = [
      ...faltanFunciones.map((p) => {
        const d = PERMISOS_ESPECIALES.find((x) => x.clave === p);
        return d ? d.etiqueta : p;
      }),
      ...faltanModulos,
    ];
    throw new HttpError(403,
      `No puede asignar el cargo "${rol.nombre}": concede cosas que usted no tiene (${nombres.join(', ')})`);
  }
}

/** Comprueba que la cuenta exista y que quien actúa tenga derecho a tocarla. */
async function exigirPuedeTocar(actor, id) {
  const { rows } = await pool.query('SELECT id, rol FROM usuarios WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  await protegerMaster(actor, rows[0].rol);
  return rows[0];
}

/** El usuario de ingreso: sin espacios, de 3 a 40 caracteres. */
function nombreUsuario(valor) {
  const u = texto(valor, 'Usuario', { requerido: true, min: 3, max: 40 });
  if (/\s/.test(u)) throw bad('El usuario no puede tener espacios');
  return u;
}

app.get('/api/usuarios', autenticar, requierePermiso('ver_accesos'), asyncH(async (req, res) => {
  const incluirEliminados = req.query.eliminados === 'true';
  const { rows } = await pool.query(
    `SELECT ${COLS_USUARIO} FROM usuarios
      WHERE ($1::boolean OR estado <> 'eliminado')
      ORDER BY estado, nombre, apellido`,
    [incluirEliminados],
  );
  const { rows: roles } = await pool.query(
    `SELECT clave, nombre, modulos_permitidos, permisos_especiales,
            es_master, protegido, activo,
            (SELECT count(*) FROM usuarios u
              WHERE u.rol = roles.clave AND u.estado <> 'eliminado') AS en_uso
       FROM roles ORDER BY es_master DESC, nombre`,
  );
  res.json({
    usuarios: rows,
    roles: roles.map((r) => ({ ...r, en_uso: Number(r.en_uso) })),
    modulos_disponibles: MODULOS_VALIDOS,
    estados: ESTADOS_USUARIO,
    permisos_disponibles: PERMISOS_ESPECIALES,
    puede_conceder: req.usuario.es_master === true,
  });
}));

app.post('/api/usuarios', autenticar, requierePermiso('gestionar_empleados'), asyncH(async (req, res) => {
  const b = req.body || {};
  const usuario = nombreUsuario(b.usuario);
  const nombre = texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 80 });
  const apellido = texto(b.apellido, 'Apellido', { max: 80 });
  const rol = await validarRol(b.rol);
  await protegerMaster(req.usuario, rol);
  await exigirPuedeAsignarRol(req.usuario, rol);
  if (!esPinValido(b.pin)) throw bad('El PIN debe tener entre 4 y 8 dígitos');
  const modulos = validarModulos(b.modulos_permitidos || []);
  const { rows } = await pool.query(
    `INSERT INTO usuarios (usuario, nombre, apellido, rol, pin_hash, modulos_permitidos)
     VALUES ($1, $2, $3, $4, crypt($5, gen_salt('bf', 10)), $6::jsonb)
     RETURNING ${COLS_USUARIO}`,
    [usuario, nombre, apellido, rol, b.pin, JSON.stringify(modulos)],
  );
  res.status(201).json({ usuario: rows[0] });
}));

/** Editar los datos de una cuenta (no el PIN ni los permisos). */
app.put('/api/usuarios/:id', autenticar, requierePermiso('gestionar_empleados'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const usuarioActualizado = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [id]);
    const actual = rows[0];
    if (!actual) throw new HttpError(404, 'Usuario no encontrado');

    const usuario = b.usuario !== undefined ? nombreUsuario(b.usuario) : actual.usuario;
    const nombre = b.nombre !== undefined
      ? texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 80 }) : actual.nombre;
    const apellido = b.apellido !== undefined
      ? texto(b.apellido, 'Apellido', { max: 80 }) : actual.apellido;
    const rol = b.rol !== undefined ? await validarRol(b.rol, c) : actual.rol;

    // No se puede tocar una cuenta de Master, ni ascender a nadie a Master,
    // si quien edita no es Master
    await protegerMaster(req.usuario, actual.rol, c);
    await protegerMaster(req.usuario, rol, c);
    // Sólo si de verdad le está cambiando el cargo
    if (rol !== actual.rol) await exigirPuedeAsignarRol(req.usuario, rol, c);

    // El Master no puede quitarse a sí mismo el nivel Master
    if (id === req.usuario.id && req.usuario.es_master && !(await esRolMaster(rol, c))) {
      throw bad('No puede quitarse a sí mismo el rol de Master');
    }

    const r = await c.query(
      `UPDATE usuarios SET usuario = $2, nombre = $3, apellido = $4, rol = $5
        WHERE id = $1 RETURNING ${COLS_USUARIO}`,
      [id, usuario, nombre, apellido, rol],
    );
    return r.rows[0];
  });
  res.json({ usuario: usuarioActualizado });
}));

/** Cambiar el estado: activo, pausado o eliminado. */
app.put('/api/usuarios/:id/estado', autenticar, requierePermiso('gestionar_empleados'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const estado = unoDe(req.body && req.body.estado, ESTADOS_USUARIO, 'Estado');
  await exigirPuedeTocar(req.usuario, id);
  if (id === req.usuario.id && estado !== 'activo') {
    throw bad('No puede quitarse el acceso a sí mismo');
  }
  const { rows } = await pool.query(
    `UPDATE usuarios SET estado = $2,
            intentos_fallidos = CASE WHEN $2 = 'activo' THEN 0 ELSE intentos_fallidos END,
            bloqueado_hasta  = CASE WHEN $2 = 'activo' THEN NULL ELSE bloqueado_hasta END
      WHERE id = $1 RETURNING ${COLS_USUARIO}`,
    [id, estado],
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ usuario: rows[0] });
}));

/* Endpoint exclusivo del Master: actualiza el JSONB de módulos */
app.put('/api/usuarios/:id/permisos', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const modulos = validarModulos(req.body && req.body.modulos_permitidos);
  const { rows } = await pool.query(
    `UPDATE usuarios SET modulos_permitidos = $2::jsonb WHERE id = $1
     RETURNING ${COLS_USUARIO}`,
    [id, JSON.stringify(modulos)],
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ usuario: rows[0] });
}));

/**
 * Endpoint exclusivo del Master: concede o quita las funciones especiales.
 * No se delega en ningún permiso, a propósito: si "gestionar empleados"
 * permitiera esto, quien lo tuviera podría concederse todo lo demás.
 */
app.put('/api/usuarios/:id/especiales', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  // Se guardan sólo como EXTRAS de esta persona: lo que ya hereda de su
  // rol no se copia aquí, para que al editar el rol le siga cambiando.
  const unicos = validarPermisos(req.body && req.body.permisos_especiales);
  const { rows } = await pool.query(
    `UPDATE usuarios SET permisos_especiales = $2::jsonb WHERE id = $1
     RETURNING ${COLS_USUARIO}`,
    [id, JSON.stringify(unicos)],
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ usuario: rows[0] });
}));

app.put('/api/usuarios/:id/pin', autenticar, requierePermiso('gestionar_empleados'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  if (!esPinValido(req.body && req.body.pin)) throw bad('El PIN debe tener entre 4 y 8 dígitos');
  await exigirPuedeTocar(req.usuario, id);
  const { rowCount } = await pool.query(
    `UPDATE usuarios SET pin_hash = crypt($2, gen_salt('bf', 10)),
            intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`,
    [id, req.body.pin],
  );
  if (!rowCount) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ ok: true });
}));

/** Se conserva por compatibilidad: equivale a estado activo/pausado. */
app.put('/api/usuarios/:id/activo', autenticar, requierePermiso('gestionar_empleados'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  if (typeof (req.body && req.body.activo) !== 'boolean') throw bad('activo debe ser booleano');
  await exigirPuedeTocar(req.usuario, id);
  if (id === req.usuario.id && req.body.activo === false) throw bad('No puede desactivar su propia cuenta');
  const { rows } = await pool.query(
    `UPDATE usuarios SET estado = $2 WHERE id = $1 RETURNING ${COLS_USUARIO}`,
    [id, req.body.activo ? 'activo' : 'pausado'],
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ usuario: rows[0] });
}));

/* ------------------------------------------------------------------ */
/* Roles (perfiles de cargo)                                           */
/*                                                                     */
/* Un rol es un PERFIL: lleva su nombre y, guardados dentro, qué        */
/* módulos ve y qué funciones especiales trae. Quien lo tenga hereda    */
/* todo eso, y encima se le puede marcar algo extra a él en particular. */
/*                                                                     */
/* Crear y editar roles es EXCLUSIVO del Master (soloAdmin), igual que  */
/* conceder permisos: quien pudiera crear un rol podría armarse uno con */
/* todo y asignárselo.                                                 */
/* ------------------------------------------------------------------ */

/** Valida una lista de funciones especiales contra el catálogo. */
function validarPermisos(valor) {
  if (!Array.isArray(valor)) throw bad('permisos_especiales debe ser un arreglo');
  const unicos = [...new Set(valor)];
  for (const c of unicos) {
    if (!CLAVES_PERMISOS.includes(c)) throw bad(`Función no válida: ${String(c).slice(0, 40)}`);
  }
  return unicos;
}

/**
 * La clave interna se deriva del nombre, para que el Master sólo escriba
 * "Gerente de Recursos Humanos" y no tenga que inventar un identificador.
 */
function claveDesdeNombre(nombre) {
  const base = String(nombre)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
    .replace(/_+$/, '');
  if (/^[a-z][a-z0-9_]{2,29}$/.test(base)) return base;
  return `rol_${base}`.slice(0, 30).replace(/_+$/, '') || 'rol';
}

/** Busca una clave libre: gerente, gerente_2, gerente_3... */
async function claveLibre(nombre, cliente) {
  const base = claveDesdeNombre(nombre);
  for (let i = 1; i <= 50; i += 1) {
    const intento = i === 1 ? base : `${base.slice(0, 27)}_${i}`;
    const { rows } = await (cliente || pool).query(
      'SELECT 1 FROM roles WHERE clave = $1', [intento],
    );
    if (!rows[0]) return intento;
  }
  throw bad('No se pudo generar una clave para ese nombre. Pruebe con otro.');
}

const COLS_ROL = `clave, nombre, modulos_permitidos, permisos_especiales,
            es_master, protegido, activo, creado_en,
            (SELECT count(*) FROM usuarios u
              WHERE u.rol = roles.clave AND u.estado <> 'eliminado')::int AS en_uso`;

app.get('/api/roles', autenticar, requierePermiso('ver_accesos'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${COLS_ROL} FROM roles ORDER BY es_master DESC, nombre`,
  );
  res.json({
    roles: rows,
    modulos_disponibles: MODULOS_VALIDOS,
    permisos_disponibles: PERMISOS_ESPECIALES,
    puede_gestionar: req.usuario.es_master === true,
  });
}));

app.post('/api/roles', autenticar, soloAdmin, asyncH(async (req, res) => {
  const b = req.body || {};
  const nombre = texto(b.nombre, 'Nombre del rol', { requerido: true, min: 3, max: 60 });
  const modulos = validarModulos(b.modulos_permitidos || []);
  const permisos = validarPermisos(b.permisos_especiales || []);

  const rol = await withTx(async (c) => {
    const { rows: dup } = await c.query('SELECT clave FROM roles WHERE lower(nombre) = lower($1)', [nombre]);
    if (dup[0]) throw bad(`Ya existe un rol llamado "${nombre}"`);
    const clave = await claveLibre(nombre, c);
    // es_master y protegido se dejan en false a propósito: el nivel
    // Master no se concede desde la aplicación.
    const { rows } = await c.query(
      `INSERT INTO roles (clave, nombre, modulos_permitidos, permisos_especiales)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)
       RETURNING ${COLS_ROL}`,
      [clave, nombre, JSON.stringify(modulos), JSON.stringify(permisos)],
    );
    return rows[0];
  });
  res.status(201).json({ rol });
}));

/**
 * Editar un rol cambia de inmediato lo que pueden TODOS los que lo
 * tengan, porque los permisos se recalculan en cada petición.
 */
app.put('/api/roles/:clave', autenticar, soloAdmin, asyncH(async (req, res) => {
  const clave = texto(req.params.clave, 'Rol', { requerido: true, max: 30 });
  const b = req.body || {};
  const rol = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM roles WHERE clave = $1 FOR UPDATE', [clave]);
    const actual = rows[0];
    if (!actual) throw new HttpError(404, 'Rol no encontrado');
    if (actual.protegido) {
      throw new HttpError(403, `El rol "${actual.nombre}" es del sistema y no se puede modificar`);
    }

    const nombre = b.nombre !== undefined
      ? texto(b.nombre, 'Nombre del rol', { requerido: true, min: 3, max: 60 }) : actual.nombre;
    const modulos = b.modulos_permitidos !== undefined
      ? validarModulos(b.modulos_permitidos) : actual.modulos_permitidos;
    const permisos = b.permisos_especiales !== undefined
      ? validarPermisos(b.permisos_especiales) : actual.permisos_especiales;

    if (nombre.toLowerCase() !== String(actual.nombre).toLowerCase()) {
      const { rows: dup } = await c.query(
        'SELECT clave FROM roles WHERE lower(nombre) = lower($1) AND clave <> $2', [nombre, clave],
      );
      if (dup[0]) throw bad(`Ya existe un rol llamado "${nombre}"`);
    }

    const r = await c.query(
      `UPDATE roles SET nombre = $2, modulos_permitidos = $3::jsonb, permisos_especiales = $4::jsonb
        WHERE clave = $1 RETURNING ${COLS_ROL}`,
      [clave, nombre, JSON.stringify(modulos), JSON.stringify(permisos)],
    );
    return r.rows[0];
  });
  res.json({ rol });
}));

app.delete('/api/roles/:clave', autenticar, soloAdmin, asyncH(async (req, res) => {
  const clave = texto(req.params.clave, 'Rol', { requerido: true, max: 30 });
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM roles WHERE clave = $1 FOR UPDATE', [clave]);
    const rol = rows[0];
    if (!rol) throw new HttpError(404, 'Rol no encontrado');
    if (rol.protegido) {
      throw new HttpError(403, `El rol "${rol.nombre}" es del sistema y no se puede eliminar`);
    }
    const { rows: uso } = await c.query(
      `SELECT count(*)::int AS n FROM usuarios WHERE rol = $1 AND estado <> 'eliminado'`, [clave],
    );
    if (uso[0].n > 0) {
      throw bad(`"${rol.nombre}" lo tiene ${uso[0].n} empleado(s). Cámbieles el cargo antes de eliminarlo.`);
    }
    // Si alguna cuenta ya retirada lo conserva, se la pasamos a Motorizado
    // para que la llave foránea no impida borrar el rol.
    await c.query(
      `UPDATE usuarios SET rol = 'motorizados' WHERE rol = $1 AND estado = 'eliminado'`, [clave],
    );
    await c.query('DELETE FROM roles WHERE clave = $1', [clave]);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Fotos                                                               */
/*                                                                     */
/* Las fotos NO viven en la base de datos: una pesa mil veces más que  */
/* una fila. Viven en el almacén de archivos de Supabase, que es        */
/* PRIVADO, y en la base sólo se guarda su ruta.                        */
/*                                                                     */
/* El teléfono las comprime antes de subir, así que lo que llega aquí   */
/* ronda los 200 kB. El tope de 2 MB es un techo de seguridad.          */
/*                                                                     */
/* Nadie puede abrir una foto adivinando su dirección: para verla hay   */
/* que pedirle al backend un enlace firmado, que caduca en una hora.    */
/* ------------------------------------------------------------------ */
/*
 * Se recortan los espacios: al pegar una clave en el panel es fácil
 * arrastrar un espacio o un salto de línea al final, y eso la invalida
 * sin que nada lo explique.
 */
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET_FOTOS = 'fotos';
const FOTOS_HABILITADAS = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const FOTO_MAX_BYTES = 2 * 1024 * 1024;
const FOTO_FIRMA_SEG = 3600;
const TIPOS_FOTO = Object.freeze(['image/jpeg', 'image/webp', 'image/png']);

/* Qué se puede fotografiar, en qué carpeta cae y qué módulo hace falta */
const DESTINOS_FOTO = Object.freeze({
  tablero: { carpeta: 'motos', modulo: 'motos' },
  frontal: { carpeta: 'motos', modulo: 'motos' },
  trasera: { carpeta: 'motos', modulo: 'motos' },
  falla: { carpeta: 'motos', modulo: 'motos' },
  factura: { carpeta: 'facturas', modulo: 'recepcion' },
});
/* Para mirar una foto basta tener el módulo de donde salió */
const MODULO_POR_CARPETA = Object.freeze({ motos: 'motos', facturas: 'recepcion' });

const RUTA_FOTO = /^[a-z0-9][a-z0-9/_.-]{3,250}$/;

/**
 * Valida una ruta del almacén. El patrón por sí solo aceptaría "..", que
 * serviría para salirse de la carpeta, así que se prohíbe aparte.
 */
function validarRutaFoto(valor, etiqueta = 'Ruta de la foto') {
  const r = texto(valor, etiqueta, { requerido: true, max: 260 });
  if (!RUTA_FOTO.test(r) || r.includes('..')) throw bad(`${etiqueta} no es válida`);
  return r;
}

/** Acepta las dos formas: un enlace pegado a mano o una ruta del almacén. */
function validarFotoOEnlace(valor, etiqueta) {
  const v = texto(valor, etiqueta, { max: 500 });
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  return validarRutaFoto(v, etiqueta);
}

/**
 * El tipo real se deduce de los primeros bytes y no de la cabecera que
 * manda el navegador: así nadie sube un archivo cualquiera diciendo que
 * es una imagen.
 */
function tipoImagenReal(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const extensionDe = (tipo) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[tipo] || 'jpg');

function exigirFotosHabilitadas() {
  if (!FOTOS_HABILITADAS) {
    throw new HttpError(503, 'Las fotos no están configuradas todavía. Avise al Master.');
  }
}

async function subirFoto(ruta, bytes, tipo) {
  exigirFotosHabilitadas();
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_FOTOS}/${ruta}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': tipo,
        'Cache-Control': 'max-age=31536000',
      },
      body: bytes,
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    console.error('[fotos] No se pudo contactar el almacén:', err.message);
    throw new HttpError(502, 'No se pudo guardar la foto. Intente de nuevo.');
  }
  if (!res.ok) {
    // El detalle queda en el registro del servidor, no se le manda al cliente
    const detalle = await res.text().catch(() => '');
    console.error(`[fotos] El almacén rechazó la subida (${res.status}):`, detalle.slice(0, 300));
    throw new HttpError(502, 'El almacén rechazó la foto. Intente de nuevo.');
  }
}

async function firmarFoto(ruta) {
  exigirFotosHabilitadas();
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET_FOTOS}/${ruta}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: FOTO_FIRMA_SEG }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('[fotos] No se pudo contactar el almacén para firmar:', err.message);
    throw new HttpError(502, 'No se pudo abrir la foto. Intente de nuevo.');
  }
  if (!res.ok) {
    if (res.status === 404) throw new HttpError(404, 'Esa foto ya no está en el almacén');
    const detalle = await res.text().catch(() => '');
    console.error(`[fotos] Firma rechazada (${res.status}):`, detalle.slice(0, 300));
    throw new HttpError(502, 'No se pudo abrir la foto. Intente de nuevo.');
  }
  const d = await res.json().catch(() => ({}));
  // Según la versión, el campo viene como signedURL o signedUrl
  const relativa = d.signedURL || d.signedUrl;
  if (!relativa) {
    console.error('[fotos] El almacén no devolvió enlace firmado:', JSON.stringify(d).slice(0, 200));
    throw new HttpError(502, 'No se pudo abrir la foto. Intente de nuevo.');
  }
  return `${SUPABASE_URL}/storage/v1${relativa.startsWith('/') ? '' : '/'}${relativa}`;
}

app.get('/api/fotos/config', autenticar, (req, res) => {
  res.json({
    habilitadas: FOTOS_HABILITADAS,
    max_bytes: FOTO_MAX_BYTES,
    tipos: TIPOS_FOTO,
    destinos: Object.keys(DESTINOS_FOTO),
  });
});

/**
 * Sube una foto y devuelve su ruta, que es lo que después se guarda con
 * el checklist o la entrada de mercancía.
 *
 * El cuerpo llega como imagen cruda, no como JSON: así se evita el 33 %
 * que agregaría codificarla en texto. El límite de 50 kb del resto de la
 * API no se toca, porque express.json sólo mira las peticiones de tipo
 * application/json y deja pasar las imágenes intactas.
 */
app.post(
  '/api/fotos/:destino',
  autenticar,
  express.raw({ type: TIPOS_FOTO, limit: FOTO_MAX_BYTES }),
  asyncH(async (req, res) => {
    exigirFotosHabilitadas();
    const destino = unoDe(req.params.destino, Object.keys(DESTINOS_FOTO), 'Destino');
    const { carpeta, modulo } = DESTINOS_FOTO[destino];
    if (!tieneModulo(req.usuario, modulo)) {
      throw new HttpError(403, `No tiene acceso al módulo "${modulo}"`);
    }

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
      throw bad('No llegó ninguna imagen. Vuelva a tomar la foto.');
    }
    const tipo = tipoImagenReal(bytes);
    if (!tipo) throw bad('El archivo no es una imagen válida');

    const ruta = `${carpeta}/${hoyCaracas()}/${destino}-${crypto.randomBytes(8).toString('hex')}.${extensionDe(tipo)}`;
    await subirFoto(ruta, bytes, tipo);
    console.log(`[fotos] ${req.usuario.usuario} subió ${ruta} (${bytes.length} bytes)`);
    res.status(201).json({ ruta, bytes: bytes.length });
  }),
);

/**
 * Devuelve un enlace temporal para ver una foto. Se pide con el token en
 * la cabecera, como todo lo demás; el enlace firmado que sale de aquí es
 * el que se le pone a la imagen.
 */
app.get('/api/fotos/firma', autenticar, asyncH(async (req, res) => {
  const ruta = validarRutaFoto(req.query.ruta);
  const carpeta = ruta.split('/')[0];
  const modulo = MODULO_POR_CARPETA[carpeta];
  if (!modulo) throw bad('Ruta de foto no reconocida');
  if (!tieneModulo(req.usuario, modulo) && !tienePermiso(req.usuario, 'ver_de_todos')) {
    throw new HttpError(403, 'No tiene acceso a esa foto');
  }
  res.set('Cache-Control', 'no-store');
  res.json({ url: await firmarFoto(ruta), vence_en: FOTO_FIRMA_SEG });
}));

/* ------------------------------------------------------------------ */
/* Motos                                                               */
/* ------------------------------------------------------------------ */
app.get('/api/motos/config', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const ajustes = await leerAjustes();
  res.json({
    checklists: CHECKLISTS,
    fotos_habilitadas: FOTOS_HABILITADAS,
    km_aceite: ajustes.km_aceite,
    km_aviso_anticipacion: ajustes.km_aviso_anticipacion,
  });
}));

/**
 * Los puntos del checklist de una moto que tienen una incidencia abierta.
 *
 * Mientras una falla no se cierre, ese punto no se vuelve a revisar: la
 * falla sigue ahí y reportarla otra vez cada día sólo acumularía
 * incidencias duplicadas de lo mismo, llenando el almacén sin aportar.
 */
async function itemsEnReparacion(motoId, cliente) {
  const { rows } = await (cliente || pool).query(
    `SELECT DISTINCT jsonb_array_elements_text(items_afectados) AS item
       FROM incidencias
      WHERE moto_id = $1
        AND tipo = 'moto'
        AND estado <> 'cerrada'
        AND NOT anulado
        AND jsonb_typeof(items_afectados) = 'array'`,
    [motoId],
  );
  return rows.map((r) => r.item);
}

/**
 * Calcula el aviso del próximo cambio de aceite de una moto.
 *
 * Devuelve el kilometraje al que toca, cuántos faltan, y un color:
 *   gris     -> todavía falta bastante
 *   amarillo -> entra en la anticipación configurada, hay tiempo de
 *               comprar el aceite sin parar la moto
 *   rojo     -> ya se pasó
 */
function avisoAceite(moto, ajustes) {
  const cada = Number(ajustes.km_aceite) || AJUSTES_POR_DEFECTO.km_aceite;
  const anticipacion = Number(ajustes.km_aviso_anticipacion) || 0;
  const ultimo = Number(moto.ultimo_cambio_aceite_km) || 0;
  const actual = Number(moto.ultimo_kilometraje) || 0;
  const toca_en = ultimo + cada;
  const faltan = toca_en - actual;
  let color = 'gris';
  if (faltan <= 0) color = 'rojo';
  else if (faltan <= anticipacion) color = 'amarillo';
  return { cada, toca_en, faltan, color, vencido: faltan <= 0 };
}

app.get('/api/motos', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const ajustes = await leerAjustes();
  const verTodas = tienePermiso(req.usuario, 'gestionar_motos') && req.query.todas === 'true';
  const { rows } = await pool.query(
    `SELECT m.id, m.nombre, m.color, m.placa, m.tipo_modelo,
            m.ultimo_kilometraje, m.ultimo_cambio_aceite_km, m.activa,
            (m.ultimo_kilometraje - m.ultimo_cambio_aceite_km) AS km_desde_aceite,
            EXISTS (
              SELECT 1 FROM checklist_motos c
               WHERE c.moto_id = m.id
                 AND (c.fecha AT TIME ZONE 'America/Caracas')::date = $1::date
                 AND NOT c.anulado
            ) AS checklist_hoy
       FROM motos m
      WHERE ($2::boolean OR m.activa)
      ORDER BY m.nombre, m.placa`,
    [hoy, verTodas],
  );
  /*
   * Cada moto informa qué puntos están en reparación, para que el
   * formulario los muestre bloqueados en vez de dejar que el motorizado
   * reporte la misma falla todos los días.
   */
  const motos = [];
  for (const m of rows) {
    // eslint-disable-next-line no-await-in-loop
    motos.push({
      ...m,
      aviso_aceite: avisoAceite(m, ajustes),
      items_en_reparacion: await itemsEnReparacion(m.id),
    });
  }
  res.json({ motos, fecha: hoy });
}));

app.post('/api/motos', autenticar, requierePermiso('gestionar_motos'), asyncH(async (req, res) => {
  const b = req.body || {};
  const nombre = texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 80 });
  const color = texto(b.color, 'Color', { requerido: true, min: 2, max: 40 });
  const placa = texto(b.placa, 'Placa', { requerido: true, min: 3, max: 20 }).toUpperCase();
  const tipo = unoDe(b.tipo_modelo, TIPOS_MOTO, 'Tipo de modelo');
  const km = entero(b.ultimo_kilometraje ?? 0, 'Kilometraje', { min: 0 });
  const aceite = entero(b.ultimo_cambio_aceite_km ?? 0, 'Km del último cambio de aceite', { min: 0 });
  if (aceite > km) throw bad('El último cambio de aceite no puede superar el kilometraje actual');
  const { rows } = await pool.query(
    `INSERT INTO motos (nombre, color, placa, tipo_modelo, ultimo_kilometraje, ultimo_cambio_aceite_km)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [nombre, color, placa, tipo, km, aceite],
  );
  res.status(201).json({ moto: rows[0] });
}));

app.put('/api/motos/:id', autenticar, requierePermiso('gestionar_motos'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const moto = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM motos WHERE id = $1 FOR UPDATE', [id]);
    const actual = rows[0];
    if (!actual) throw new HttpError(404, 'Moto no encontrada');
    const nombre = b.nombre !== undefined ? texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 80 }) : actual.nombre;
    const color = b.color !== undefined ? texto(b.color, 'Color', { requerido: true, min: 2, max: 40 }) : actual.color;
    const placa = b.placa !== undefined ? texto(b.placa, 'Placa', { requerido: true, min: 3, max: 20 }).toUpperCase() : actual.placa;
    const tipo = b.tipo_modelo !== undefined ? unoDe(b.tipo_modelo, TIPOS_MOTO, 'Tipo de modelo') : actual.tipo_modelo;
    const km = b.ultimo_kilometraje !== undefined ? entero(b.ultimo_kilometraje, 'Kilometraje', { min: 0 }) : actual.ultimo_kilometraje;
    const aceite = b.ultimo_cambio_aceite_km !== undefined
      ? entero(b.ultimo_cambio_aceite_km, 'Km de aceite', { min: 0 }) : actual.ultimo_cambio_aceite_km;
    const activa = b.activa !== undefined ? Boolean(b.activa) : actual.activa;
    if (aceite > km) throw bad('El último cambio de aceite no puede superar el kilometraje actual');
    const r = await c.query(
      `UPDATE motos SET nombre=$2, color=$3, placa=$4, tipo_modelo=$5,
              ultimo_kilometraje=$6, ultimo_cambio_aceite_km=$7, activa=$8
       WHERE id=$1 RETURNING *`,
      [id, nombre, color, placa, tipo, km, aceite, activa],
    );
    return r.rows[0];
  });
  res.json({ moto });
}));

app.delete('/api/motos/:id', autenticar, requierePermiso('gestionar_motos'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const { rowCount } = await pool.query('UPDATE motos SET activa = FALSE WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Moto no encontrada');
  res.json({ ok: true });
}));

app.get('/api/motos/checklists', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const verTodos = tienePermiso(req.usuario, 'ver_de_todos');
  const desde = leerFecha(req.query.desde, verTodos ? '1900-01-01' : hoy, 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const soloFallas = req.query.fallas === 'true';
  const propios = verTodos ? null : req.usuario.id;
  const { rows } = await pool.query(
    `SELECT c.*, (c.fecha AT TIME ZONE 'America/Caracas')::date AS fecha_local,
            m.placa, m.nombre AS moto, m.tipo_modelo, trim(u.nombre || ' ' || u.apellido) AS usuario
       FROM checklist_motos c
       JOIN motos m ON m.id = c.moto_id
       JOIN usuarios u ON u.id = c.usuario_id
      WHERE (c.fecha AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR c.usuario_id = $3)
        AND (NOT $4::boolean OR c.tiene_falla)
        AND NOT c.anulado
      ORDER BY c.fecha DESC
      LIMIT 300`,
    [desde, hasta, propios, soloFallas],
  );
  res.json({ checklists: rows });
}));

app.post('/api/motos/:id/checklist', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const seUso = b.se_uso_hoy === undefined ? true : Boolean(b.se_uso_hoy);
  const hoy = hoyCaracas();

  const resultado = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM motos WHERE id = $1 FOR UPDATE', [id]);
    const moto = rows[0];
    if (!moto || !moto.activa) throw new HttpError(404, 'Moto no encontrada o inactiva');

    // Un checklist por moto por día (validado aquí: el historial impide el índice único)
    const ya = await c.query(
      `SELECT 1 FROM checklist_motos
        WHERE moto_id = $1 AND (fecha AT TIME ZONE 'America/Caracas')::date = $2::date
          AND NOT anulado`,
      [id, hoy],
    );
    if (ya.rowCount) throw new HttpError(409, 'Esta moto ya tiene checklist registrado hoy');

    let km = null;
    const items = {};
    let hayItemMalo = false;
    const lista = CHECKLISTS[moto.tipo_modelo] || [];

    if (seUso) {
      km = entero(b.kilometraje_inicial, 'Kilometraje inicial', { min: 0 });
      if (km < moto.ultimo_kilometraje) {
        throw bad(`El kilometraje inicial (${km}) no puede ser menor al último registrado (${moto.ultimo_kilometraje})`);
      }
      if (lista.length) {
        /*
         * Los puntos que ya tienen una incidencia sin cerrar no se vuelven
         * a revisar: la falla sigue ahí y reportarla otra vez cada día sólo
         * acumularía incidencias duplicadas de lo mismo. Salen marcados
         * como "en reparación" y se dan por malos sin preguntar.
         */
        const enReparacion = await itemsEnReparacion(id, c);
        const recibidos = b.items;
        if (!recibidos || typeof recibidos !== 'object' || Array.isArray(recibidos)) throw bad('items es obligatorio');
        for (const k of Object.keys(recibidos)) {
          if (!lista.includes(k)) throw bad(`Ítem no válido para ${moto.tipo_modelo}: ${k.slice(0, 60)}`);
        }
        for (const nombre of lista) {
          if (enReparacion.includes(nombre)) {
            // Ya está reportado y abierto: se arrastra como malo, pero no
            // genera una incidencia nueva
            items[nombre] = false;
            continue;
          }
          if (typeof recibidos[nombre] !== 'boolean') throw bad(`Falta revisar el ítem: ${nombre}`);
          items[nombre] = recibidos[nombre];
          if (!recibidos[nombre]) hayItemMalo = true;
        }
      }
    } else if (b.kilometraje_inicial !== undefined && b.kilometraje_inicial !== null && b.kilometraje_inicial !== '') {
      km = entero(b.kilometraje_inicial, 'Kilometraje inicial', { min: 0 });
      // Tampoco se admite hacia atrás cuando la moto no se usó: un odómetro
      // sólo avanza, y un número menor descuadra las cuentas del aceite.
      if (km < moto.ultimo_kilometraje) {
        throw bad(`El kilometraje (${km}) no puede ser menor al último registrado (${moto.ultimo_kilometraje})`);
      }
    }

    const tieneFalla = Boolean(b.tiene_falla) || hayItemMalo;
    const obs = texto(b.observacion_falla, 'Observación de falla', { max: 1000 });
    if (tieneFalla && !obs) throw bad('Debe describir la falla en la observación');

    const cambioAceite = Boolean(b.cambio_aceite_realizado);
    const foto = validarFotoOEnlace(b.foto_falla_url, 'Foto de la falla');

    /*
     * El kilometraje AL MOMENTO del cambio de aceite, que es la marca
     * desde la cual se cuenta hasta el próximo. Antes se usaba el del
     * arranque del día, pero el aceite se cambia durante o después de la
     * jornada, así que ese número quedaba corto.
     *
     * Puede ser igual al del arranque, nunca menor: el odómetro no
     * retrocede entre que la moto sale y le cambian el aceite.
     */
    let kmAceite = null;
    if (cambioAceite) {
      kmAceite = entero(b.km_cambio_aceite, 'Kilometraje del cambio de aceite', { min: 0 });
      const piso = km !== null ? km : moto.ultimo_kilometraje;
      if (kmAceite < piso) {
        throw bad(km !== null
          ? `El kilometraje del cambio de aceite (${kmAceite}) no puede ser menor al del arranque del día (${km})`
          : `El kilometraje del cambio de aceite (${kmAceite}) no puede ser menor al último registrado (${moto.ultimo_kilometraje})`);
      }
    }

    /*
     * Las tres fotos del día son obligatorias, con dos excepciones:
     *
     *  - si la moto NO se usó, no se piden: fotografiar el tablero y la
     *    lata de una moto que no salió del estacionamiento no documenta
     *    nada y gasta el almacén
     *  - si el almacén no está configurado, tampoco, para que el sistema
     *    siga funcionando en vez de dejar al motorizado sin registrar
     */
    const pideFotos = FOTOS_HABILITADAS && seUso;
    const ETIQUETA_FOTO = { tablero: 'del tablero', frontal: 'frontal', trasera: 'trasera (contrapicado)' };
    const fotos = {};
    for (const clave of ['tablero', 'frontal', 'trasera']) {
      const valor = b[`foto_${clave}`];
      const vacia = valor === undefined || valor === null || valor === '';
      if (vacia) {
        if (pideFotos) throw bad(`Falta la foto ${ETIQUETA_FOTO[clave]}`);
        fotos[clave] = null;
      } else {
        fotos[clave] = validarRutaFoto(valor, `Foto ${ETIQUETA_FOTO[clave]}`);
      }
    }

    const ins = await c.query(
      `INSERT INTO checklist_motos
         (moto_id, usuario_id, se_uso_hoy, kilometraje_inicial, cambio_aceite_realizado,
          detalles_items, tiene_falla, observacion_falla, foto_falla_url,
          foto_tablero, foto_frontal, foto_trasera, km_cambio_aceite)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [id, req.usuario.id, seUso, km, cambioAceite, JSON.stringify(items),
        tieneFalla, tieneFalla ? obs : null, foto || null,
        fotos.tablero, fotos.frontal, fotos.trasera, kmAceite],
    );

    /*
     * El odómetro de la moto queda en el número más alto de los tres que
     * conoce: el que tenía, el del arranque del día y el del cambio de
     * aceite. Así nunca retrocede.
     */
    const kmMasAlto = Math.max(
      Number(moto.ultimo_kilometraje) || 0,
      km !== null ? km : 0,
      kmAceite !== null ? kmAceite : 0,
    );
    if (kmMasAlto > Number(moto.ultimo_kilometraje)) {
      await c.query('UPDATE motos SET ultimo_kilometraje = $2 WHERE id = $1', [id, kmMasAlto]);
    }
    // La marca del aceite es el número que escribió el motorizado, no el del arranque
    if (cambioAceite) {
      await c.query('UPDATE motos SET ultimo_cambio_aceite_km = $2 WHERE id = $1', [id, kmAceite]);
    }

    let incidencia = null;
    if (tieneFalla) {
      /*
       * La incidencia cubre sólo los puntos NUEVOS. Los que ya estaban en
       * reparación tienen su propia incidencia abierta y no se duplican.
       *
       * Los nombres quedan en items_afectados, no sólo dentro del texto:
       * así el sistema puede saber qué punto está en reparación y
       * bloquearlo en el checklist siguiente.
       */
      const yaAbiertos = await itemsEnReparacion(id, c);
      const fallos = Object.entries(items)
        .filter(([nombre, ok]) => !ok && !yaAbiertos.includes(nombre))
        .map(([k]) => k);
      const desc = `${obs}${fallos.length ? ` | Ítems con falla: ${fallos.join(', ')}` : ''}`;
      const inc = await c.query(
        `INSERT INTO incidencias (tipo, usuario_id, moto_id, severidad, titulo, descripcion, items_afectados)
         VALUES ('moto', $1, $2, 'alta', $3, $4, $5::jsonb) RETURNING *`,
        [req.usuario.id, id, `Falla en moto ${moto.placa}`, desc.slice(0, 2000),
          JSON.stringify(fallos)],
      );
      incidencia = inc.rows[0];
    }
    return { checklist: ins.rows[0], incidencia, moto };
  });

  if (resultado.incidencia) {
    notificar(`Falla reportada en moto ${resultado.moto.placa}`, {
      'Reportó': nombreCompleto(req.usuario),
      Moto: `${resultado.moto.nombre} - ${resultado.moto.placa}`,
      Detalle: resultado.incidencia.descripcion,
    });
  }
  res.status(201).json({ checklist: resultado.checklist, incidencia: resultado.incidencia });
}));

/* ------------------------------------------------------------------ */
/* Combustible                                                         */
/*                                                                     */
/* Vive en el módulo de Motos y lo registra quien tenga ese módulo,     */
/* porque el que echa gasolina es el motorizado y no tiene por qué      */
/* necesitar permisos de Master para anotarlo. Una carga mal hecha no   */
/* se borra: se anula, igual que el resto de los registros.             */
/*                                                                     */
/* El monto va en bolívares. No entra a los costos operativos del       */
/* cierre de caja: esa gestión se lleva aparte, por decisión del dueño. */
/* ------------------------------------------------------------------ */
const COLS_COMBUSTIBLE = `f.id, f.moto_id, f.litros, f.monto_bs, f.metodo_pago,
            f.fecha_hora, (f.fecha_hora AT TIME ZONE 'America/Caracas')::date AS fecha,
            f.observacion, f.anulado, f.anulado_en, f.motivo_anulacion,
            m.nombre AS moto, m.placa,
            trim(u.nombre || ' ' || u.apellido) AS usuario,
            trim(a.nombre || ' ' || a.apellido) AS anulado_por_nombre`;

app.get('/api/combustible', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, sumarDias(hoy, -30), 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const moto = req.query.moto_id ? entero(req.query.moto_id, 'moto_id', { min: 1 }) : null;
  const verAnulados = tienePermiso(req.usuario, 'ver_anulados') && req.query.anulados === 'true';

  const { rows } = await pool.query(
    `SELECT ${COLS_COMBUSTIBLE}
       FROM combustible_motos f
       JOIN motos m ON m.id = f.moto_id
       JOIN usuarios u ON u.id = f.usuario_id
       LEFT JOIN usuarios a ON a.id = f.anulado_por
      WHERE (f.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR f.moto_id = $3)
        AND ($4::boolean OR NOT f.anulado)
      ORDER BY f.fecha_hora DESC
      LIMIT 300`,
    [desde, hasta, moto, verAnulados],
  );

  // Totales del periodo, sin contar lo anulado
  const vivos = rows.filter((r) => !r.anulado);
  const litros = vivos.reduce((s, r) => s + Number(r.litros), 0);
  const bs = vivos.reduce((s, r) => s + Number(r.monto_bs), 0);

  res.json({
    cargas: rows,
    desde,
    hasta,
    metodos_pago: METODOS_PAGO_COMBUSTIBLE,
    totales: {
      cargas: vivos.length,
      litros: redondearMoneda(litros),
      monto_bs: redondearMoneda(bs),
      bs_por_litro: litros > 0 ? redondearMoneda(bs / litros) : null,
    },
  });
}));

app.post('/api/combustible', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const b = req.body || {};
  const motoId = entero(b.moto_id, 'Moto', { min: 1 });
  const litros = monto(b.litros, 'Litros');
  if (litros <= 0) throw bad('Los litros deben ser mayores que cero');
  const montoBs = monto(b.monto_bs ?? 0, 'Monto en bolívares');
  const metodo = unoDe(b.metodo_pago, METODOS_PAGO_COMBUSTIBLE, 'Método de pago');
  const obs = texto(b.observacion, 'Observación', { max: 300 });

  const { rows: mt } = await pool.query('SELECT id, activa FROM motos WHERE id = $1', [motoId]);
  if (!mt[0]) throw new HttpError(404, 'Moto no encontrada');
  if (!mt[0].activa) throw bad('Esa moto está inactiva');

  const { rows } = await pool.query(
    `INSERT INTO combustible_motos (moto_id, usuario_id, litros, monto_bs, metodo_pago, observacion)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [motoId, req.usuario.id, litros, montoBs, metodo, obs || null],
  );

  const { rows: creada } = await pool.query(
    `SELECT ${COLS_COMBUSTIBLE}
       FROM combustible_motos f
       JOIN motos m ON m.id = f.moto_id
       JOIN usuarios u ON u.id = f.usuario_id
       LEFT JOIN usuarios a ON a.id = f.anulado_por
      WHERE f.id = $1`,
    [rows[0].id],
  );
  res.status(201).json({ carga: creada[0] });
}));

/* ------------------------------------------------------------------ */
/* Apertura de la tienda                                               */
/*                                                                     */
/* Una fila por día. La hora la pone el servidor al marcar la apertura: */
/* no se escribe a mano, igual que el usuario de una anulación.         */
/*                                                                     */
/* Esto es el cimiento de los promedios de finanzas: el promedio diario */
/* se divide entre los días que la tienda abrió, no entre los días del  */
/* calendario. Un domingo cerrado no es un día flojo, es un día que no  */
/* existió.                                                            */
/*                                                                     */
/* Tres estados posibles para un día:                                  */
/*   abierta        -> tiene hora y quién la abrió                      */
/*   cerrada        -> cerrada a propósito, con su motivo               */
/*   sin registrar  -> no tiene fila. Si es día laborable, falta algo   */
/* ------------------------------------------------------------------ */

/** El estado de un día, con todo lo que el frontend necesita para decidir qué mostrar. */
async function estadoDelDia(fecha, usuarioId, cliente) {
  const q = cliente || pool;
  const ajustes = await leerAjustes();
  const { rows } = await q.query(
    `SELECT a.fecha, a.abierta, a.hora_apertura, a.motivo_cierre,
            a.hora_original, a.corregida_en,
            trim(u.nombre || ' ' || u.apellido) AS abrio,
            trim(c.nombre || ' ' || c.apellido) AS corrigio
       FROM aperturas_tienda a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       LEFT JOIN usuarios c ON c.id = a.corregida_por
      WHERE a.fecha = $1::date`,
    [fecha],
  );
  const fila = rows[0] || null;
  const laborable = esDiaLaborable(fecha, ajustes);

  let confirmada = false;
  if (usuarioId) {
    const { rows: cf } = await q.query(
      'SELECT 1 FROM confirmaciones_apertura WHERE fecha = $1::date AND usuario_id = $2',
      [fecha, usuarioId],
    );
    confirmada = cf.length > 0;
  }

  let estado = 'sin_registrar';
  if (fila) estado = fila.abierta ? 'abierta' : 'cerrada';

  return {
    fecha,
    estado,
    laborable,
    // Un día no laborable sin registrar es normal; uno laborable, no
    falta_registrar: estado === 'sin_registrar' && laborable,
    hora_apertura: fila ? fila.hora_apertura : null,
    motivo_cierre: fila ? fila.motivo_cierre : null,
    abrio: fila ? fila.abrio : null,
    corregida: Boolean(fila && fila.corregida_en),
    hora_original: fila ? fila.hora_original : null,
    corrigio: fila ? fila.corrigio : null,
    confirmada_por_mi: confirmada,
  };
}

app.get('/api/tienda/estado', autenticar, asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const fecha = req.query.fecha ? leerFecha(req.query.fecha, hoy, 'fecha') : hoy;
  res.json({
    dia: await estadoDelDia(fecha, req.usuario.id),
    puede_abrir: tieneModulo(req.usuario, 'caja'),
    puede_corregir: req.usuario.es_master === true,
    ve_confirmacion: tienePermiso(req.usuario, 'ver_apertura_diaria'),
  });
}));

/**
 * Marca la tienda como abierta. La hora es la del servidor.
 * Hoy la puede marcar quien tenga Caja; una fecha pasada, sólo el Master,
 * para el caso de que se olvidaran de marcarla ese día.
 */
app.post('/api/tienda/abrir', autenticar, asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const b = req.body || {};
  const fecha = b.fecha ? leerFecha(b.fecha, hoy, 'fecha') : hoy;
  if (fecha > hoy) throw bad('No se puede abrir la tienda en una fecha futura');
  if (fecha !== hoy && !req.usuario.es_master) {
    throw new HttpError(403, 'Sólo el Master puede registrar la apertura de un día pasado');
  }
  if (fecha === hoy && !tieneModulo(req.usuario, 'caja')) {
    throw new HttpError(403, 'No tiene acceso al módulo "caja"');
  }

  const dia = await withTx(async (c) => {
    const { rows } = await c.query(
      'SELECT abierta, motivo_cierre FROM aperturas_tienda WHERE fecha = $1::date FOR UPDATE',
      [fecha],
    );
    if (rows[0] && rows[0].abierta) throw new HttpError(409, 'La tienda ya está marcada como abierta');
    // Si el día estaba marcado como cerrado, abrirlo lo reemplaza
    await c.query(
      `INSERT INTO aperturas_tienda (fecha, abierta, hora_apertura, usuario_id)
       VALUES ($1::date, TRUE, now(), $2)
       ON CONFLICT (fecha) DO UPDATE
         SET abierta = TRUE, hora_apertura = now(), usuario_id = $2,
             motivo_cierre = NULL`,
      [fecha, req.usuario.id],
    );
    return estadoDelDia(fecha, req.usuario.id, c);
  });
  res.status(201).json({ dia });
}));

/** Marca un día como cerrado a propósito, con su motivo. Exclusivo del Master. */
app.put('/api/tienda/cerrada', autenticar, soloAdmin, asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const b = req.body || {};
  const fecha = leerFecha(b.fecha, hoy, 'fecha');
  if (fecha > hoy) throw bad('No se puede marcar una fecha futura');
  const motivo = texto(b.motivo_cierre, 'Motivo', { requerido: true, min: 3, max: 300 });

  const dia = await withTx(async (c) => {
    const { rows } = await c.query(
      `SELECT id FROM cierres_caja WHERE fecha = $1::date AND NOT anulado`, [fecha],
    );
    if (rows.length) {
      throw bad(`El ${fecha} tiene un cierre de caja registrado. Anúlelo antes de marcar el día como cerrado.`);
    }
    await c.query(
      `INSERT INTO aperturas_tienda (fecha, abierta, motivo_cierre)
       VALUES ($1::date, FALSE, $2)
       ON CONFLICT (fecha) DO UPDATE
         SET abierta = FALSE, motivo_cierre = $2,
             hora_apertura = NULL, usuario_id = NULL`,
      [fecha, motivo],
    );
    return estadoDelDia(fecha, req.usuario.id, c);
  });
  res.json({ dia });
}));

/**
 * Corrige una hora de apertura mal registrada, para el caso de que
 * abrieran a las ocho y nadie marcara hasta las dos. La hora original se
 * conserva y la corrección queda firmada.
 */
app.put('/api/tienda/hora', autenticar, soloAdmin, asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const b = req.body || {};
  const fecha = leerFecha(b.fecha, hoy, 'fecha');
  const hora = texto(b.hora, 'Hora', { requerido: true, max: 5 });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw bad('La hora debe tener el formato HH:MM, de 00:00 a 23:59');

  const dia = await withTx(async (c) => {
    const { rows } = await c.query(
      'SELECT abierta, hora_apertura, hora_original FROM aperturas_tienda WHERE fecha = $1::date FOR UPDATE',
      [fecha],
    );
    const actual = rows[0];
    if (!actual) throw new HttpError(404, `El ${fecha} no tiene apertura registrada`);
    if (!actual.abierta) throw bad(`El ${fecha} está marcado como día cerrado`);
    await c.query(
      `UPDATE aperturas_tienda
          SET hora_original = COALESCE(hora_original, hora_apertura),
              hora_apertura = ($2::date + $3::time) AT TIME ZONE 'America/Caracas',
              corregida_por = $4, corregida_en = now()
        WHERE fecha = $1::date`,
      [fecha, fecha, hora, req.usuario.id],
    );
    return estadoDelDia(fecha, req.usuario.id, c);
  });
  res.json({ dia });
}));

/** Confirma que vio la apertura del día. Una vez por persona y por día. */
app.post('/api/tienda/confirmar', autenticar, requierePermiso('ver_apertura_diaria'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  await pool.query(
    `INSERT INTO confirmaciones_apertura (fecha, usuario_id) VALUES ($1::date, $2)
     ON CONFLICT (fecha, usuario_id) DO NOTHING`,
    [hoy, req.usuario.id],
  );
  res.json({ dia: await estadoDelDia(hoy, req.usuario.id) });
}));

/* ------------------------------------------------------------------ */
/* Ajustes del Master                                                  */
/* ------------------------------------------------------------------ */
app.get('/api/ajustes', autenticar, soloAdmin, asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.clave, c.valor, c.actualizado_en,
            trim(u.nombre || ' ' || u.apellido) AS actualizado_por
       FROM configuracion c LEFT JOIN usuarios u ON u.id = c.actualizado_por
      ORDER BY c.clave`,
  );
  res.json({ ajustes: await leerAjustes(), detalle: rows, por_defecto: AJUSTES_POR_DEFECTO });
}));

app.put('/api/ajustes', autenticar, soloAdmin, asyncH(async (req, res) => {
  const b = req.body || {};
  const cambios = [];

  if (b.dias_apertura !== undefined) {
    if (!Array.isArray(b.dias_apertura)) throw bad('Los días de apertura deben ser una lista');
    const dias = [...new Set(b.dias_apertura.map(Number))].sort((x, y) => x - y);
    for (const d of dias) {
      if (!Number.isInteger(d) || d < 1 || d > 7) throw bad('Cada día debe ser un número del 1 (lunes) al 7 (domingo)');
    }
    if (!dias.length) throw bad('Debe quedar al menos un día de apertura');
    cambios.push(['dias_apertura', JSON.stringify(dias)]);
  }
  if (b.km_aceite !== undefined) {
    const v = entero(b.km_aceite, 'Kilómetros entre cambios de aceite', { min: 100, max: 50000 });
    cambios.push(['km_aceite', JSON.stringify(v)]);
  }
  if (b.km_aviso_anticipacion !== undefined) {
    const v = entero(b.km_aviso_anticipacion, 'Kilómetros de anticipación del aviso', { min: 0, max: 10000 });
    cambios.push(['km_aviso_anticipacion', JSON.stringify(v)]);
  }
  if (!cambios.length) throw bad('No se indicó ningún ajuste para cambiar');

  await withTx(async (c) => {
    for (const [clave, valor] of cambios) {
      // eslint-disable-next-line no-await-in-loop
      await c.query(
        `INSERT INTO configuracion (clave, valor, actualizado_por, actualizado_en)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (clave) DO UPDATE
           SET valor = $2::jsonb, actualizado_por = $3, actualizado_en = now()`,
        [clave, valor, req.usuario.id],
      );
    }
  });
  olvidarAjustes();
  res.json({ ajustes: await leerAjustes() });
}));

/* ------------------------------------------------------------------ */
/* Caja                                                                */
/* ------------------------------------------------------------------ */
/**
 * Reglas de cuadre:
 *   total_cierre_bs      = pago_movil_bs + efectivo_bs + punto_venta_bs   (CHECK en la BD)
 *   total_ingreso_dolar  = total_cierre_bs / tasa_dolar
 *   costos_operativos_bs = costos_operativos_usd * tasa_dolar
 *   neto en bolívares    = total_cierre_bs - impuestos - costos_operativos_bs
 *
 * Los costos operativos se escriben en DÓLARES; su equivalente en bolívares
 * se calcula aquí para que el neto cuadre. Todo se calcula en el servidor;
 * si el cliente envía los totales, deben coincidir al centavo.
 */
function leerMontosCaja(b) {
  const pagoMovil = monto(b.pago_movil_bs, 'Pago móvil');
  const efectivo = monto(b.efectivo_bs, 'Efectivo');
  const punto = monto(b.punto_venta_bs, 'Punto de venta');
  const tasa = montoTasa(b.tasa_dolar, 'Tasa del dólar');
  const impuestos = monto(b.impuestos_fiscales_bs, 'Impuestos fiscales');
  const costosUsd = monto(b.costos_operativos_usd, 'Costos operativos (USD)');

  const totalBs = redondearMoneda(pagoMovil + efectivo + punto);
  if (b.total_cierre_bs !== undefined && b.total_cierre_bs !== null && b.total_cierre_bs !== '') {
    const recibido = monto(b.total_cierre_bs, 'Total del cierre');
    if (aCentavos(recibido) !== aCentavos(totalBs)) {
      throw bad(`El total (${totalBs.toFixed(2)}) no cuadra con pago móvil + efectivo + punto (${recibido.toFixed(2)} recibido)`);
    }
  }

  const totalUsd = redondearMoneda(totalBs / tasa);
  if (b.total_ingreso_dolar !== undefined && b.total_ingreso_dolar !== null && b.total_ingreso_dolar !== '') {
    const recibido = monto(b.total_ingreso_dolar, 'Total de ingreso en dólares');
    if (aCentavos(recibido) !== aCentavos(totalUsd)) {
      throw bad(`El ingreso en dólares (${totalUsd.toFixed(2)}) no cuadra con el total en Bs a la tasa indicada`);
    }
  }

  const costosBs = redondearMoneda(costosUsd * tasa);

  return { pagoMovil, efectivo, punto, tasa, impuestos, costosUsd, costosBs, totalBs, totalUsd };
}

/*
 * Cierre fiscal: los datos que salen de la máquina fiscal al hacer el
 * reporte Z del día.
 *
 * TODO se guarda TAL CUAL lo escribe la cajera, copiado del papel de la
 * impresora. El sistema no calcula ninguno de estos números ni los deriva
 * de otro: el que vale es el del papel, y si aquí se recalculara dejaría
 * de coincidir con la máquina.
 *
 * Son dos números de reporte Z y los dos los escribe ella, porque los dos
 * salen impresos: el del reporte anterior y el del día.
 *
 * La última factura va como texto para no perder los ceros de adelante
 * (00010237), que es como la imprime la máquina.
 */
function leerCierreFiscal(b) {
  const zAnterior = entero(b.reporte_z_anterior, 'Último reporte Z', { min: 0, max: 999999999, requerido: true });
  const reporteZ = entero(b.reporte_z, 'N° Reporte Z', { min: 1, max: 999999999, requerido: true });
  const exento = monto(b.exento_bs, 'Exento', { requerido: true });
  const base = monto(b.base_imponible_bs, 'Base imponible 16%', { requerido: true });
  const factura = texto(b.ultima_factura, 'Última factura', { max: 20, requerido: true });
  if (!/^[0-9]{1,20}$/.test(factura)) {
    throw bad('La última factura debe ser sólo números, como aparece en la impresora');
  }
  return { zAnterior, reporteZ, exento, base, factura };
}

/**
 * El último cierre guardado que trae reporte Z, para comparar contra el
 * número que la cajera copió del papel.
 *
 * Es el último cierre NO anulado con fecha anterior a la que se está
 * cerrando. Si se anula un cierre, el anterior pasa a ser el de antes, y
 * la cuenta sigue cuadrando sin tocar nada.
 */
async function ultimoCierreConZ(fecha, cliente = pool) {
  const { rows } = await cliente.query(
    `SELECT fecha, reporte_z FROM cierres_caja
      WHERE NOT anulado AND reporte_z IS NOT NULL AND fecha < $1::date
      ORDER BY fecha DESC LIMIT 1`,
    [fecha],
  );
  return rows[0] || null;
}

/**
 * Revisa los dos números que trae el papel: el del día tiene que ser el
 * siguiente del anterior.
 *
 * Devuelve null si va bien, o el texto del aviso si no. NO impide
 * guardar: el número que manda es el de la impresora, así que el cierre
 * se registra igual y el aviso queda para que el Master lo revise.
 */
function revisarSecuenciaZ(anteriorZ, z) {
  if (anteriorZ === null || anteriorZ === undefined) return null;
  const esperado = anteriorZ + 1;
  if (z === esperado) return null;
  if (z > esperado) {
    const saltados = z - esperado;
    return saltados === 1
      ? `Falta el reporte Z ${esperado}: el anterior es ${anteriorZ} y el del día llegó en ${z}.`
      : `Faltan ${saltados} reportes Z (del ${esperado} al ${z - 1}): el anterior es ${anteriorZ} y el del día llegó en ${z}.`;
  }
  if (z === anteriorZ) return `El reporte Z ${z} está repetido: el anterior trae el mismo número.`;
  return `El reporte Z retrocedió: el anterior es ${anteriorZ} y el del día trae el ${z}.`;
}

/**
 * Revisa el otro lado: que el "último reporte Z" del papel sea el mismo
 * que quedó guardado en el cierre pasado.
 *
 * Si no coinciden, entre un cierre y el otro se hizo un reporte Z que no
 * está registrado, o hubo un día de venta sin cierre de caja. Es lo que
 * más fácil se escapa, porque mirando un solo cierre los dos números
 * calzan perfecto.
 */
function revisarContraCierrePasado(cierrePasado, anteriorZ) {
  if (!cierrePasado || cierrePasado.reporte_z === null) return null;
  if (cierrePasado.reporte_z === anteriorZ) return null;
  return `El papel dice que el reporte anterior es ${anteriorZ}, pero el cierre del ${cierrePasado.fecha} quedó guardado con el ${cierrePasado.reporte_z}.`;
}

/** Los dos avisos juntos, en un solo texto, o null si todo va bien. */
function avisosDelCierre(cierrePasado, anteriorZ, z) {
  const lista = [
    revisarSecuenciaZ(anteriorZ, z),
    revisarContraCierrePasado(cierrePasado, anteriorZ),
  ].filter(Boolean);
  return lista.length ? lista.join(' ') : null;
}

app.get('/api/caja/hoy', autenticar, requiereModulo('caja'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const { rows } = await pool.query(
    `SELECT c.*, trim(u.nombre || ' ' || u.apellido) AS usuario FROM cierres_caja c
       JOIN usuarios u ON u.id = c.usuario_id WHERE c.fecha = $1::date AND NOT c.anulado`,
    [hoy],
  );
  /*
   * El cierre pasado va como referencia: la cajera escribe el número que
   * dice el papel, y el formulario le muestra con qué número quedó el
   * cierre anterior para que note la diferencia si no coinciden.
   */
  const cierrePasado = await ultimoCierreConZ(hoy);
  res.json({ fecha: hoy, cierre: rows[0] || null, cierre_pasado: cierrePasado });
}));

/**
 * Avisos de cierre: los reportes Z que no siguen al del cierre anterior.
 *
 * No se guardan en ninguna parte: se calculan comparando los cierres
 * entre sí cada vez que se piden. Así, si se corrige un número mal
 * escrito o se anula un cierre, el aviso se corrige o desaparece solo.
 * Guardado como registro quedaría señalando un error ya resuelto.
 */
app.get('/api/caja/avisos-cierre', autenticar, requierePermiso('ver_avisos_cierre'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fecha, reporte_z, reporte_z_anterior, pasado_fecha, pasado_z FROM (
       SELECT c.fecha, c.reporte_z, c.reporte_z_anterior,
              lag(c.fecha)     OVER (ORDER BY c.fecha) AS pasado_fecha,
              lag(c.reporte_z) OVER (ORDER BY c.fecha) AS pasado_z
         FROM cierres_caja c
        WHERE NOT c.anulado AND c.reporte_z IS NOT NULL
     ) t
      WHERE reporte_z_anterior IS NOT NULL
        AND (reporte_z <> reporte_z_anterior + 1
             OR (pasado_z IS NOT NULL AND reporte_z_anterior <> pasado_z))
      ORDER BY fecha DESC LIMIT 100`,
  );
  const avisos = rows.map((r) => ({
    fecha: r.fecha,
    reporte_z: r.reporte_z,
    reporte_z_anterior: r.reporte_z_anterior,
    pasado_fecha: r.pasado_fecha,
    pasado_z: r.pasado_z,
    motivo: avisosDelCierre(
      r.pasado_fecha ? { fecha: r.pasado_fecha, reporte_z: r.pasado_z } : null,
      r.reporte_z_anterior,
      r.reporte_z,
    ),
  }));
  res.json({ avisos });
}));

app.get('/api/caja', autenticar, requiereModulo('caja'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const { rows } = await pool.query(
    `SELECT c.*, trim(u.nombre || ' ' || u.apellido) AS usuario FROM cierres_caja c JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.fecha BETWEEN $1::date AND $2::date AND NOT c.anulado
      ORDER BY c.fecha DESC LIMIT 200`,
    [desde, hasta],
  );
  res.json({ cierres: rows });
}));

app.post('/api/caja/cierre', autenticar, requiereModulo('caja'), asyncH(async (req, res) => {
  const b = req.body || {};
  const hoy = hoyCaracas();
  let fecha = hoy;
  if (b.fecha !== undefined && b.fecha !== null && b.fecha !== '' && b.fecha !== hoy) {
    if (!tienePermiso(req.usuario, 'corregir_caja')) {
      throw new HttpError(403, 'No tiene la función "Corregir caja" para registrar cierres de otras fechas');
    }
    fecha = leerFecha(b.fecha, hoy, 'fecha');
    if (fecha > hoy) throw bad('No se puede cerrar una fecha futura');
  }
  const m = leerMontosCaja(b);
  const fi = leerCierreFiscal(b);
  const obs = texto(b.observacion, 'Observación', { max: 500 });

  let avisoZ = null;
  const cierre = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`caja:${fecha}`]);

    /*
     * Sin apertura no hay cierre. La apertura es lo que le dice al
     * sistema que ese día la tienda trabajó, y de eso dependen todos los
     * promedios de finanzas: un día sin apertura no entra al cálculo, así
     * que permitir su cierre dejaría ventas fuera de los promedios.
     */
    const ap = await c.query(
      'SELECT abierta, motivo_cierre FROM aperturas_tienda WHERE fecha = $1::date', [fecha],
    );
    if (!ap.rows[0]) {
      throw bad(fecha === hoy
        ? 'La tienda no está marcada como abierta hoy. Marque la apertura y vuelva a cerrar la caja.'
        : `El ${fecha} no tiene apertura registrada. El Master debe registrarla antes de cerrar esa caja.`);
    }
    if (!ap.rows[0].abierta) {
      throw bad(`El ${fecha} está marcado como día cerrado (${ap.rows[0].motivo_cierre}). No se puede cerrar caja.`);
    }

    const previos = await c.query('SELECT id FROM cierres_caja WHERE fecha = $1::date AND NOT anulado FOR UPDATE', [fecha]);
    if (previos.rowCount) throw new HttpError(409, `La caja del ${fecha} ya fue cerrada`);

    /*
     * El reporte Z del día debe ser el siguiente del anterior, y el
     * anterior que trae el papel debe coincidir con el que quedó en el
     * cierre pasado. Si algo no cuadra, el cierre se guarda igual —el
     * número que manda es el de la impresora— y queda el aviso.
     */
    const pasado = await ultimoCierreConZ(fecha, c);
    avisoZ = avisosDelCierre(pasado, fi.zAnterior, fi.reporteZ);

    const { rows } = await c.query(
      `INSERT INTO cierres_caja
         (fecha, usuario_id, pago_movil_bs, efectivo_bs, punto_venta_bs, total_cierre_bs,
          tasa_dolar, dolares_vendidos, total_ingreso_dolar,
          impuestos_fiscales_bs, costos_operativos_usd, costos_operativos_bs, observacion,
          reporte_z_anterior, reporte_z, exento_bs, base_imponible_bs, ultima_factura)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [fecha, req.usuario.id, m.pagoMovil, m.efectivo, m.punto, m.totalBs,
        m.tasa, m.totalUsd, m.impuestos, m.costosUsd, m.costosBs, obs || null,
        fi.zAnterior, fi.reporteZ, fi.exento, fi.base, fi.factura],
    );
    return rows[0];
  });

  notificar(`Cierre de caja ${fecha}${avisoZ ? ' — revisar el reporte Z' : ''}`, {
    Responsable: nombreCompleto(req.usuario),
    ...(avisoZ ? { 'AVISO DE CIERRE': avisoZ } : {}),
    'Último reporte Z': String(cierre.reporte_z_anterior),
    'N° Reporte Z': String(cierre.reporte_z),
    'Exento (Bs)': cierre.exento_bs.toFixed(2),
    'Base imponible 16% (Bs)': cierre.base_imponible_bs.toFixed(2),
    'Última factura': cierre.ultima_factura,
    'Pago móvil (Bs)': cierre.pago_movil_bs.toFixed(2),
    'Efectivo (Bs)': cierre.efectivo_bs.toFixed(2),
    'Punto de venta (Bs)': cierre.punto_venta_bs.toFixed(2),
    'Total (Bs)': cierre.total_cierre_bs.toFixed(2),
    'Tasa del día': cierre.tasa_dolar.toFixed(4),
    'Ingreso total (USD)': cierre.total_ingreso_dolar.toFixed(2),
    'Impuestos (Bs)': cierre.impuestos_fiscales_bs.toFixed(2),
    'Costos operativos (USD)': cierre.costos_operativos_usd.toFixed(2),
    'Costos operativos (Bs)': cierre.costos_operativos_bs.toFixed(2),
  });
  res.status(201).json({ cierre, aviso_z: avisoZ });
}));

app.put('/api/caja/:id', autenticar, requierePermiso('corregir_caja'), asyncH(async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const m = leerMontosCaja(req.body || {});
  const fi = leerCierreFiscal(req.body || {});
  const obs = texto(req.body && req.body.observacion, 'Observación', { max: 500 });
  let avisoZ = null;
  const cierre = await withTx(async (c) => {
    const { rows } = await c.query('SELECT id, fecha FROM cierres_caja WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, 'Cierre no encontrado');

    const pasado = await ultimoCierreConZ(rows[0].fecha, c);
    avisoZ = avisosDelCierre(pasado, fi.zAnterior, fi.reporteZ);

    const r = await c.query(
      `UPDATE cierres_caja SET pago_movil_bs=$2, efectivo_bs=$3, punto_venta_bs=$4, total_cierre_bs=$5,
              tasa_dolar=$6, dolares_vendidos=0, total_ingreso_dolar=$7,
              impuestos_fiscales_bs=$8, costos_operativos_usd=$9, costos_operativos_bs=$10,
              observacion=$11,
              reporte_z_anterior=$12, reporte_z=$13, exento_bs=$14,
              base_imponible_bs=$15, ultima_factura=$16
       WHERE id=$1 RETURNING *`,
      [id, m.pagoMovil, m.efectivo, m.punto, m.totalBs, m.tasa, m.totalUsd,
        m.impuestos, m.costosUsd, m.costosBs, obs || null,
        fi.zAnterior, fi.reporteZ, fi.exento, fi.base, fi.factura],
    );
    return r.rows[0];
  });
  res.json({ cierre, aviso_z: avisoZ });
}));

/* ------------------------------------------------------------------ */
/* Inventario: proveedores, productos, entradas                        */
/* ------------------------------------------------------------------ */
/* La lista de proveedores también hace falta al pedir agua */
const accesoProveedores = (req, res, next) => {
  if (tieneModulo(req.usuario, 'recepcion') || tieneModulo(req.usuario, 'solicitudes_productos')) return next();
  return next(new HttpError(403, 'No tiene acceso a los proveedores'));
};

/**
 * Con ?tipo=agua o ?tipo=mercancia devuelve sólo los de ese rubro, más los
 * marcados como "ambos". Así al registrar agua no aparecen los de mercancía.
 */
app.get('/api/proveedores', autenticar, accesoProveedores, asyncH(async (req, res) => {
  const tipo = req.query.tipo ? unoDe(req.query.tipo, ['agua', 'mercancia'], 'tipo') : null;
  const { rows } = await pool.query(
    `SELECT * FROM proveedores
      WHERE activo AND ($1::text IS NULL OR tipo = $1 OR tipo = 'ambos')
      ORDER BY nombre`,
    [tipo],
  );
  res.json({ proveedores: rows, tipos: TIPOS_PROVEEDOR, filtrado_por: tipo });
}));

app.post('/api/proveedores', autenticar, accesoProveedores, asyncH(async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO proveedores (nombre, tipo, contacto, rif, telefono, tipo_factura,
                              metodo_pago, dias_credito)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
      unoDe(b.tipo, TIPOS_PROVEEDOR, 'Tipo de proveedor'),
      texto(b.contacto, 'Contacto', { max: 120 }) || null,
      texto(b.rif, 'RIF', { max: 20 }) || null,
      texto(b.telefono, 'Teléfono', { max: 30 }) || null,
      // Si no lo indican, se asume física: es el caso que exige respaldo,
      // así que nadie queda sin foto por omisión.
      b.tipo_factura === undefined ? 'fisica' : unoDe(b.tipo_factura, TIPOS_FACTURA, 'Tipo de factura'),
      b.metodo_pago === undefined ? 'contado' : unoDe(b.metodo_pago, METODOS_PAGO_PROVEEDOR, 'Método de pago'),
      entero(b.dias_credito ?? 0, 'Días de crédito', { min: 0, max: 365 })],
  );
  res.status(201).json({ proveedor: rows[0] });
}));

app.put('/api/proveedores/:id', autenticar, requierePermiso('editar_catalogo'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  // Dar de baja un proveedor es otra función distinta de editarlo
  if (b.activo === false && !tienePermiso(req.usuario, 'eliminar_catalogo')) {
    throw new HttpError(403, 'No tiene la función "Eliminar del catálogo"');
  }
  const { rows } = await pool.query(
    `UPDATE proveedores SET nombre=$2, tipo=$3, contacto=$4, rif=$5, telefono=$6, activo=$7,
            tipo_factura  = COALESCE($8, tipo_factura),
            metodo_pago   = COALESCE($9, metodo_pago),
            dias_credito  = COALESCE($10, dias_credito)
      WHERE id=$1 RETURNING *`,
    [id, texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
      unoDe(b.tipo, TIPOS_PROVEEDOR, 'Tipo de proveedor'),
      texto(b.contacto, 'Contacto', { max: 120 }) || null,
      texto(b.rif, 'RIF', { max: 20 }) || null,
      texto(b.telefono, 'Teléfono', { max: 30 }) || null,
      b.activo === undefined ? true : Boolean(b.activo),
      // Si no viene en la petición se conserva el que tenga
      b.tipo_factura === undefined ? null : unoDe(b.tipo_factura, TIPOS_FACTURA, 'Tipo de factura'),
      b.metodo_pago === undefined ? null : unoDe(b.metodo_pago, METODOS_PAGO_PROVEEDOR, 'Método de pago'),
      b.dias_credito === undefined ? null : entero(b.dias_credito, 'Días de crédito', { min: 0, max: 365 })],
  );
  if (!rows[0]) throw new HttpError(404, 'Proveedor no encontrado');
  res.json({ proveedor: rows[0] });
}));

app.delete('/api/proveedores/:id', autenticar, requierePermiso('eliminar_catalogo'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const { rowCount } = await pool.query('UPDATE proveedores SET activo = FALSE WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Proveedor no encontrado');
  res.json({ ok: true });
}));

app.get('/api/productos', autenticar, (req, res, next) => {
  if (tieneModulo(req.usuario, 'recepcion') || tieneModulo(req.usuario, 'solicitudes_productos')) return next();
  return next(new HttpError(403, 'No tiene acceso al catálogo de productos'));
}, asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, pr.nombre AS proveedor FROM productos p
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_habitual_id
      WHERE p.activo ORDER BY p.subcategoria NULLS FIRST, p.nombre`,
  );
  res.json({
    productos: rows,
    categorias: CATEGORIAS_PRODUCTO,
    empaquetados: EMPAQUETADOS,
    subcategorias: SUBCATEGORIAS,
  });
}));

/* Se puede crear un producto desde Recepción o desde una solicitud de productos */
app.post('/api/productos', autenticar, (req, res, next) => {
  if (tieneModulo(req.usuario, 'recepcion') || tieneModulo(req.usuario, 'solicitudes_productos')) return next();
  return next(new HttpError(403, 'No tiene acceso para registrar productos'));
}, asyncH(async (req, res) => {
  const b = req.body || {};
  const categoria = unoDe(b.categoria, CATEGORIAS_PRODUCTO, 'Categoría');
  const { rows } = await pool.query(
    `INSERT INTO productos
       (nombre, categoria, subcategoria, proveedor_habitual_id, sku,
        empaquetado, unidades_por_empaquetado, precio_usd, stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
      categoria,
      leerSubcategoria(b.subcategoria, categoria),
      entero(b.proveedor_habitual_id, 'Proveedor', { min: 1, requerido: false }),
      texto(b.sku, 'SKU', { max: 40 }) || null,
      unoDe(b.empaquetado === undefined ? 'caja' : b.empaquetado, EMPAQUETADOS, 'Empaquetado'),
      entero(b.unidades_por_empaquetado === undefined ? 1 : b.unidades_por_empaquetado,
        'Unidades por empaque', { min: 1, max: 100000 }),
      monto(b.precio_usd, 'Precio USD'), monto(b.stock, 'Stock')],
  );
  res.status(201).json({ producto: rows[0] });
}));

app.put('/api/productos/:id', autenticar, requierePermiso('editar_catalogo'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const producto = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM productos WHERE id = $1 FOR UPDATE', [id]);
    const actual = rows[0];
    if (!actual) throw new HttpError(404, 'Producto no encontrado');
    const categoria = unoDe(b.categoria, CATEGORIAS_PRODUCTO, 'Categoría');

    // Dar de baja un producto es otra función distinta de editarlo
    if (b.activo === false && actual.activo && !tienePermiso(req.usuario, 'eliminar_catalogo')) {
      throw new HttpError(403, 'No tiene la función "Eliminar del catálogo"');
    }

    // Lo que el formulario no envía se conserva: el precio ya no se edita
    // desde la aplicación, pero no debe perderse al guardar otros campos.
    const precio = b.precio_usd === undefined ? actual.precio_usd : monto(b.precio_usd, 'Precio USD');
    const sku = b.sku === undefined ? actual.sku : (texto(b.sku, 'SKU', { max: 40 }) || null);

    const r = await c.query(
      `UPDATE productos SET nombre=$2, categoria=$3, proveedor_habitual_id=$4, sku=$5,
              empaquetado=$6, unidades_por_empaquetado=$7, precio_usd=$8, stock=$9, activo=$10,
              subcategoria=$11
        WHERE id=$1 RETURNING *`,
      [id, texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
        categoria,
        entero(b.proveedor_habitual_id, 'Proveedor', { min: 1, requerido: false }),
        sku,
        unoDe(b.empaquetado, EMPAQUETADOS, 'Empaquetado'),
        entero(b.unidades_por_empaquetado, 'Unidades por empaque', { min: 1, max: 100000 }),
        precio, monto(b.stock, 'Stock'),
        b.activo === undefined ? true : Boolean(b.activo),
        leerSubcategoria(b.subcategoria, categoria)],
    );
    return r.rows[0];
  });
  res.json({ producto });
}));

app.delete('/api/productos/:id', autenticar, requierePermiso('eliminar_catalogo'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const { rowCount } = await pool.query('UPDATE productos SET activo = FALSE WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Producto no encontrado');
  res.json({ ok: true });
}));

app.get('/api/entradas/agua', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const { rows } = await pool.query(
    `SELECT e.*, (e.fecha_hora AT TIME ZONE 'America/Caracas')::date AS fecha,
            trim(u.nombre || ' ' || u.apellido) AS usuario, p.nombre AS proveedor
       FROM entradas_agua e JOIN usuarios u ON u.id = e.usuario_id
       JOIN proveedores p ON p.id = e.proveedor_id
      WHERE (e.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND NOT e.anulado
      ORDER BY e.fecha_hora DESC LIMIT 200`,
    [desde, hasta],
  );
  res.json({ entradas: rows });
}));

app.post('/api/entradas/agua', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const b = req.body || {};
  const litraje = monto(b.litraje, 'Litraje', { requerido: true });
  if (litraje <= 0) throw bad('El litraje debe ser mayor a 0');
  const proveedor = entero(b.proveedor_id, 'Proveedor', { min: 1 }); // obligatorio en el esquema
  const { rows } = await pool.query(
    `INSERT INTO entradas_agua (usuario_id, proveedor_id, litraje, observaciones, tiene_incidencia)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.usuario.id, proveedor, litraje,
      texto(b.observaciones, 'Observaciones', { max: 500 }) || null, Boolean(b.tiene_incidencia)],
  );
  res.status(201).json({ entrada: rows[0] });
}));

app.get('/api/entradas/mercancia', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const { rows } = await pool.query(
    `SELECT e.*, (e.fecha_hora AT TIME ZONE 'America/Caracas')::date AS fecha,
            trim(u.nombre || ' ' || u.apellido) AS usuario, p.nombre AS proveedor
       FROM entradas_mercancia e JOIN usuarios u ON u.id = e.usuario_id
       JOIN proveedores p ON p.id = e.proveedor_id
      WHERE (e.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND NOT e.anulado
      ORDER BY e.fecha_hora DESC LIMIT 200`,
    [desde, hasta],
  );
  res.json({ entradas: rows });
}));

/**
 * Las solicitudes de mercancía que todavía no se han recibido, para
 * poder elegir una al recibir en vez de cargar los productos a mano.
 *
 * Quedan fuera las anuladas, las rechazadas, las ya completadas y las que
 * ya tienen una recepción viva asociada.
 */
app.get('/api/solicitudes/pendientes-mercancia', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.titulo, s.descripcion, s.estado, s.detalle_items,
            (s.fecha_hora AT TIME ZONE 'America/Caracas')::date AS fecha,
            s.proveedor_id, p.nombre AS proveedor, p.tipo_factura,
            p.metodo_pago, p.dias_credito,
            trim(u.nombre || ' ' || u.apellido) AS pidio
       FROM solicitudes s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN proveedores p ON p.id = s.proveedor_id
      WHERE s.tipo_solicitud = 'mercancia'
        AND NOT s.anulado
        AND s.estado NOT IN ('completada', 'rechazada')
        AND NOT EXISTS (
          SELECT 1 FROM entradas_mercancia e
           WHERE e.solicitud_id = s.id AND NOT e.anulado
        )
      ORDER BY s.fecha_hora DESC
      LIMIT 100`,
  );
  res.json({ solicitudes: rows });
}));

app.post('/api/entradas/mercancia', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const b = req.body || {};
  const proveedor = entero(b.proveedor_id, 'Proveedor', { min: 1 }); // obligatorio en el esquema
  const solicitudId = b.solicitud_id ? uuid(b.solicitud_id, 'Solicitud') : null;

  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 100) {
    throw bad('Debe incluir entre 1 y 100 ítems');
  }

  /*
   * Al recibir contra una solicitud, un ítem puede llegar completo, llegar
   * con otra cantidad o no llegar. Lo que no llegó entra con cantidad 0:
   * queda constancia de que se pidió y no vino, y no suma al stock.
   *
   * En el método manual, en cambio, toda cantidad debe ser mayor que cero:
   * no tiene sentido cargar a mano un producto que no llegó.
   */
  const items = b.items.map((it, i) => {
    const cantidad = monto(it && it.cantidad, `Cantidad del ítem ${i + 1}`, { requerido: true });
    if (cantidad < 0) throw bad(`La cantidad del ítem ${i + 1} no puede ser negativa`);
    if (!solicitudId && cantidad <= 0) throw bad(`La cantidad del ítem ${i + 1} debe ser mayor a 0`);
    return {
      producto_id: entero(it && it.producto_id, `Producto del ítem ${i + 1}`, { min: 1 }),
      cantidad,
      costo_usd: monto(it && it.costo_usd, `Costo del ítem ${i + 1}`),
    };
  });
  if (solicitudId && !items.some((it) => it.cantidad > 0)) {
    throw bad('No llegó ningún producto. Si de verdad no llegó nada, rechace la solicitud en vez de registrar la recepción.');
  }
  const ids = items.map((i) => i.producto_id);
  if (new Set(ids).size !== ids.length) throw bad('Hay productos repetidos en la entrada');

  const obs = texto(b.observaciones, 'Observaciones', { max: 500 });

  const entrada = await withTx(async (c) => {
    /*
     * La foto de la factura se exige según cómo facture el proveedor, no
     * según lo que decida quien está recibiendo:
     *
     *   fisica  -> entrega el papel en la mano, la foto es el respaldo
     *   digital -> la manda al correo de la empresa, no hay papel
     *   ambas   -> depende de la entrega, y ahí sí lo indica el empleado
     *
     * Dejarlo a criterio del empleado abriría la salida de marcar
     * "digital" el día que se pierda el papel, que es justo el día en que
     * el respaldo hace falta.
     */
    const { rows: pv } = await c.query(
      `SELECT id, nombre, tipo_factura, metodo_pago, dias_credito
         FROM proveedores WHERE id = $1 AND activo`, [proveedor],
    );
    if (!pv[0]) throw bad('El proveedor no existe o está inactivo');
    const tipoFactura = pv[0].tipo_factura || 'fisica';

    /*
     * Un proveedor a crédito no entrega factura al recibir: deja una nota
     * de entrega y la factura llega el día que se le paga. Así que no se
     * le puede pedir la foto; en su lugar se anota cuánto se debe, leído
     * de esa nota, y cuándo vence.
     *
     * El método lo decide el proveedor y no quien recibe, igual que el
     * tipo de factura: si fuera opcional, el día que no quisiera escribir
     * el monto marcaría "contado" y se perdería la cuenta.
     */
    const aCredito = pv[0].metodo_pago === 'credito';
    let montoNota = null;
    let venceEl = null;
    if (aCredito) {
      montoNota = monto(b.monto_nota_usd, 'Monto de la nota de entrega', { requerido: true });
      if (montoNota <= 0) throw bad('El monto de la nota de entrega debe ser mayor que cero');
      const dias = Number(pv[0].dias_credito) || 0;
      venceEl = sumarDias(hoyCaracas(), dias);
    }

    const foto = validarFotoOEnlace(b.foto_factura_url, 'Foto de la factura');

    let digital = false;
    if (aCredito) {
      // No hay factura todavía: la foto se pedirá al marcarlo como pagado
      digital = false;
    } else if (tipoFactura === 'digital') {
      digital = true; // ese proveedor nunca entrega papel
    } else if (tipoFactura === 'ambas') {
      digital = Boolean(b.factura_digital);
    } else if (b.factura_digital) {
      throw bad(`${pv[0].nombre} entrega factura física. Tome la foto de la factura.`);
    }

    // Igual que con las fotos del checklist: sólo se exige si el almacén
    // está configurado, para no trancar la recepción por una variable.
    if (!aCredito && !digital && !foto && FOTOS_HABILITADAS) {
      throw bad(tipoFactura === 'ambas'
        ? 'Falta la foto de la factura. Si este proveedor la envió al correo, marque "factura digital".'
        : `${pv[0].nombre} entrega factura física: la foto es obligatoria.`);
    }

    /* La solicitud debe existir, ser de mercancía y no estar ya recibida */
    let solicitud = null;
    if (solicitudId) {
      const { rows: sol } = await c.query(
        `SELECT id, tipo_solicitud, estado, anulado, proveedor_id, detalle_items, titulo
           FROM solicitudes WHERE id = $1 FOR UPDATE`,
        [solicitudId],
      );
      solicitud = sol[0];
      if (!solicitud) throw new HttpError(404, 'La solicitud no existe');
      if (solicitud.tipo_solicitud !== 'mercancia') throw bad('Esa solicitud no es de mercancía');
      if (solicitud.anulado) throw bad('Esa solicitud está anulada');
      if (solicitud.estado === 'completada') throw bad('Esa solicitud ya fue recibida');
      if (solicitud.estado === 'rechazada') throw bad('Esa solicitud fue rechazada');
      const { rows: ya } = await c.query(
        'SELECT id FROM entradas_mercancia WHERE solicitud_id = $1 AND NOT anulado', [solicitudId],
      );
      if (ya.length) throw new HttpError(409, 'Esa solicitud ya tiene una recepción registrada');

      // Lo que se pidió de cada producto, para dejarlo junto a lo que llegó
      const pedido = Object.fromEntries(
        (Array.isArray(solicitud.detalle_items) ? solicitud.detalle_items : [])
          .map((d) => [Number(d.producto_id), Number(d.cantidad_empaques) || 0]),
      );
      for (const it of items) {
        const pedidoDe = pedido[it.producto_id];
        it.cantidad_pedida = pedidoDe === undefined ? null : pedidoDe;
        if (it.cantidad === 0) it.estado = 'no_llego';
        else if (it.cantidad_pedida === null) it.estado = 'no_pedido';
        else if (it.cantidad === it.cantidad_pedida) it.estado = 'completo';
        else it.estado = it.cantidad < it.cantidad_pedida ? 'incompleto' : 'de_mas';
      }
    }

    const { rows: prods } = await c.query(
      'SELECT id, nombre FROM productos WHERE id = ANY($1::int[]) AND activo ORDER BY id FOR UPDATE',
      [ids],
    );
    if (prods.length !== ids.length) throw bad('Algún producto no existe o está inactivo');
    const nombres = Object.fromEntries(prods.map((p) => [p.id, p.nombre]));
    for (const it of items) {
      it.nombre = nombres[it.producto_id];
      // Lo que no llegó no suma al stock
      if (it.cantidad > 0) {
        // eslint-disable-next-line no-await-in-loop
        await c.query('UPDATE productos SET stock = stock + $2 WHERE id = $1', [it.producto_id, it.cantidad]);
      }
    }

    const { rows } = await c.query(
      `INSERT INTO entradas_mercancia
         (usuario_id, proveedor_id, items_recibidos, foto_factura_url, observaciones,
          solicitud_id, factura_digital, a_credito, monto_nota_usd, vence_el)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10::date) RETURNING *`,
      [req.usuario.id, proveedor, JSON.stringify(items), foto || null, obs || null,
        solicitudId, digital, aCredito, montoNota, venceEl],
    );

    // La solicitud se da por cerrada: llega en una sola entrega
    if (solicitudId) {
      await c.query(
        `UPDATE solicitudes SET estado = 'completada', actualizado_en = now() WHERE id = $1`,
        [solicitudId],
      );
    }
    return rows[0];
  });
  res.status(201).json({ entrada });
}));

/* ------------------------------------------------------------------ */
/* Pedidos a crédito por pagar                                         */
/*                                                                     */
/* Los montos van en DÓLARES aunque se paguen en bolívares: una deuda a */
/* quince o treinta días en bolívares no significa nada, porque lo que  */
/* se debe en términos reales cambia con la tasa.                       */
/*                                                                     */
/* Esto NO entra a la contabilidad de la aplicación: ni a finanzas, ni  */
/* a los costos operativos, ni a los promedios. Es un recordatorio de   */
/* lo que hay que pagar y de cuándo se pagó, nada más.                  */
/*                                                                     */
/* Se ve con la función especial "Pedidos por pagar", para que no lo    */
/* tenga delante todo el que recibe mercancía.                          */
/* ------------------------------------------------------------------ */
app.get('/api/credito/pendientes', autenticar, requierePermiso('ver_pedidos_credito'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const incluirPagados = req.query.pagados === 'true';
  const { rows } = await pool.query(
    `SELECT e.id, e.monto_nota_usd, e.vence_el, e.pagado_en, e.foto_factura_url,
            (e.fecha_hora AT TIME ZONE 'America/Caracas')::date AS recibido_el,
            (e.vence_el - $1::date) AS dias_restantes,
            p.nombre AS proveedor, p.dias_credito,
            trim(u.nombre || ' ' || u.apellido) AS recibio,
            trim(g.nombre || ' ' || g.apellido) AS pago,
            e.items_recibidos
       FROM entradas_mercancia e
       JOIN proveedores p ON p.id = e.proveedor_id
       JOIN usuarios u ON u.id = e.usuario_id
       LEFT JOIN usuarios g ON g.id = e.pagado_por
      WHERE e.a_credito AND NOT e.anulado
        AND ($2::boolean OR e.pagado_en IS NULL)
      ORDER BY (e.pagado_en IS NOT NULL), e.vence_el NULLS LAST
      LIMIT 200`,
    [hoy, incluirPagados],
  );

  const pendientes = rows.filter((r) => !r.pagado_en);
  res.json({
    pedidos: rows,
    hoy,
    totales: {
      pendientes: pendientes.length,
      // Sin monto escrito todavía no suma: se informa aparte
      sin_monto: pendientes.filter((r) => r.monto_nota_usd === null).length,
      vencidos: pendientes.filter((r) => r.dias_restantes !== null && r.dias_restantes < 0).length,
      debe_usd: redondearMoneda(
        pendientes.reduce((a, r) => a + (Number(r.monto_nota_usd) || 0), 0),
      ),
    },
  });
}));

/** Corregir el monto de la nota, para cuando quien recibió se equivocó al teclear. */
app.put('/api/credito/:id/monto', autenticar, requierePermiso('ver_pedidos_credito'), asyncH(async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const nuevo = monto(req.body && req.body.monto_nota_usd, 'Monto de la nota', { requerido: true });
  if (nuevo <= 0) throw bad('El monto debe ser mayor que cero');
  const { rows } = await pool.query(
    `UPDATE entradas_mercancia SET monto_nota_usd = $2
      WHERE id = $1 AND a_credito AND NOT anulado RETURNING id, monto_nota_usd`,
    [id, nuevo],
  );
  if (!rows[0]) throw new HttpError(404, 'Ese pedido a crédito no existe o fue anulado');
  res.json({ pedido: rows[0] });
}));

/**
 * Marcar un pedido como pagado. Aquí sí se pide la foto de la factura,
 * porque es el momento en que el proveedor por fin la entrega: el
 * respaldo no se pierde, sólo se aplaza hasta que el papel exista.
 */
app.put('/api/credito/:id/pagado', autenticar, requierePermiso('ver_pedidos_credito'), asyncH(async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const foto = validarFotoOEnlace(req.body && req.body.foto_factura_url, 'Foto de la factura');
  if (!foto && FOTOS_HABILITADAS) {
    throw bad('Falta la foto de la factura que le entregaron al pagar.');
  }
  const pedido = await withTx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, pagado_en, monto_nota_usd FROM entradas_mercancia
        WHERE id = $1 AND a_credito AND NOT anulado FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'Ese pedido a crédito no existe o fue anulado');
    if (rows[0].pagado_en) throw bad('Ese pedido ya estaba marcado como pagado');
    const r = await c.query(
      `UPDATE entradas_mercancia
          SET pagado_en = now(), pagado_por = $2,
              foto_factura_url = COALESCE($3, foto_factura_url)
        WHERE id = $1 RETURNING id, pagado_en, monto_nota_usd`,
      [id, req.usuario.id, foto || null],
    );
    return r.rows[0];
  });
  res.json({ pedido });
}));

/* ------------------------------------------------------------------ */
/* Solicitudes                                                         */
/* ------------------------------------------------------------------ */
app.get('/api/solicitudes', autenticar, requiereAlgunaSolicitud, asyncH(async (req, res) => {
  const categoria = req.query.categoria || 'todas';
  unoDe(categoria, ['negocio', 'productos', 'todas'], 'categoria');

  // Cada sección exige su propio permiso
  let tipos = TIPOS_SOLICITUD;
  if (categoria === 'negocio') {
    if (!tieneModulo(req.usuario, 'solicitudes_negocio')) throw new HttpError(403, 'No tiene acceso a las solicitudes del negocio');
    tipos = TIPOS_SOLICITUD_NEGOCIO;
  } else if (categoria === 'productos') {
    if (!tieneModulo(req.usuario, 'solicitudes_productos')) throw new HttpError(403, 'No tiene acceso a las solicitudes de productos');
    tipos = TIPOS_SOLICITUD_PRODUCTOS;
  }

  const propios = tienePermiso(req.usuario, 'ver_de_todos') ? null : req.usuario.id;
  const verAnuladas = tienePermiso(req.usuario, 'ver_anulados') && req.query.anuladas === 'true';
  const { rows } = await pool.query(
    `SELECT s.*, trim(u.nombre || ' ' || u.apellido) AS usuario,
            p.nombre AS proveedor,
            trim(a.nombre || ' ' || a.apellido) AS anulado_por_nombre
       FROM solicitudes s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN proveedores p ON p.id = s.proveedor_id
       LEFT JOIN usuarios a ON a.id = s.anulado_por
      WHERE ($1::int IS NULL OR s.usuario_id = $1)
        AND s.tipo_solicitud = ANY($2::text[])
        AND ($3::boolean OR NOT s.anulado)
      ORDER BY s.fecha_hora DESC LIMIT 200`,
    [propios, tipos, verAnuladas],
  );
  res.json({
    solicitudes: rows,
    tipos,
    estados: ESTADOS_SOLICITUD,
    categoria,
  });
}));

app.post('/api/solicitudes', autenticar, requiereAlgunaSolicitud, asyncH(async (req, res) => {
  const b = req.body || {};
  const tipo = unoDe(b.tipo_solicitud, TIPOS_SOLICITUD, 'Tipo de solicitud');
  const modulo = moduloDeSolicitud(tipo);
  if (!tieneModulo(req.usuario, modulo)) throw new HttpError(403, `No tiene acceso al módulo "${modulo}"`);

  const titulo = texto(b.titulo, 'Título', { requerido: true, min: 3, max: 120 });
  let proveedor = entero(b.proveedor_id, 'Proveedor', { min: 1, requerido: false });
  let detalle = [];

  if (tipo === 'mercancia') {
    /*
     * El proveedor es obligatorio. Sin él, al recibir la solicitud el
     * sistema no sabe de quién es y no puede decidir si pedir la foto de
     * la factura ni si la entrega va a crédito. De hecho ni se podía
     * recibir, porque la recepción exige proveedor.
     */
    proveedor = entero(b.proveedor_id, 'Proveedor', { min: 1 });
    const { rows: pv } = await pool.query(
      `SELECT id FROM proveedores
        WHERE id = $1 AND activo AND tipo IN ('mercancia', 'ambos')`,
      [proveedor],
    );
    if (!pv[0]) throw bad('Ese proveedor no existe, está inactivo o no es de mercancía');

    // Lista de productos con la cantidad de bultos pedidos
    if (!Array.isArray(b.detalle_items) || b.detalle_items.length === 0 || b.detalle_items.length > 100) {
      throw bad('Debe pedir entre 1 y 100 productos');
    }
    const ids = b.detalle_items.map((it, i) => entero(it && it.producto_id, `Producto del ítem ${i + 1}`, { min: 1 }));
    if (new Set(ids).size !== ids.length) throw bad('Hay productos repetidos en la solicitud');
    const { rows: prods } = await pool.query(
      `SELECT id, nombre, empaquetado, unidades_por_empaquetado
         FROM productos WHERE id = ANY($1::int[]) AND activo`,
      [ids],
    );
    if (prods.length !== ids.length) throw bad('Algún producto no existe o está inactivo');
    const porId = Object.fromEntries(prods.map((p) => [p.id, p]));
    detalle = b.detalle_items.map((it, i) => {
      const cantidad = entero(it && it.cantidad_empaques, `Cantidad del ítem ${i + 1}`, { min: 1, max: 100000 });
      const p = porId[Number(it.producto_id)];
      return {
        producto_id: p.id,
        nombre: p.nombre,
        empaquetado: p.empaquetado,
        unidades_por_empaquetado: p.unidades_por_empaquetado,
        cantidad_empaques: cantidad,
        unidades_totales: cantidad * p.unidades_por_empaquetado,
      };
    });
  } else if (tipo === 'agua') {
    const litraje = monto(b.litraje, 'Litraje', { requerido: true });
    if (litraje <= 0) throw bad('El litraje debe ser mayor a 0');
    proveedor = entero(b.proveedor_id, 'Proveedor', { min: 1 }); // obligatorio para agua
    detalle = [{ litraje }];
  } else if (Array.isArray(b.detalle_items)) {
    detalle = b.detalle_items.slice(0, 100);
  }

  const { rows } = await pool.query(
    `INSERT INTO solicitudes (tipo_solicitud, usuario_id, titulo, descripcion, detalle_items, proveedor_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
    [tipo, req.usuario.id, titulo, texto(b.descripcion, 'Descripción', { max: 2000 }),
      JSON.stringify(detalle), proveedor],
  );

  const resumen = tipo === 'agua'
    ? `${detalle[0].litraje} L`
    : detalle.map((d) => `${d.nombre} x${d.cantidad_empaques} ${d.empaquetado}`).join(', ');
  notificar('Nueva solicitud', {
    Usuario: nombreCompleto(req.usuario),
    Tipo: rows[0].tipo_solicitud,
    'Título': rows[0].titulo,
    Detalle: resumen || rows[0].descripcion,
  });
  res.status(201).json({ solicitud: rows[0] });
}));

app.put('/api/solicitudes/:id', autenticar, requierePermiso('resolver_solicitudes'), asyncH(async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const b = req.body || {};
  const estado = unoDe(b.estado, ESTADOS_SOLICITUD, 'Estado');
  const { rows } = await pool.query(
    'UPDATE solicitudes SET estado = $2, notas_admin = $3 WHERE id = $1 RETURNING *',
    [id, estado, texto(b.notas_admin, 'Notas', { max: 1000 }) || null],
  );
  if (!rows[0]) throw new HttpError(404, 'Solicitud no encontrada');
  res.json({ solicitud: rows[0] });
}));

/* ------------------------------------------------------------------ */
/* Incidencias                                                         */
/* ------------------------------------------------------------------ */
app.get('/api/incidencias', autenticar, requiereModulo('incidencias'), asyncH(async (req, res) => {
  const propios = tienePermiso(req.usuario, 'ver_de_todos') ? null : req.usuario.id;
  const verAnuladas = tienePermiso(req.usuario, 'ver_anulados') && req.query.anuladas === 'true';
  const { rows } = await pool.query(
    `SELECT i.*, trim(u.nombre || ' ' || u.apellido) AS usuario, m.placa, m.nombre AS moto FROM incidencias i
       JOIN usuarios u ON u.id = i.usuario_id LEFT JOIN motos m ON m.id = i.moto_id
      WHERE ($1::int IS NULL OR i.usuario_id = $1) AND ($2::boolean OR NOT i.anulado)
      ORDER BY i.fecha_hora DESC LIMIT 200`,
    [propios, verAnuladas],
  );
  res.json({ incidencias: rows, tipos: TIPOS_INCIDENCIA, estados: ESTADOS_INCIDENCIA, severidades: SEVERIDADES });
}));

app.post('/api/incidencias', autenticar, requiereModulo('incidencias'), asyncH(async (req, res) => {
  const b = req.body || {};
  const tipo = unoDe(b.tipo, TIPOS_INCIDENCIA, 'Tipo de incidencia');
  const severidad = unoDe(b.severidad === undefined ? 'media' : b.severidad, SEVERIDADES, 'Severidad');
  const titulo = texto(b.titulo, 'Título', { requerido: true, min: 3, max: 120 });
  const descripcion = texto(b.descripcion, 'Descripción', { requerido: true, min: 1, max: 2000 });
  const { rows } = await pool.query(
    `INSERT INTO incidencias (tipo, usuario_id, moto_id, cierre_caja_id, severidad, titulo, descripcion)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tipo, req.usuario.id, entero(b.moto_id, 'Moto', { min: 1, requerido: false }),
      b.cierre_caja_id ? uuid(b.cierre_caja_id, 'Cierre de caja') : null, severidad, titulo, descripcion],
  );
  notificar(`Nueva incidencia (${severidad})`, {
    Usuario: nombreCompleto(req.usuario), Tipo: rows[0].tipo,
    'Título': rows[0].titulo, 'Descripción': rows[0].descripcion,
  });
  res.status(201).json({ incidencia: rows[0] });
}));

app.put('/api/incidencias/:id', autenticar, requierePermiso('resolver_incidencias'), asyncH(async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const b = req.body || {};
  const estado = unoDe(b.estado, ESTADOS_INCIDENCIA, 'Estado');
  const { rows } = await pool.query(
    'UPDATE incidencias SET estado = $2, notas_admin = $3 WHERE id = $1 RETURNING *',
    [id, estado, texto(b.notas_admin, 'Notas', { max: 1000 }) || null],
  );
  if (!rows[0]) throw new HttpError(404, 'Incidencia no encontrada');
  res.json({ incidencia: rows[0] });
}));

/* ------------------------------------------------------------------ */
/* Anulación de reportes (exclusiva del Master)                        */
/*                                                                     */
/* Anular no borra: marca el registro, guarda quién, cuándo y por qué, */
/* lo saca de los totales y libera el día para rehacerlo.              */
/* ------------------------------------------------------------------ */
app.put('/api/anular/:recurso/:id', autenticar, requierePermiso('anular_registros'), asyncH(async (req, res) => {
  const { recurso } = req.params;
  const tabla = ANULABLES[recurso]; // lista blanca: nunca llega texto del usuario al SQL
  if (!tabla) throw bad(`Tipo de registro no anulable (${Object.keys(ANULABLES).join(', ')})`);
  const id = uuid(req.params.id, 'id');
  const b = req.body || {};
  const anular = b.anulado === undefined ? true : Boolean(b.anulado);
  const motivo = texto(b.motivo_anulacion, 'Motivo', { max: 500 });
  if (anular && !motivo) throw bad('Debe indicar por qué se anula el registro');

  try {
    const fila = await withTx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM ${tabla} WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new HttpError(404, 'Registro no encontrado');
      if (rows[0].anulado === anular) {
        throw bad(anular ? 'Ese registro ya estaba anulado' : 'Ese registro no está anulado');
      }
      const r = await c.query(
        `UPDATE ${tabla} SET anulado = $2,
                anulado_por = CASE WHEN $2 THEN $3::int ELSE NULL END,
                anulado_en  = CASE WHEN $2 THEN now() ELSE NULL END,
                motivo_anulacion = CASE WHEN $2 THEN $4::text ELSE NULL END
          WHERE id = $1 RETURNING *`,
        [id, anular, req.usuario.id, motivo || null],
      );
      const registro = r.rows[0];

      /*
       * Una entrada de mercancía SUMÓ al stock cuando se registró, así que
       * anularla tiene que devolverlo. Sin esto el registro quedaba
       * anulado pero las cajas seguían contadas, y el inventario mentía
       * sin que nada lo delatara.
       *
       * Los ítems se recorren en orden de producto, el mismo que usa la
       * recepción al bloquearlos, para que dos operaciones simultáneas no
       * se traben entre sí.
       */
      if (recurso === 'entrada-mercancia') {
        const items = (Array.isArray(registro.items_recibidos) ? registro.items_recibidos : [])
          .filter((it) => Number(it.cantidad) > 0) // lo que no llegó nunca sumó
          .sort((x, y) => Number(x.producto_id) - Number(y.producto_id));
        const signo = anular ? -1 : 1;

        for (const it of items) {
          const prodId = Number(it.producto_id);
          const cantidad = Number(it.cantidad);
          // eslint-disable-next-line no-await-in-loop
          const { rows: pr } = await c.query(
            'SELECT id, nombre, stock FROM productos WHERE id = $1 FOR UPDATE', [prodId],
          );
          // Si el producto ya no existe, no hay stock que devolver
          if (!pr[0]) continue;
          const resultante = Number(pr[0].stock) + signo * cantidad;
          /*
           * Si ya se vendió parte de lo que entró, devolver el stock lo
           * dejaría negativo. No se fuerza ni se recorta en silencio: se
           * explica cuál producto lo impide y con cuánto, para que el
           * Master ajuste el inventario a conciencia y vuelva a intentar.
           */
          if (resultante < 0) {
            throw bad(`No se puede anular: de "${pr[0].nombre}" entraron ${nf2(cantidad)} `
              + `y en stock quedan ${nf2(pr[0].stock)}. Ya se vendió parte, así que `
              + 'primero corrija el stock de ese producto y vuelva a anular.');
          }
          // eslint-disable-next-line no-await-in-loop
          await c.query('UPDATE productos SET stock = $2 WHERE id = $1', [prodId, resultante]);
        }
      }

      /*
       * Una recepción puede venir de una solicitud, y al recibirla la
       * solicitud quedó "completada". Si esa recepción se anula, la
       * solicitud tiene que volver a quedar pendiente: lo que se pidió
       * sigue sin recibirse y debe poder recibirse de nuevo.
       */
      if (recurso === 'entrada-mercancia' && registro.solicitud_id) {
        await c.query(
          `UPDATE solicitudes SET estado = $2, actualizado_en = now() WHERE id = $1`,
          [registro.solicitud_id, anular ? 'pendiente' : 'completada'],
        );
      }
      return registro;
    });
    res.json({ recurso, registro: fila });
  } catch (err) {
    // Al reactivar puede chocar con el que ya ocupa ese día o esa fecha
    if (err.code === '23505') {
      let mensaje = 'No se puede reactivar: ya hay otro registro vigente para ese día';
      if (recurso === 'caja') mensaje = 'No se puede reactivar: ya hay otro cierre de caja vigente para esa fecha';
      if (recurso === 'entrada-mercancia') mensaje = 'No se puede reactivar: esa solicitud ya tiene otra recepción vigente';
      throw new HttpError(409, mensaje);
    }
    throw err;
  }
}));

/* ------------------------------------------------------------------ */
/* Reportes Master                                                     */
/* ------------------------------------------------------------------ */
const COLS_SUMA = `
  COALESCE(SUM(pago_movil_bs), 0)::numeric(16,2)         AS pago_movil_bs,
  COALESCE(SUM(efectivo_bs), 0)::numeric(16,2)           AS efectivo_bs,
  COALESCE(SUM(punto_venta_bs), 0)::numeric(16,2)        AS punto_venta_bs,
  COALESCE(SUM(total_cierre_bs), 0)::numeric(16,2)       AS total_bs,
  COALESCE(SUM(dolares_vendidos), 0)::numeric(16,2)      AS dolares_vendidos,
  COALESCE(SUM(total_ingreso_dolar), 0)::numeric(16,2)   AS total_usd,
  COALESCE(SUM(impuestos_fiscales_bs), 0)::numeric(16,2) AS impuestos_bs,
  COALESCE(SUM(costos_operativos_usd), 0)::numeric(16,2) AS costos_usd,
  COALESCE(SUM(costos_operativos_bs), 0)::numeric(16,2)  AS costos_bs,
  COALESCE(SUM(total_cierre_bs - impuestos_fiscales_bs - costos_operativos_bs), 0)::numeric(16,2) AS neto_bs,
  ROUND(AVG(tasa_dolar), 4)                              AS tasa_promedio,
  COUNT(*)                                               AS cierres`;

async function agrupar(unidad, desde, hasta, limite) {
  const { rows } = await pool.query(
    `SELECT date_trunc('${unidad}', fecha::timestamp)::date AS periodo, ${COLS_SUMA}
       FROM cierres_caja WHERE fecha BETWEEN $1::date AND $2::date AND NOT anulado
      GROUP BY 1 ORDER BY 1 DESC LIMIT ${Number(limite)}`,
    [desde, hasta],
  );
  return rows;
}

/**
 * Cuántos días operó la tienda en un rango.
 *
 * Cuenta los días con apertura marcada Y TAMBIÉN los que tengan cierre de
 * caja, unidos sin repetir. Lo segundo es necesario por dos razones: el
 * registro de aperturas empieza el día que se estrena esta función, así
 * que las semanas anteriores no lo tienen; y si alguna vez se olvidan de
 * marcar la apertura pero cierran la caja, ese día igual operó y debe
 * contar.
 *
 * Esto es el divisor de todos los promedios diarios: un domingo cerrado
 * no es un día flojo, es un día que no existió.
 */
async function diasOperados(desde, hasta, cliente) {
  const { rows } = await (cliente || pool).query(
    `SELECT count(*)::int AS dias FROM (
        SELECT fecha FROM aperturas_tienda
         WHERE abierta AND fecha BETWEEN $1::date AND $2::date
        UNION
        SELECT fecha FROM cierres_caja
         WHERE NOT anulado AND fecha BETWEEN $1::date AND $2::date
     ) d`,
    [desde, hasta],
  );
  return rows[0].dias;
}

/** Totales de un rango más sus promedios por día operado. */
async function resumenPeriodo(desde, hasta) {
  const [{ rows }, dias] = await Promise.all([
    pool.query(
      `SELECT ${COLS_SUMA} FROM cierres_caja
        WHERE fecha BETWEEN $1::date AND $2::date AND NOT anulado`,
      [desde, hasta],
    ),
    diasOperados(desde, hasta),
  ]);
  const t = rows[0];
  const totalUsd = Number(t.total_usd) || 0;
  const totalBs = Number(t.total_bs) || 0;
  return {
    desde,
    hasta,
    dias_operados: dias,
    cierres: Number(t.cierres) || 0,
    total_usd: redondearMoneda(totalUsd),
    total_bs: redondearMoneda(totalBs),
    // Sin días operados no hay promedio: se devuelve nulo y el frontend
    // muestra un guion, en vez de un cero que parecería un mal resultado.
    promedio_usd: dias > 0 ? redondearMoneda(totalUsd / dias) : null,
    promedio_bs: dias > 0 ? redondearMoneda(totalBs / dias) : null,
  };
}

/**
 * Promedios de facturación.
 *
 * El dólar manda porque es lo único comparable entre periodos: en
 * bolívares, una tasa que se movió hace parecer que el negocio creció
 * cuando vendió exactamente lo mismo. Los bolívares van al lado como
 * referencia de lo que de verdad pasó por la caja.
 */
app.get('/api/reportes/promedios', autenticar, requierePermiso('ver_finanzas'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();

  /* La semana anterior completa, de lunes a domingo */
  const [anterior] = semanasCompletas(hoy, 1);
  const semanaAnterior = await resumenPeriodo(anterior.desde, anterior.hasta);

  /* Las últimas 4 semanas completas, cada una por separado */
  const cuatro = semanasCompletas(hoy, 4);
  const detalleSemanas = [];
  for (const s of cuatro) {
    // eslint-disable-next-line no-await-in-loop
    detalleSemanas.push(await resumenPeriodo(s.desde, s.hasta));
  }
  /*
   * El promedio semanal se calcula sólo sobre las semanas que tuvieron
   * actividad. Si el negocio arrancó hace dos semanas, dividir entre
   * cuatro daría la mitad de lo real.
   */
  const conDatos = detalleSemanas.filter((s) => s.dias_operados > 0);
  const sumaUsd = conDatos.reduce((a, s) => a + Number(s.total_usd), 0);
  const sumaBs = conDatos.reduce((a, s) => a + Number(s.total_bs), 0);

  /* El mes pasado, que es el último que de verdad terminó */
  const primeroDeEsteMes = `${hoy.slice(0, 7)}-01`;
  const finMesPasado = sumarDias(primeroDeEsteMes, -1);
  const inicioMesPasado = `${finMesPasado.slice(0, 7)}-01`;
  const mesPasado = await resumenPeriodo(inicioMesPasado, finMesPasado);
  const ajustes = await leerAjustes();
  /* Cuántos días de ese mes se esperaba abrir, según el horario */
  let diasEsperados = 0;
  for (let f = inicioMesPasado; f <= finMesPasado; f = sumarDias(f, 1)) {
    if (esDiaLaborable(f, ajustes)) diasEsperados += 1;
  }
  const semanasDelMes = semanasCompletas(sumarDias(finMesPasado, 1), 100)
    .filter((s) => s.desde >= inicioMesPasado && s.hasta <= finMesPasado).length;

  res.json({
    hoy,
    semana_anterior: semanaAnterior,
    ultimas_4_semanas: {
      semanas: detalleSemanas,
      semanas_con_datos: conDatos.length,
      promedio_semanal_usd: conDatos.length ? redondearMoneda(sumaUsd / conDatos.length) : null,
      promedio_semanal_bs: conDatos.length ? redondearMoneda(sumaBs / conDatos.length) : null,
    },
    cierre_mes: {
      ...mesPasado,
      mes: finMesPasado.slice(0, 7),
      dias_esperados: diasEsperados,
      semanas_completas: semanasDelMes,
      promedio_semanal_usd: semanasDelMes > 0
        ? redondearMoneda(Number(mesPasado.total_usd) / semanasDelMes) : null,
      promedio_semanal_bs: semanasDelMes > 0
        ? redondearMoneda(Number(mesPasado.total_bs) / semanasDelMes) : null,
    },
  });
}));

app.get('/api/reportes/financieros', autenticar, requierePermiso('ver_finanzas'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();

  /*
   * Dos formas de pedir el periodo: un rango continuo con desde/hasta, o
   * una lista de días sueltos no consecutivos, para comparar por ejemplo
   * los tres últimos sábados entre sí.
   */
  let dias = null;
  if (req.query.dias) {
    const lista = String(req.query.dias).split(',').map((s) => s.trim()).filter(Boolean);
    if (!lista.length || lista.length > 62) throw bad('Indique entre 1 y 62 días');
    dias = [...new Set(lista.map((d) => leerFecha(d, hoy, 'días')))].sort();
  }

  const desde = dias ? dias[0] : leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = dias ? dias[dias.length - 1] : leerFecha(req.query.hasta, hoy, 'hasta');
  if (desde > hasta) throw bad('"desde" no puede ser posterior a "hasta"');
  const agr = req.query.agrupacion || 'todas';
  unoDe(agr, ['dia', 'semana', 'mes', 'todas'], 'agrupacion');

  const out = { desde, hasta, dias };

  if (dias) {
    // Días sueltos: sólo tiene sentido el total y el detalle por día
    const t = await pool.query(
      `SELECT ${COLS_SUMA} FROM cierres_caja WHERE fecha = ANY($1::date[]) AND NOT anulado`,
      [dias],
    );
    out.totales = t.rows[0];
    const d = await pool.query(
      `SELECT fecha AS periodo, ${COLS_SUMA} FROM cierres_caja
        WHERE fecha = ANY($1::date[]) AND NOT anulado
        GROUP BY 1 ORDER BY 1 DESC`,
      [dias],
    );
    out.diario = d.rows;
    out.dias_operados = (await pool.query(
      `SELECT count(*)::int AS dias FROM (
          SELECT fecha FROM aperturas_tienda WHERE abierta AND fecha = ANY($1::date[])
          UNION
          SELECT fecha FROM cierres_caja WHERE NOT anulado AND fecha = ANY($1::date[])
       ) x`,
      [dias],
    )).rows[0].dias;
  } else {
    const t = await pool.query(
      `SELECT ${COLS_SUMA} FROM cierres_caja WHERE fecha BETWEEN $1::date AND $2::date AND NOT anulado`,
      [desde, hasta],
    );
    out.totales = t.rows[0];
    if (agr === 'dia' || agr === 'todas') out.diario = await agrupar('day', desde, hasta, 120);
    if (agr === 'semana' || agr === 'todas') out.semanal = await agrupar('week', desde, hasta, 104);
    if (agr === 'mes' || agr === 'todas') out.mensual = await agrupar('month', desde, hasta, 60);
    // 1900 es el comodín de "desde el inicio": ahí contar días no aporta
    out.dias_operados = desde === '1900-01-01' ? null : await diasOperados(desde, hasta);
  }

  /* El promedio por día operado, que es la lectura honesta del periodo */
  const totalUsd = Number(out.totales.total_usd) || 0;
  const totalBs = Number(out.totales.total_bs) || 0;
  out.promedios = {
    dias_operados: out.dias_operados,
    por_dia_usd: out.dias_operados > 0 ? redondearMoneda(totalUsd / out.dias_operados) : null,
    por_dia_bs: out.dias_operados > 0 ? redondearMoneda(totalBs / out.dias_operados) : null,
  };

  /* Días laborables del rango sin apertura ni cierre: ahí falta registrar algo */
  if (!dias && desde !== '1900-01-01' && desde >= sumarDias(hoy, -400)) {
    const ajustes = await leerAjustes();
    const { rows: conAlgo } = await pool.query(
      `SELECT fecha FROM aperturas_tienda WHERE fecha BETWEEN $1::date AND $2::date
       UNION
       SELECT fecha FROM cierres_caja WHERE NOT anulado AND fecha BETWEEN $1::date AND $2::date`,
      [desde, hasta],
    );
    const registrados = new Set(conAlgo.map((r) => String(r.fecha).slice(0, 10)));
    const faltan = [];
    for (let f = desde; f <= hasta && f < hoy; f = sumarDias(f, 1)) {
      if (esDiaLaborable(f, ajustes) && !registrados.has(f)) faltan.push(f);
    }
    out.dias_sin_registrar = faltan.slice(0, 60);
  }

  res.json(out);
}));

app.get('/api/reportes/operativos', autenticar, requierePermiso('ver_reportes'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const tipo = req.query.tipo || 'todos';
  unoDe(tipo, ['solicitudes', 'incidencias', 'todos'], 'tipo');
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const estado = req.query.estado ? String(req.query.estado) : null;
  const categoria = req.query.categoria ? String(req.query.categoria) : null;
  const usuarioId = entero(req.query.usuario_id, 'usuario_id', { min: 1, requerido: false });
  if (estado && ![...ESTADOS_SOLICITUD, ...ESTADOS_INCIDENCIA].includes(estado)) throw bad('estado inválido');
  if (categoria && ![...TIPOS_SOLICITUD, ...TIPOS_INCIDENCIA].includes(categoria)) throw bad('categoria inválida');

  const out = { filtros: { tipo, desde, hasta, estado, categoria, usuario_id: usuarioId } };
  const base = [desde, hasta, estado, categoria, usuarioId];

  if (tipo === 'solicitudes' || tipo === 'todos') {
    const filtro = `(s.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR s.estado = $3) AND ($4::text IS NULL OR s.tipo_solicitud = $4)
        AND ($5::int IS NULL OR s.usuario_id = $5) AND NOT s.anulado`;
    const lista = await pool.query(
      `SELECT s.*, trim(u.nombre || ' ' || u.apellido) AS usuario FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id
        WHERE ${filtro} ORDER BY s.fecha_hora DESC LIMIT 500`, base);
    const porEstado = await pool.query(
      `SELECT s.estado, COUNT(*) AS total FROM solicitudes s WHERE ${filtro}
        GROUP BY s.estado ORDER BY s.estado`, base);
    const porCaso = await pool.query(
      `SELECT s.tipo_solicitud AS caso, s.estado, COUNT(*) AS total FROM solicitudes s WHERE ${filtro}
        GROUP BY s.tipo_solicitud, s.estado ORDER BY s.tipo_solicitud, s.estado`, base);
    out.solicitudes = { items: lista.rows, por_estado: porEstado.rows, por_caso: porCaso.rows };
  }

  if (tipo === 'incidencias' || tipo === 'todos') {
    const filtro = `(i.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR i.estado = $3) AND ($4::text IS NULL OR i.tipo = $4)
        AND ($5::int IS NULL OR i.usuario_id = $5) AND NOT i.anulado`;
    const lista = await pool.query(
      `SELECT i.*, trim(u.nombre || ' ' || u.apellido) AS usuario, m.placa, m.nombre AS moto FROM incidencias i
         JOIN usuarios u ON u.id = i.usuario_id LEFT JOIN motos m ON m.id = i.moto_id
        WHERE ${filtro} ORDER BY i.fecha_hora DESC LIMIT 500`, base);
    const porEstado = await pool.query(
      `SELECT i.estado, COUNT(*) AS total FROM incidencias i WHERE ${filtro}
        GROUP BY i.estado ORDER BY i.estado`, base);
    const porCaso = await pool.query(
      `SELECT i.tipo AS caso, i.estado, COUNT(*) AS total FROM incidencias i WHERE ${filtro}
        GROUP BY i.tipo, i.estado ORDER BY i.tipo, i.estado`, base);
    out.incidencias = { items: lista.rows, por_estado: porEstado.rows, por_caso: porCaso.rows };
  }
  res.json(out);
}));

/* ------------------------------------------------------------------ */
/* Reporte de motos (exclusivo del Master)                             */
/* ------------------------------------------------------------------ */
/*
 * El umbral del aceite ahora vive en los ajustes, que el Master cambia
 * desde la aplicación. Antes estaba fijo en 3.000 km y cambiarlo exigía
 * un despliegue.
 */

app.get('/api/reportes/motos', autenticar, requierePermiso('ver_reporte_motos'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const verInactivas = req.query.inactivas === 'true';

  const motos = await pool.query(
    `SELECT m.id, m.nombre, m.color, m.placa, m.tipo_modelo, m.activa,
            m.ultimo_kilometraje, m.ultimo_cambio_aceite_km,
            (m.ultimo_kilometraje - m.ultimo_cambio_aceite_km) AS km_desde_aceite,
            (SELECT count(*) FROM checklist_motos c WHERE c.moto_id = m.id AND NOT c.anulado) AS checklists_total,
            (SELECT count(*) FROM checklist_motos c WHERE c.moto_id = m.id AND c.tiene_falla AND NOT c.anulado) AS checklists_con_falla,
            (SELECT count(*) FROM incidencias i WHERE i.moto_id = m.id AND i.estado <> 'cerrada' AND NOT i.anulado) AS incidencias_abiertas,
            (SELECT max(c.fecha) FROM checklist_motos c WHERE c.moto_id = m.id AND NOT c.anulado) AS ultimo_checklist,
            (SELECT max(c.fecha) FROM checklist_motos c
              WHERE c.moto_id = m.id AND c.cambio_aceite_realizado AND NOT c.anulado) AS ultimo_cambio_aceite,
            EXISTS (SELECT 1 FROM checklist_motos c WHERE c.moto_id = m.id AND NOT c.anulado
                     AND (c.fecha AT TIME ZONE 'America/Caracas')::date = $1::date) AS checklist_hoy
       FROM motos m
      WHERE (m.activa OR $2::boolean)
      ORDER BY m.activa DESC, m.nombre`,
    [hoy, verInactivas],
  );

  // Incidencias abiertas asociadas a una moto
  const incidencias = await pool.query(
    `SELECT i.id, i.moto_id, i.titulo, i.descripcion, i.severidad, i.estado, i.fecha_hora,
            m.placa, m.nombre AS moto, trim(u.nombre || ' ' || u.apellido) AS usuario
       FROM incidencias i
       JOIN motos m ON m.id = i.moto_id
       JOIN usuarios u ON u.id = i.usuario_id
      WHERE i.estado <> 'cerrada' AND NOT i.anulado
      ORDER BY i.fecha_hora DESC LIMIT 100`,
  );

  // Puntos del checklist marcados como falla en los últimos 30 días
  const itemsFalla = await pool.query(
    `SELECT c.moto_id, m.placa, m.nombre AS moto, c.fecha, kv.key AS item,
            trim(u.nombre || ' ' || u.apellido) AS usuario
       FROM checklist_motos c
       JOIN motos m ON m.id = c.moto_id
       JOIN usuarios u ON u.id = c.usuario_id
       CROSS JOIN LATERAL jsonb_each(c.detalles_items) kv
      WHERE c.detalles_items IS NOT NULL
        AND jsonb_typeof(c.detalles_items) = 'object'
        AND kv.value = 'false'::jsonb
        AND NOT c.anulado
        AND c.fecha > now() - interval '30 days'
      ORDER BY c.fecha DESC LIMIT 200`,
  );

  const ajustes = await leerAjustes();
  const conAviso = motos.rows.map((m) => ({ ...m, aviso_aceite: avisoAceite(m, ajustes) }));
  // Entran a la alerta las vencidas y las que ya están en la anticipación
  const aceiteVencido = conAviso
    .filter((m) => m.aviso_aceite.color !== 'gris')
    .map((m) => ({
      moto_id: m.id, moto: m.nombre, placa: m.placa,
      km_desde_aceite: m.km_desde_aceite,
      toca_en: m.aviso_aceite.toca_en,
      faltan: m.aviso_aceite.faltan,
      vencido: m.aviso_aceite.vencido,
    }));

  res.json({
    fecha: hoy,
    km_aviso_aceite: ajustes.km_aceite,
    km_aviso_anticipacion: ajustes.km_aviso_anticipacion,
    motos: conAviso,
    alertas: {
      incidencias_abiertas: incidencias.rows,
      items_en_falla: itemsFalla.rows,
      aceite_vencido: aceiteVencido,
      total: incidencias.rows.length + itemsFalla.rows.length + aceiteVencido.length,
    },
  });
}));

/** Historial completo de una moto */
app.get('/api/reportes/motos/:id', autenticar, requierePermiso('ver_reporte_motos'), asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoyCaracas(), 'hasta');

  const moto = await pool.query('SELECT * FROM motos WHERE id = $1', [id]);
  if (!moto.rows[0]) throw new HttpError(404, 'Moto no encontrada');

  // El historial SÍ muestra lo anulado, marcado como tal: es parte de la historia
  const checklists = await pool.query(
    `SELECT c.*, trim(u.nombre || ' ' || u.apellido) AS usuario,
            trim(a.nombre || ' ' || a.apellido) AS anulado_por_nombre,
            (c.fecha AT TIME ZONE 'America/Caracas')::date AS fecha_local
       FROM checklist_motos c
       JOIN usuarios u ON u.id = c.usuario_id
       LEFT JOIN usuarios a ON a.id = c.anulado_por
      WHERE c.moto_id = $1
        AND (c.fecha AT TIME ZONE 'America/Caracas')::date BETWEEN $2::date AND $3::date
      ORDER BY c.fecha DESC LIMIT 400`,
    [id, desde, hasta],
  );

  const incidencias = await pool.query(
    `SELECT i.*, trim(u.nombre || ' ' || u.apellido) AS usuario,
            trim(a.nombre || ' ' || a.apellido) AS anulado_por_nombre
       FROM incidencias i
       JOIN usuarios u ON u.id = i.usuario_id
       LEFT JOIN usuarios a ON a.id = i.anulado_por
      WHERE i.moto_id = $1 ORDER BY i.fecha_hora DESC LIMIT 200`,
    [id],
  );

  const combustible = await pool.query(
    `SELECT f.id, f.litros, f.monto_bs, f.metodo_pago, f.observacion,
            f.fecha_hora, (f.fecha_hora AT TIME ZONE 'America/Caracas')::date AS fecha,
            f.anulado, f.anulado_en, f.motivo_anulacion,
            trim(u.nombre || ' ' || u.apellido) AS usuario,
            trim(a.nombre || ' ' || a.apellido) AS anulado_por_nombre
       FROM combustible_motos f
       JOIN usuarios u ON u.id = f.usuario_id
       LEFT JOIN usuarios a ON a.id = f.anulado_por
      WHERE f.moto_id = $1
        AND (f.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $2::date AND $3::date
      ORDER BY f.fecha_hora DESC LIMIT 200`,
    [id, desde, hasta],
  );

  /*
   * Los cambios de aceite anulados no cuentan. El kilometraje que se
   * muestra es el que el motorizado escribió al hacer el cambio; para los
   * checklists anteriores a esa casilla, la migración copió el del
   * arranque, que es lo que el sistema venía usando.
   */
  const cambiosAceite = checklists.rows
    .filter((c) => c.cambio_aceite_realizado && !c.anulado)
    .map((c) => ({
      fecha: c.fecha,
      kilometraje: c.km_cambio_aceite !== null && c.km_cambio_aceite !== undefined
        ? c.km_cambio_aceite : c.kilometraje_inicial,
      usuario: c.usuario,
    }));

  const cargasVivas = combustible.rows.filter((f) => !f.anulado);
  const litros = cargasVivas.reduce((a, f) => a + Number(f.litros), 0);
  const gastoBs = cargasVivas.reduce((a, f) => a + Number(f.monto_bs), 0);

  const ajustes = await leerAjustes();
  res.json({
    moto: { ...moto.rows[0], aviso_aceite: avisoAceite(moto.rows[0], ajustes) },
    checklists: checklists.rows,
    incidencias: incidencias.rows,
    cambios_aceite: cambiosAceite,
    combustible: combustible.rows,
    combustible_totales: {
      cargas: cargasVivas.length,
      litros: redondearMoneda(litros),
      monto_bs: redondearMoneda(gastoBs),
      bs_por_litro: litros > 0 ? redondearMoneda(gastoBs / litros) : null,
    },
  });
}));

/* ------------------------------------------------------------------ */
/* Frontend estático (build de Vite) y manejo de errores               */
/* ------------------------------------------------------------------ */
const DIST = [
  process.env.FRONTEND_DIST,
  path.join(__dirname, '..', 'frontend', 'dist'),
  path.join(__dirname, 'public'),
].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'index.html')));

app.use('/api', (req, res, next) => next(new HttpError(404, 'Ruta no encontrada')));

if (DIST) {
  app.use(express.static(DIST, { maxAge: '1h', index: false }));
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'));
  });
  console.log('[web] Sirviendo frontend desde', DIST);
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    // Hay dos límites: 2 MB para una foto y 50 kb para todo lo demás
    const esFoto = req.path.startsWith('/api/fotos/');
    return res.status(413).json({
      error: esFoto
        ? `La foto es demasiado grande (máx. ${Math.round(FOTO_MAX_BYTES / (1024 * 1024))} MB). Vuelva a tomarla.`
        : 'Solicitud demasiado grande (máx. 50kb)',
    });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  switch (err.code) {
    case '23505': return res.status(409).json({ error: 'Registro duplicado (ya existe un dato con ese valor único)' });
    case '23514': return res.status(400).json({ error: 'Los datos no cumplen las reglas de validación' });
    case '23503': return res.status(400).json({ error: 'Referencia a un registro inexistente' });
    case '23502': return res.status(400).json({ error: 'Falta un campo obligatorio' });
    case '42703': return res.status(500).json({ error: 'Falta aplicar la migración de la base de datos' });
    case '22P02':
    case '22003': return res.status(400).json({ error: 'Valor con formato inválido' });
    default: break;
  }
  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ error: 'Error interno del servidor' });
});

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */
const server = app.listen(PORT, async () => {
  console.log(`Purissima Cloud escuchando en el puerto ${PORT} (${TZ})`);

  /*
   * Deja dicho si las fotos quedaron encendidas. Las claves del almacén
   * se leen una sola vez, al arrancar: si se agregan en Render sin
   * reiniciar el servicio, siguen sin efecto, y sin esta línea la única
   * forma de notarlo era abrir el formulario en el teléfono y mirar si
   * las fotos salían como obligatorias.
   */
  if (FOTOS_HABILITADAS) {
    console.log(`[fotos] Activadas. Almacén "${BUCKET_FOTOS}" en ${SUPABASE_URL}`);
  } else {
    /*
     * Distingue "no existe" de "existe pero vacía": decir sólo "falta"
     * dejaba sin saber si el nombre estaba mal escrito o si el valor no
     * se había pegado.
     */
    const estado = (nombre) => {
      if (!(nombre in process.env)) return 'NO EXISTE';
      const v = process.env[nombre];
      if (v === '') return 'existe pero está VACÍA';
      if (v.trim() === '') return 'existe pero sólo tiene espacios';
      return `definida (${v.trim().length} caracteres)`;
    };
    console.warn(`[fotos] Desactivadas. SUPABASE_URL: ${estado('SUPABASE_URL')}`);
    console.warn(`[fotos] Desactivadas. SUPABASE_SERVICE_KEY: ${estado('SUPABASE_SERVICE_KEY')}`);
    /*
     * Lista los NOMBRES de las variables parecidas que sí llegaron, para
     * cazar un nombre mal escrito. Sólo los nombres: el valor de una
     * clave no se escribe nunca en el registro.
     */
    const parecidas = Object.keys(process.env).filter((k) => /supa/i.test(k));
    console.warn(`[fotos] Variables cuyo nombre contiene "supa": ${parecidas.length ? parecidas.join(', ') : 'ninguna'}`);
    console.warn('[fotos] El sistema funciona igual, pero no acepta fotos y el checklist no las exige.');
  }

  try {
    app.locals.esquemaOk = await verificarEsquema();
  } catch (err) {
    console.error('[esquema] No se pudo verificar:', err.message);
  }
});

function apagar(signal) {
  console.log(`${signal} recibido, cerrando...`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));

module.exports = { app, redondearMoneda, escapeHtml, firmarJwt, verificarJwt, CHECKLISTS };
