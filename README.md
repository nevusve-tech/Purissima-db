const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

// Configuración Cloud: Confiar en el Balanceador de Carga (Cloudflare / AWS / Render / Railway)
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Validación estricta de variables en producción Cloud
if (process.env.NODE_ENV === 'production' && (!process.env.DATABASE_URL || !process.env.TOKEN_SECRET)) {
  console.error('FATAL CLOUD ERROR: Faltan variables obligatorias DATABASE_URL o TOKEN_SECRET.');
  process.exit(1);
}

// Configuración de PostgreSQL Cloud (Soporte SSL obligatorio para Supabase/Neon/RDS)
const isProduction = process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://usuario:password@localhost:5432/purissima_db',
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  statement_timeout: 10000
});

pool.on('error', (err) => {
  console.error('Error en pool de PostgreSQL:', err.message);
});

// Endpoint de Health Check (Obligatorio para Cloud Run, Railway, Load Balancers)
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', details: 'Database unreachable' });
  }
});

// Configuración de Correo
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER || 'tu_usuario',
    pass: process.env.SMTP_PASS || 'tu_password'
  }
});

function escapeHtml(unsafeText) {
  if (unsafeText === null || unsafeText === undefined) return '';
  return String(unsafeText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function enviarAlertaCorreo(asunto, mensajeHtml) {
  const asuntoLimpio = `🚨 ALERTA PURISSIMA: ${String(asunto).replace(/[\r\n]/g, ' ')}`;
  const destinatario = process.env.ADMIN_EMAIL || 'gerencia@purissima.com';

  try {
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Sistema Purissima <sistema@purissima.com>',
          to: [destinatario],
          subject: asuntoLimpio,
          html: mensajeHtml
        }),
        signal: AbortSignal.timeout(4000)
      });
      return;
    }

    await Promise.race([
      transporter.sendMail({
        from: process.env.EMAIL_FROM || '"Sistema Purissima Cloud" <sistema@purissima.com>',
        to: destinatario,
        subject: asuntoLimpio,
        html: mensajeHtml
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout SMTP Cloud (4s)')), 4000))
    ]);
  } catch (error) {
    console.error('Error enviando correo de alerta:', error.message);
  }
}

// Utilidades de Seguridad (Tokens HMAC y Auth Middleware)
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

function generarToken(payload) {
  const data = Buffer.from(JSON.stringify({
    ...payload,
    exp: Date.now() + (12 * 60 * 60 * 1000)
  })).toString('base64url');
  const firma = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  return `${data}.${firma}`;
}

function verificarToken(token) {
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [data, firma] = partes;
  const firmaEsperada = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  
  if (firma.length !== firmaEsperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(firmaEsperada))) {
    return null;
  }
  const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  if (Date.now() > payload.exp) return null;
  return payload;
}

function autenticar(rolesPermitidos = []) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autorizado. Token requerido.' });
    }
    const token = authHeader.split(' ')[1];
    const usuario = verificarToken(token);
    
    if (!usuario) {
      return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
    if (rolesPermitidos.length > 0 && !rolesPermitidos.includes(usuario.rol)) {
      return res.status(403).json({ error: 'No tienes permisos para realizar esta acción.' });
    }
    req.usuario = usuario;
    next();
  };
}

function redondearMoneda(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

// ============================================================================
// ENDPOINTS DE LA API CLOUD
// ============================================================================

// 1. LOGIN POR PIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { pin } = req.body;
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos numéricos.' });
    }

    const query = `
      SELECT id, nombre, rol 
      FROM usuarios 
      WHERE activo = true 
        AND (bloqueado_hasta IS NULL OR bloqueado_hasta < CURRENT_TIMESTAMP)
        AND pin_hash = crypt($1, pin_hash)
      LIMIT 1
    `;
    const result = await pool.query(query, [pin]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'PIN inválido o usuario inactivo/bloqueado.' });
    }
    
    const usuario = result.rows[0];
    const token = generarToken({ id: usuario.id, rol: usuario.rol, nombre: usuario.nombre });

    res.json({ success: true, token, usuario });
  } catch (err) {
    console.error('Error en login:', err.message);
    res.status(500).json({ error: 'Error interno en el servidor.' });
  }
});

// 2. OBTENER MOTOS
app.get('/api/motos', autenticar(['motorizados', 'admin']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM motos ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener motos.' });
  }
});

// 3. GUARDAR CHECKLIST DE MOTO (Transaccional ACID)
app.post('/api/motos/checklist', autenticar(['motorizados', 'admin']), async (req, res) => {
  const { moto_id, se_uso_hoy, kilometraje_inicial, cambio_aceite_realizado, detalles_items, observacion_falla, foto_falla_url } = req.body;
  const usuario_id = req.usuario.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!se_uso_hoy) {
      const r = await client.query(
        'INSERT INTO checklist_motos (moto_id, usuario_id, se_uso_hoy) VALUES ($1, $2, false) RETURNING *',
        [moto_id, usuario_id]
      );
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Moto inactiva hoy', data: r.rows[0] });
    }

    const kmInicialNum = Number(kilometraje_inicial);
    const motoInfo = await client.query('SELECT ultimo_kilometraje, ultimo_cambio_aceite_km FROM motos WHERE id = $1 FOR UPDATE', [moto_id]);
    
    if (motoInfo.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Moto no encontrada.' });
    }

    const motoActual = motoInfo.rows[0];
    if (kmInicialNum < motoActual.ultimo_kilometraje) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El kilometraje no puede ser menor al anterior.' });
    }

    let tieneFalla = false;
    if (detalles_items && typeof detalles_items === 'object') {
      tieneFalla = Object.values(detalles_items).some(val => ['x', '❌', 'falla', 'malo'].includes(String(val).trim().toLowerCase()));
    }

    if (tieneFalla && (!observacion_falla || String(observacion_falla).trim().length === 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La observación de falla es obligatoria.' });
    }

    const nuevoKmAceite = cambio_aceite_realizado ? kmInicialNum : motoActual.ultimo_cambio_aceite_km;

    await client.query(
      'UPDATE motos SET ultimo_kilometraje = $1, ultimo_cambio_aceite_km = $2 WHERE id = $3',
      [kmInicialNum, nuevoKmAceite, moto_id]
    );

    const newChecklist = await client.query(
      `INSERT INTO checklist_motos (moto_id, usuario_id, se_uso_hoy, kilometraje_inicial, cambio_aceite_realizado, detalles_items, tiene_falla, observacion_falla, foto_falla_url)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [moto_id, usuario_id, kmInicialNum, Boolean(cambio_aceite_realizado), JSON.stringify(detalles_items), tieneFalla, observacion_falla || null, foto_falla_url || null]
    );

    await client.query('COMMIT');

    if (kmInicialNum - nuevoKmAceite >= 1500) {
      enviarAlertaCorreo('Mantenimiento de Aceite Requerido', `<p>Moto ID ${moto_id} superó los 1,500 km.</p>`);
    }
    if (tieneFalla) {
      enviarAlertaCorreo(`Falla Crítica en Moto ID ${moto_id}`, `<p>${escapeHtml(observacion_falla)}</p>`);
    }

    res.status(201).json({ success: true, data: newChecklist.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Error interno al procesar checklist.' });
  } finally {
    client.release();
  }
});

// 4. CIERRE DE CAJA FINANCIERO (Con manejo de duplicados por índice único)
app.post('/api/caja/cierre', autenticar(['tienda', 'admin']), async (req, res) => {
  const { pago_movil_bs, efectivo_bs, punto_venta_bs, tasa_dolar, dolares_vendidos, impuestos_fiscales_bs = 0, costos_operativos_bs = 0, incidencia_caja } = req.body;
  const usuario_id = req.usuario.id;

  const pmBs = Number(pago_movil_bs);
  const efBs = Number(efectivo_bs);
  const pvBs = Number(punto_venta_bs);
  const tasa = Number(tasa_dolar);
  const usdVendidos = Number(dolares_vendidos);

  if ([pmBs, efBs, pvBs, usdVendidos].some(m => m < 0) || tasa <= 0) {
    return res.status(400).json({ error: 'Montos y tasa deben ser mayores a 0.' });
  }

  const total_cierre_bs = redondearMoneda(pmBs + efBs + pvBs);
  const total_ingreso_dolar = redondearMoneda(total_cierre_bs / tasa);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cierreRes = await client.query(
      `INSERT INTO cierres_caja (usuario_id, pago_movil_bs, efectivo_bs, punto_venta_bs, total_cierre_bs, tasa_dolar, dolares_vendidos, total_ingreso_dolar, impuestos_fiscales_bs, costos_operativos_bs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [usuario_id, pmBs, efBs, pvBs, total_cierre_bs, tasa, usdVendidos, total_ingreso_dolar, Number(impuestos_fiscales_bs), Number(costos_operativos_bs)]
    );

    const cierreId = cierreRes.rows[0].id;

    if (incidencia_caja && String(incidencia_caja).trim().length > 0) {
      await client.query(
        "INSERT INTO incidencias (tipo, cierre_caja_id, usuario_id, descripcion) VALUES ('financiera_caja', $1, $2, $3)",
        [cierreId, usuario_id, String(incidencia_caja).trim()]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, total_cierre_bs, total_ingreso_dolar, data: cierreRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    // Detectar error por índice único duplicado en PostgreSQL (23505)
    if (err.code === '23505') {
      return res.status(400).json({ error: 'El cierre de caja del día de hoy ya fue registrado previamente.' });
    }
    res.status(500).json({ error: 'Error al registrar cierre de caja.' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`Servidor Cloud Purissima corriendo en puerto ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
