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

/* Registros que el Master puede anular, con el nombre de su tabla */
const ANULABLES = Object.freeze({
  checklist: 'checklist_motos',
  caja: 'cierres_caja',
  'entrada-agua': 'entradas_agua',
  'entrada-mercancia': 'entradas_mercancia',
  solicitud: 'solicitudes',
  incidencia: 'incidencias',
});

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
    console.error(' Ejecute: database/migracion_001_modulos_y_reportes.sql');
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

async function autenticar(req, res, next) {
  try {
    const cab = req.get('authorization') || '';
    const token = cab.startsWith('Bearer ') ? cab.slice(7).trim() : '';
    const payload = verificarJwt(token);
    if (!payload) throw new HttpError(401, 'Sesión inválida o vencida');
    const { rows } = await pool.query(
      `SELECT id, usuario, nombre, apellido, rol, modulos_permitidos, estado
         FROM usuarios WHERE id = $1`,
      [payload.sub],
    );
    const u = rows[0];
    if (!u || u.estado !== 'activo') throw new HttpError(401, 'Su cuenta no tiene acceso. Consulte con el Master.');
    req.usuario = u; // permisos siempre frescos desde la BD
    next();
  } catch (err) {
    next(err);
  }
}

const soloAdmin = (req, res, next) =>
  (req.usuario.rol === 'admin' ? next() : next(new HttpError(403, 'Acceso exclusivo del Master')));

const tieneModulo = (u, modulo) =>
  u.rol === 'admin' || (Array.isArray(u.modulos_permitidos) && u.modulos_permitidos.includes(modulo));

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
  modulos_permitidos: u.modulos_permitidos,
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
    `SELECT id, usuario, nombre, apellido, rol, modulos_permitidos, estado,
            intentos_fallidos, bloqueado_hasta,
            (pin_hash = crypt($2, pin_hash)) AS pin_ok
       FROM usuarios WHERE lower(usuario) = lower($1)`,
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
  res.json({ token: firmarJwt({ sub: u.id, rol: u.rol }), usuario: usuarioPublico(u) });
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

const COLS_USUARIO = `id, usuario, nombre, apellido, rol, modulos_permitidos, estado, activo, creado_en,
            trim(nombre || ' ' || apellido) AS nombre_completo,
            (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado`;

/** El usuario de ingreso: sin espacios, de 3 a 40 caracteres. */
function nombreUsuario(valor) {
  const u = texto(valor, 'Usuario', { requerido: true, min: 3, max: 40 });
  if (/\s/.test(u)) throw bad('El usuario no puede tener espacios');
  return u;
}

app.get('/api/usuarios', autenticar, soloAdmin, asyncH(async (req, res) => {
  const incluirEliminados = req.query.eliminados === 'true';
  const { rows } = await pool.query(
    `SELECT ${COLS_USUARIO} FROM usuarios
      WHERE ($1::boolean OR estado <> 'eliminado')
      ORDER BY estado, nombre, apellido`,
    [incluirEliminados],
  );
  res.json({ usuarios: rows, modulos_disponibles: MODULOS_VALIDOS, estados: ESTADOS_USUARIO });
}));

app.post('/api/usuarios', autenticar, soloAdmin, asyncH(async (req, res) => {
  const b = req.body || {};
  const usuario = nombreUsuario(b.usuario);
  const nombre = texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 80 });
  const apellido = texto(b.apellido, 'Apellido', { max: 80 });
  const rol = unoDe(b.rol, ['motorizados', 'tienda', 'admin'], 'Rol');
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
app.put('/api/usuarios/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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
    const rol = b.rol !== undefined
      ? unoDe(b.rol, ['motorizados', 'tienda', 'admin'], 'Rol') : actual.rol;

    // Protección: el Master no puede quitarse a sí mismo el rol de admin
    if (id === req.usuario.id && rol !== 'admin') {
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
app.put('/api/usuarios/:id/estado', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const estado = unoDe(req.body && req.body.estado, ESTADOS_USUARIO, 'Estado');
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

app.put('/api/usuarios/:id/pin', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  if (!esPinValido(req.body && req.body.pin)) throw bad('El PIN debe tener entre 4 y 8 dígitos');
  const { rowCount } = await pool.query(
    `UPDATE usuarios SET pin_hash = crypt($2, gen_salt('bf', 10)),
            intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`,
    [id, req.body.pin],
  );
  if (!rowCount) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ ok: true });
}));

/** Se conserva por compatibilidad: equivale a estado activo/pausado. */
app.put('/api/usuarios/:id/activo', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  if (typeof (req.body && req.body.activo) !== 'boolean') throw bad('activo debe ser booleano');
  if (id === req.usuario.id && req.body.activo === false) throw bad('No puede desactivar su propia cuenta');
  const { rows } = await pool.query(
    `UPDATE usuarios SET estado = $2 WHERE id = $1 RETURNING ${COLS_USUARIO}`,
    [id, req.body.activo ? 'activo' : 'pausado'],
  );
  if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
  res.json({ usuario: rows[0] });
}));

/* ------------------------------------------------------------------ */
/* Motos                                                               */
/* ------------------------------------------------------------------ */
app.get('/api/motos/config', autenticar, requiereModulo('motos'), (req, res) => {
  res.json({ checklists: CHECKLISTS });
});

app.get('/api/motos', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const verTodas = req.usuario.rol === 'admin' && req.query.todas === 'true';
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
  res.json({ motos: rows, fecha: hoy });
}));

app.post('/api/motos', autenticar, soloAdmin, asyncH(async (req, res) => {
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

app.put('/api/motos/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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

app.delete('/api/motos/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const { rowCount } = await pool.query('UPDATE motos SET activa = FALSE WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Moto no encontrada');
  res.json({ ok: true });
}));

app.get('/api/motos/checklists', autenticar, requiereModulo('motos'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, req.usuario.rol === 'admin' ? '1900-01-01' : hoy, 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const soloFallas = req.query.fallas === 'true';
  const propios = req.usuario.rol === 'admin' ? null : req.usuario.id;
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
        const recibidos = b.items;
        if (!recibidos || typeof recibidos !== 'object' || Array.isArray(recibidos)) throw bad('items es obligatorio');
        for (const k of Object.keys(recibidos)) {
          if (!lista.includes(k)) throw bad(`Ítem no válido para ${moto.tipo_modelo}: ${k.slice(0, 60)}`);
        }
        for (const nombre of lista) {
          if (typeof recibidos[nombre] !== 'boolean') throw bad(`Falta revisar el ítem: ${nombre}`);
          items[nombre] = recibidos[nombre];
          if (!recibidos[nombre]) hayItemMalo = true;
        }
      }
    } else if (b.kilometraje_inicial !== undefined && b.kilometraje_inicial !== null && b.kilometraje_inicial !== '') {
      km = entero(b.kilometraje_inicial, 'Kilometraje inicial', { min: 0 });
    }

    const tieneFalla = Boolean(b.tiene_falla) || hayItemMalo;
    const obs = texto(b.observacion_falla, 'Observación de falla', { max: 1000 });
    if (tieneFalla && !obs) throw bad('Debe describir la falla en la observación');

    const cambioAceite = Boolean(b.cambio_aceite_realizado);
    const foto = texto(b.foto_falla_url, 'URL de la foto', { max: 500 });
    if (foto && !/^https?:\/\//i.test(foto)) throw bad('La URL de la foto debe empezar por http:// o https://');

    const ins = await c.query(
      `INSERT INTO checklist_motos
         (moto_id, usuario_id, se_uso_hoy, kilometraje_inicial, cambio_aceite_realizado,
          detalles_items, tiene_falla, observacion_falla, foto_falla_url)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING *`,
      [id, req.usuario.id, seUso, km, cambioAceite, JSON.stringify(items),
        tieneFalla, tieneFalla ? obs : null, foto || null],
    );

    // Actualiza kilometraje y, si corresponde, el km del cambio de aceite
    if (km !== null && km > moto.ultimo_kilometraje) {
      await c.query('UPDATE motos SET ultimo_kilometraje = $2 WHERE id = $1', [id, km]);
    }
    if (cambioAceite) {
      const kmFinal = km !== null && km > moto.ultimo_kilometraje ? km : moto.ultimo_kilometraje;
      await c.query('UPDATE motos SET ultimo_cambio_aceite_km = $2 WHERE id = $1', [id, kmFinal]);
    }

    let incidencia = null;
    if (tieneFalla) {
      const fallos = Object.entries(items).filter(([, ok]) => !ok).map(([k]) => k);
      const desc = `${obs}${fallos.length ? ` | Ítems con falla: ${fallos.join(', ')}` : ''}`;
      const inc = await c.query(
        `INSERT INTO incidencias (tipo, usuario_id, moto_id, severidad, titulo, descripcion)
         VALUES ('moto', $1, $2, 'alta', $3, $4) RETURNING *`,
        [req.usuario.id, id, `Falla en moto ${moto.placa}`, desc.slice(0, 2000)],
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

app.get('/api/caja/hoy', autenticar, requiereModulo('caja'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const { rows } = await pool.query(
    `SELECT c.*, trim(u.nombre || ' ' || u.apellido) AS usuario FROM cierres_caja c
       JOIN usuarios u ON u.id = c.usuario_id WHERE c.fecha = $1::date AND NOT c.anulado`,
    [hoy],
  );
  res.json({ fecha: hoy, cierre: rows[0] || null });
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
    if (req.usuario.rol !== 'admin') throw new HttpError(403, 'Solo el Master puede registrar cierres de otras fechas');
    fecha = leerFecha(b.fecha, hoy, 'fecha');
    if (fecha > hoy) throw bad('No se puede cerrar una fecha futura');
  }
  const m = leerMontosCaja(b);
  const obs = texto(b.observacion, 'Observación', { max: 500 });

  const cierre = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`caja:${fecha}`]);
    const previos = await c.query('SELECT id FROM cierres_caja WHERE fecha = $1::date AND NOT anulado FOR UPDATE', [fecha]);
    if (previos.rowCount) throw new HttpError(409, `La caja del ${fecha} ya fue cerrada`);
    const { rows } = await c.query(
      `INSERT INTO cierres_caja
         (fecha, usuario_id, pago_movil_bs, efectivo_bs, punto_venta_bs, total_cierre_bs,
          tasa_dolar, dolares_vendidos, total_ingreso_dolar,
          impuestos_fiscales_bs, costos_operativos_usd, costos_operativos_bs, observacion)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12) RETURNING *`,
      [fecha, req.usuario.id, m.pagoMovil, m.efectivo, m.punto, m.totalBs,
        m.tasa, m.totalUsd, m.impuestos, m.costosUsd, m.costosBs, obs || null],
    );
    return rows[0];
  });

  notificar(`Cierre de caja ${fecha}`, {
    Responsable: nombreCompleto(req.usuario),
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
  res.status(201).json({ cierre });
}));

app.put('/api/caja/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = uuid(req.params.id, 'id');
  const m = leerMontosCaja(req.body || {});
  const obs = texto(req.body && req.body.observacion, 'Observación', { max: 500 });
  const cierre = await withTx(async (c) => {
    const { rows } = await c.query('SELECT id FROM cierres_caja WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, 'Cierre no encontrado');
    const r = await c.query(
      `UPDATE cierres_caja SET pago_movil_bs=$2, efectivo_bs=$3, punto_venta_bs=$4, total_cierre_bs=$5,
              tasa_dolar=$6, dolares_vendidos=0, total_ingreso_dolar=$7,
              impuestos_fiscales_bs=$8, costos_operativos_usd=$9, costos_operativos_bs=$10,
              observacion=$11
       WHERE id=$1 RETURNING *`,
      [id, m.pagoMovil, m.efectivo, m.punto, m.totalBs, m.tasa, m.totalUsd,
        m.impuestos, m.costosUsd, m.costosBs, obs || null],
    );
    return r.rows[0];
  });
  res.json({ cierre });
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
    'INSERT INTO proveedores (nombre, tipo, contacto, rif, telefono) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
      unoDe(b.tipo, TIPOS_PROVEEDOR, 'Tipo de proveedor'),
      texto(b.contacto, 'Contacto', { max: 120 }) || null,
      texto(b.rif, 'RIF', { max: 20 }) || null,
      texto(b.telefono, 'Teléfono', { max: 30 }) || null],
  );
  res.status(201).json({ proveedor: rows[0] });
}));

app.put('/api/proveedores/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE proveedores SET nombre=$2, tipo=$3, contacto=$4, rif=$5, telefono=$6, activo=$7
      WHERE id=$1 RETURNING *`,
    [id, texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
      unoDe(b.tipo, TIPOS_PROVEEDOR, 'Tipo de proveedor'),
      texto(b.contacto, 'Contacto', { max: 120 }) || null,
      texto(b.rif, 'RIF', { max: 20 }) || null,
      texto(b.telefono, 'Teléfono', { max: 30 }) || null,
      b.activo === undefined ? true : Boolean(b.activo)],
  );
  if (!rows[0]) throw new HttpError(404, 'Proveedor no encontrado');
  res.json({ proveedor: rows[0] });
}));

app.delete('/api/proveedores/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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

app.put('/api/productos/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const producto = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM productos WHERE id = $1 FOR UPDATE', [id]);
    const actual = rows[0];
    if (!actual) throw new HttpError(404, 'Producto no encontrado');
    const categoria = unoDe(b.categoria, CATEGORIAS_PRODUCTO, 'Categoría');

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

app.delete('/api/productos/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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

app.post('/api/entradas/mercancia', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const b = req.body || {};
  const proveedor = entero(b.proveedor_id, 'Proveedor', { min: 1 }); // obligatorio en el esquema
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 100) {
    throw bad('Debe incluir entre 1 y 100 ítems');
  }
  const items = b.items.map((it, i) => {
    const cantidad = monto(it && it.cantidad, `Cantidad del ítem ${i + 1}`, { requerido: true });
    if (cantidad <= 0) throw bad(`La cantidad del ítem ${i + 1} debe ser mayor a 0`);
    return {
      producto_id: entero(it && it.producto_id, `Producto del ítem ${i + 1}`, { min: 1 }),
      cantidad,
      costo_usd: monto(it && it.costo_usd, `Costo del ítem ${i + 1}`),
    };
  });
  const ids = items.map((i) => i.producto_id);
  if (new Set(ids).size !== ids.length) throw bad('Hay productos repetidos en la entrada');

  const foto = texto(b.foto_factura_url, 'URL de la factura', { max: 500 });
  if (foto && !/^https?:\/\//i.test(foto)) throw bad('La URL de la factura debe empezar por http:// o https://');

  const entrada = await withTx(async (c) => {
    const { rows: prods } = await c.query(
      'SELECT id, nombre FROM productos WHERE id = ANY($1::int[]) AND activo ORDER BY id FOR UPDATE',
      [ids],
    );
    if (prods.length !== ids.length) throw bad('Algún producto no existe o está inactivo');
    const nombres = Object.fromEntries(prods.map((p) => [p.id, p.nombre]));
    for (const it of items) {
      await c.query('UPDATE productos SET stock = stock + $2 WHERE id = $1', [it.producto_id, it.cantidad]);
      it.nombre = nombres[it.producto_id];
    }
    const { rows } = await c.query(
      `INSERT INTO entradas_mercancia (usuario_id, proveedor_id, items_recibidos, foto_factura_url, observaciones)
       VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING *`,
      [req.usuario.id, proveedor, JSON.stringify(items), foto || null,
        texto(b.observaciones, 'Observaciones', { max: 500 }) || null],
    );
    return rows[0];
  });
  res.status(201).json({ entrada });
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

  const propios = req.usuario.rol === 'admin' ? null : req.usuario.id;
  const verAnuladas = req.usuario.rol === 'admin' && req.query.anuladas === 'true';
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

app.put('/api/solicitudes/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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
  const propios = req.usuario.rol === 'admin' ? null : req.usuario.id;
  const { rows } = await pool.query(
    `SELECT i.*, trim(u.nombre || ' ' || u.apellido) AS usuario, m.placa, m.nombre AS moto FROM incidencias i
       JOIN usuarios u ON u.id = i.usuario_id LEFT JOIN motos m ON m.id = i.moto_id
      WHERE ($1::int IS NULL OR i.usuario_id = $1) AND NOT i.anulado
      ORDER BY i.fecha_hora DESC LIMIT 200`,
    [propios],
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

app.put('/api/incidencias/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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
app.put('/api/anular/:recurso/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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
      return r.rows[0];
    });
    res.json({ recurso, registro: fila });
  } catch (err) {
    // Al reactivar puede chocar con el que ya ocupa ese día o esa fecha
    if (err.code === '23505') {
      throw new HttpError(409, recurso === 'caja'
        ? 'No se puede reactivar: ya hay otro cierre de caja vigente para esa fecha'
        : 'No se puede reactivar: ya hay otro registro vigente para ese día');
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

app.get('/api/reportes/financieros', autenticar, soloAdmin, asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  if (desde > hasta) throw bad('"desde" no puede ser posterior a "hasta"');
  const agr = req.query.agrupacion || 'todas';
  unoDe(agr, ['dia', 'semana', 'mes', 'todas'], 'agrupacion');

  const out = { desde, hasta };
  const t = await pool.query(
    `SELECT ${COLS_SUMA} FROM cierres_caja WHERE fecha BETWEEN $1::date AND $2::date AND NOT anulado`,
    [desde, hasta],
  );
  out.totales = t.rows[0];
  if (agr === 'dia' || agr === 'todas') out.diario = await agrupar('day', desde, hasta, 120);
  if (agr === 'semana' || agr === 'todas') out.semanal = await agrupar('week', desde, hasta, 104);
  if (agr === 'mes' || agr === 'todas') out.mensual = await agrupar('month', desde, hasta, 60);
  res.json(out);
}));

app.get('/api/reportes/operativos', autenticar, soloAdmin, asyncH(async (req, res) => {
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
const KM_AVISO_ACEITE = Number(process.env.KM_AVISO_ACEITE) || 3000;

app.get('/api/reportes/motos', autenticar, soloAdmin, asyncH(async (req, res) => {
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

  const aceiteVencido = motos.rows
    .filter((m) => m.km_desde_aceite >= KM_AVISO_ACEITE)
    .map((m) => ({ moto_id: m.id, moto: m.nombre, placa: m.placa, km_desde_aceite: m.km_desde_aceite }));

  res.json({
    fecha: hoy,
    km_aviso_aceite: KM_AVISO_ACEITE,
    motos: motos.rows,
    alertas: {
      incidencias_abiertas: incidencias.rows,
      items_en_falla: itemsFalla.rows,
      aceite_vencido: aceiteVencido,
      total: incidencias.rows.length + itemsFalla.rows.length + aceiteVencido.length,
    },
  });
}));

/** Historial completo de una moto */
app.get('/api/reportes/motos/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
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

  // Los cambios de aceite anulados no cuentan
  const cambiosAceite = checklists.rows
    .filter((c) => c.cambio_aceite_realizado && !c.anulado)
    .map((c) => ({ fecha: c.fecha, kilometraje: c.kilometraje_inicial, usuario: c.usuario }));

  res.json({
    moto: moto.rows[0],
    checklists: checklists.rows,
    incidencias: incidencias.rows,
    cambios_aceite: cambiosAceite,
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
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande (máx. 50kb)' });
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
