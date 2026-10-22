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

const MODULOS_VALIDOS = Object.freeze(['motos', 'caja', 'recepcion', 'solicitudes', 'incidencias']);

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
const ESTADOS_SOLICITUD = ['pendiente', 'aprobada', 'en_proceso', 'completada', 'rechazada'];
const TIPOS_INCIDENCIA = ['financiera_caja', 'cliente', 'operativa_tienda', 'moto', 'agua', 'seguridad', 'otro'];
const ESTADOS_INCIDENCIA = ['abierta', 'en_revision', 'cerrada'];
const SEVERIDADES = ['baja', 'media', 'alta'];
const TIPOS_PROVEEDOR = ['agua', 'mercancia', 'ambos'];
const CATEGORIAS_PRODUCTO = ['mercancia', 'insumo_tienda', 'agua'];

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
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${TZ}'`).catch(() => {});
});
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
  ['productos', 'unidad'],
  ['proveedores', 'telefono'],
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
  console.log('[esquema] Verificado: todas las columnas requeridas están presentes.');
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
      'SELECT id, nombre, rol, modulos_permitidos, activo FROM usuarios WHERE id = $1',
      [payload.sub],
    );
    const u = rows[0];
    if (!u || !u.activo) throw new HttpError(401, 'Usuario inexistente o desactivado');
    req.usuario = u; // permisos siempre frescos desde la BD
    next();
  } catch (err) {
    next(err);
  }
}

const soloAdmin = (req, res, next) =>
  (req.usuario.rol === 'admin' ? next() : next(new HttpError(403, 'Acceso exclusivo del Master')));

const requiereModulo = (modulo) => (req, res, next) => {
  const u = req.usuario;
  if (u.rol === 'admin' || (Array.isArray(u.modulos_permitidos) && u.modulos_permitidos.includes(modulo))) return next();
  return next(new HttpError(403, `No tiene acceso al módulo "${modulo}"`));
};

const usuarioPublico = (u) => ({
  id: u.id, nombre: u.nombre, rol: u.rol, modulos_permitidos: u.modulos_permitidos,
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
  const nombre = texto(req.body && req.body.nombre, 'Usuario', { requerido: true, max: 80 });
  const pin = req.body && req.body.pin;
  if (!esPinValido(pin)) throw new HttpError(401, 'Credenciales inválidas');

  const { rows } = await pool.query(
    `SELECT id, nombre, rol, modulos_permitidos, activo, intentos_fallidos, bloqueado_hasta,
            (pin_hash = crypt($2, pin_hash)) AS pin_ok
       FROM usuarios WHERE lower(nombre) = lower($1)`,
    [nombre, pin],
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
  if (!u.activo) throw new HttpError(401, 'Credenciales inválidas');

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

app.get('/api/usuarios', autenticar, soloAdmin, asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, rol, modulos_permitidos, activo, creado_en,
            (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado
       FROM usuarios ORDER BY nombre`,
  );
  res.json({ usuarios: rows, modulos_disponibles: MODULOS_VALIDOS });
}));

app.post('/api/usuarios', autenticar, soloAdmin, asyncH(async (req, res) => {
  const b = req.body || {};
  const nombre = texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 80 });
  const rol = unoDe(b.rol, ['motorizados', 'tienda', 'admin'], 'Rol');
  if (!esPinValido(b.pin)) throw bad('El PIN debe tener entre 4 y 8 dígitos');
  const modulos = validarModulos(b.modulos_permitidos || []);
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, rol, pin_hash, modulos_permitidos)
     VALUES ($1, $2, crypt($3, gen_salt('bf', 10)), $4::jsonb)
     RETURNING id, nombre, rol, modulos_permitidos, activo, creado_en`,
    [nombre, rol, b.pin, JSON.stringify(modulos)],
  );
  res.status(201).json({ usuario: rows[0] });
}));

/* Endpoint exclusivo del Master: actualiza el JSONB de módulos */
app.put('/api/usuarios/:id/permisos', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const modulos = validarModulos(req.body && req.body.modulos_permitidos);
  const { rows } = await pool.query(
    `UPDATE usuarios SET modulos_permitidos = $2::jsonb WHERE id = $1
     RETURNING id, nombre, rol, modulos_permitidos, activo`,
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

app.put('/api/usuarios/:id/activo', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  if (typeof (req.body && req.body.activo) !== 'boolean') throw bad('activo debe ser booleano');
  if (id === req.usuario.id && req.body.activo === false) throw bad('No puede desactivar su propia cuenta');
  const { rows } = await pool.query(
    'UPDATE usuarios SET activo = $2 WHERE id = $1 RETURNING id, nombre, rol, modulos_permitidos, activo',
    [id, req.body.activo],
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
            m.placa, m.nombre AS moto, m.tipo_modelo, u.nombre AS usuario
       FROM checklist_motos c
       JOIN motos m ON m.id = c.moto_id
       JOIN usuarios u ON u.id = c.usuario_id
      WHERE (c.fecha AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR c.usuario_id = $3)
        AND (NOT $4::boolean OR c.tiene_falla)
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
        WHERE moto_id = $1 AND (fecha AT TIME ZONE 'America/Caracas')::date = $2::date`,
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
      'Reportó': req.usuario.nombre,
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
 *   total_cierre_bs     = pago_movil_bs + efectivo_bs + punto_venta_bs   (CHECK en la BD)
 *   total_ingreso_dolar = total_cierre_bs / tasa_dolar + dolares_vendidos
 * Ambos se calculan en el servidor; si el cliente los envía, deben coincidir al centavo.
 */
function leerMontosCaja(b) {
  const pagoMovil = monto(b.pago_movil_bs, 'Pago móvil');
  const efectivo = monto(b.efectivo_bs, 'Efectivo');
  const punto = monto(b.punto_venta_bs, 'Punto de venta');
  const tasa = montoTasa(b.tasa_dolar, 'Tasa del dólar');
  const dolares = monto(b.dolares_vendidos, 'Dólares vendidos');
  const impuestos = monto(b.impuestos_fiscales_bs, 'Impuestos fiscales');
  const costos = monto(b.costos_operativos_bs, 'Costos operativos');

  const totalBs = redondearMoneda(pagoMovil + efectivo + punto);
  if (b.total_cierre_bs !== undefined && b.total_cierre_bs !== null && b.total_cierre_bs !== '') {
    const recibido = monto(b.total_cierre_bs, 'Total del cierre');
    if (aCentavos(recibido) !== aCentavos(totalBs)) {
      throw bad(`El total (${totalBs.toFixed(2)}) no cuadra con pago móvil + efectivo + punto (${recibido.toFixed(2)} recibido)`);
    }
  }

  const totalUsd = redondearMoneda(redondearMoneda(totalBs / tasa) + dolares);
  if (b.total_ingreso_dolar !== undefined && b.total_ingreso_dolar !== null && b.total_ingreso_dolar !== '') {
    const recibido = monto(b.total_ingreso_dolar, 'Total de ingreso en dólares');
    if (aCentavos(recibido) !== aCentavos(totalUsd)) {
      throw bad(`El ingreso en dólares (${totalUsd.toFixed(2)}) no cuadra con el total en Bs a la tasa indicada`);
    }
  }

  return { pagoMovil, efectivo, punto, tasa, dolares, impuestos, costos, totalBs, totalUsd };
}

app.get('/api/caja/hoy', autenticar, requiereModulo('caja'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const { rows } = await pool.query(
    `SELECT c.*, u.nombre AS usuario FROM cierres_caja c
       JOIN usuarios u ON u.id = c.usuario_id WHERE c.fecha = $1::date`,
    [hoy],
  );
  res.json({ fecha: hoy, cierre: rows[0] || null });
}));

app.get('/api/caja', autenticar, requiereModulo('caja'), asyncH(async (req, res) => {
  const hoy = hoyCaracas();
  const desde = leerFecha(req.query.desde, '1900-01-01', 'desde');
  const hasta = leerFecha(req.query.hasta, hoy, 'hasta');
  const { rows } = await pool.query(
    `SELECT c.*, u.nombre AS usuario FROM cierres_caja c JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.fecha BETWEEN $1::date AND $2::date ORDER BY c.fecha DESC LIMIT 200`,
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
    const previos = await c.query('SELECT id FROM cierres_caja WHERE fecha = $1::date FOR UPDATE', [fecha]);
    if (previos.rowCount) throw new HttpError(409, `La caja del ${fecha} ya fue cerrada`);
    const { rows } = await c.query(
      `INSERT INTO cierres_caja
         (fecha, usuario_id, pago_movil_bs, efectivo_bs, punto_venta_bs, total_cierre_bs,
          tasa_dolar, dolares_vendidos, total_ingreso_dolar,
          impuestos_fiscales_bs, costos_operativos_bs, observacion)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [fecha, req.usuario.id, m.pagoMovil, m.efectivo, m.punto, m.totalBs,
        m.tasa, m.dolares, m.totalUsd, m.impuestos, m.costos, obs || null],
    );
    return rows[0];
  });

  notificar(`Cierre de caja ${fecha}`, {
    Responsable: req.usuario.nombre,
    'Pago móvil (Bs)': cierre.pago_movil_bs.toFixed(2),
    'Efectivo (Bs)': cierre.efectivo_bs.toFixed(2),
    'Punto de venta (Bs)': cierre.punto_venta_bs.toFixed(2),
    'Total (Bs)': cierre.total_cierre_bs.toFixed(2),
    'Tasa del día': cierre.tasa_dolar.toFixed(4),
    'Dólares vendidos': cierre.dolares_vendidos.toFixed(2),
    'Ingreso total (USD)': cierre.total_ingreso_dolar.toFixed(2),
    'Impuestos (Bs)': cierre.impuestos_fiscales_bs.toFixed(2),
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
              tasa_dolar=$6, dolares_vendidos=$7, total_ingreso_dolar=$8,
              impuestos_fiscales_bs=$9, costos_operativos_bs=$10, observacion=$11
       WHERE id=$1 RETURNING *`,
      [id, m.pagoMovil, m.efectivo, m.punto, m.totalBs, m.tasa, m.dolares, m.totalUsd,
        m.impuestos, m.costos, obs || null],
    );
    return r.rows[0];
  });
  res.json({ cierre });
}));

/* ------------------------------------------------------------------ */
/* Inventario: proveedores, productos, entradas                        */
/* ------------------------------------------------------------------ */
app.get('/api/proveedores', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM proveedores WHERE activo ORDER BY nombre');
  res.json({ proveedores: rows, tipos: TIPOS_PROVEEDOR });
}));

app.post('/api/proveedores', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
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

app.get('/api/productos', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, pr.nombre AS proveedor FROM productos p
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_habitual_id
      WHERE p.activo ORDER BY p.nombre`,
  );
  res.json({ productos: rows, categorias: CATEGORIAS_PRODUCTO });
}));

app.post('/api/productos', autenticar, requiereModulo('recepcion'), asyncH(async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO productos (nombre, categoria, proveedor_habitual_id, sku, unidad, precio_usd, stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
      unoDe(b.categoria, CATEGORIAS_PRODUCTO, 'Categoría'),
      entero(b.proveedor_habitual_id, 'Proveedor', { min: 1, requerido: false }),
      texto(b.sku, 'SKU', { max: 40 }) || null,
      texto(b.unidad, 'Unidad', { max: 20 }) || 'unidad',
      monto(b.precio_usd, 'Precio USD'), monto(b.stock, 'Stock')],
  );
  res.status(201).json({ producto: rows[0] });
}));

app.put('/api/productos/:id', autenticar, soloAdmin, asyncH(async (req, res) => {
  const id = entero(req.params.id, 'id', { min: 1 });
  const b = req.body || {};
  const producto = await withTx(async (c) => {
    const { rows } = await c.query('SELECT id FROM productos WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, 'Producto no encontrado');
    const r = await c.query(
      `UPDATE productos SET nombre=$2, categoria=$3, proveedor_habitual_id=$4, sku=$5,
              unidad=$6, precio_usd=$7, stock=$8, activo=$9 WHERE id=$1 RETURNING *`,
      [id, texto(b.nombre, 'Nombre', { requerido: true, min: 2, max: 120 }),
        unoDe(b.categoria, CATEGORIAS_PRODUCTO, 'Categoría'),
        entero(b.proveedor_habitual_id, 'Proveedor', { min: 1, requerido: false }),
        texto(b.sku, 'SKU', { max: 40 }) || null,
        texto(b.unidad, 'Unidad', { max: 20 }) || 'unidad',
        monto(b.precio_usd, 'Precio USD'), monto(b.stock, 'Stock'),
        b.activo === undefined ? true : Boolean(b.activo)],
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
            u.nombre AS usuario, p.nombre AS proveedor
       FROM entradas_agua e JOIN usuarios u ON u.id = e.usuario_id
       JOIN proveedores p ON p.id = e.proveedor_id
      WHERE (e.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
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
            u.nombre AS usuario, p.nombre AS proveedor
       FROM entradas_mercancia e JOIN usuarios u ON u.id = e.usuario_id
       JOIN proveedores p ON p.id = e.proveedor_id
      WHERE (e.fecha_hora AT TIME ZONE 'America/Caracas')::date BETWEEN $1::date AND $2::date
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
app.get('/api/solicitudes', autenticar, requiereModulo('solicitudes'), asyncH(async (req, res) => {
  const propios = req.usuario.rol === 'admin' ? null : req.usuario.id;
  const { rows } = await pool.query(
    `SELECT s.*, u.nombre AS usuario FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE ($1::int IS NULL OR s.usuario_id = $1) ORDER BY s.fecha_hora DESC LIMIT 200`,
    [propios],
  );
  res.json({ solicitudes: rows, tipos: TIPOS_SOLICITUD, estados: ESTADOS_SOLICITUD });
}));

app.post('/api/solicitudes', autenticar, requiereModulo('solicitudes'), asyncH(async (req, res) => {
  const b = req.body || {};
  const tipo = unoDe(b.tipo_solicitud, TIPOS_SOLICITUD, 'Tipo de solicitud');
  const titulo = texto(b.titulo, 'Título', { requerido: true, min: 3, max: 120 });
  const detalle = Array.isArray(b.detalle_items) ? b.detalle_items.slice(0, 100) : [];
  const { rows } = await pool.query(
    `INSERT INTO solicitudes (tipo_solicitud, usuario_id, titulo, descripcion, detalle_items)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [tipo, req.usuario.id, titulo, texto(b.descripcion, 'Descripción', { max: 2000 }), JSON.stringify(detalle)],
  );
  notificar('Nueva solicitud', {
    Usuario: req.usuario.nombre, Tipo: rows[0].tipo_solicitud,
    'Título': rows[0].titulo, 'Descripción': rows[0].descripcion,
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
    `SELECT i.*, u.nombre AS usuario, m.placa, m.nombre AS moto FROM incidencias i
       JOIN usuarios u ON u.id = i.usuario_id LEFT JOIN motos m ON m.id = i.moto_id
      WHERE ($1::int IS NULL OR i.usuario_id = $1) ORDER BY i.fecha_hora DESC LIMIT 200`,
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
    Usuario: req.usuario.nombre, Tipo: rows[0].tipo,
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
  COALESCE(SUM(costos_operativos_bs), 0)::numeric(16,2)  AS costos_bs,
  COALESCE(SUM(total_cierre_bs - impuestos_fiscales_bs - costos_operativos_bs), 0)::numeric(16,2) AS neto_bs,
  ROUND(AVG(tasa_dolar), 4)                              AS tasa_promedio,
  COUNT(*)                                               AS cierres`;

async function agrupar(unidad, desde, hasta, limite) {
  const { rows } = await pool.query(
    `SELECT date_trunc('${unidad}', fecha::timestamp)::date AS periodo, ${COLS_SUMA}
       FROM cierres_caja WHERE fecha BETWEEN $1::date AND $2::date
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
    `SELECT ${COLS_SUMA} FROM cierres_caja WHERE fecha BETWEEN $1::date AND $2::date`,
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
        AND ($5::int IS NULL OR s.usuario_id = $5)`;
    const lista = await pool.query(
      `SELECT s.*, u.nombre AS usuario FROM solicitudes s JOIN usuarios u ON u.id = s.usuario_id
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
        AND ($5::int IS NULL OR i.usuario_id = $5)`;
    const lista = await pool.query(
      `SELECT i.*, u.nombre AS usuario, m.placa, m.nombre AS moto FROM incidencias i
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
