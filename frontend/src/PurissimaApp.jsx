import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Constantes (alineadas con el esquema real de la base de datos)      */
/* ------------------------------------------------------------------ */
const API_BASE = import.meta.env.VITE_API_URL || '';
const TIMEOUT_MS = 12000;
const KEY_USER = 'purissima_usuario';
const KEY_TOKEN = 'purissima_token';

/* Listas exactas e inmodificables, indexadas por motos.tipo_modelo */
const CHECKLISTS = {
  sbr_150cc: ['Nivel de aceite', 'Calidad de aceite', 'Frenos delanteros', 'Frenos traseros', 'Bomba de freno delantera', 'Tensión de la cadena', 'Lubricación de la cadena', 'Caucho delantero', 'Caucho trasero', 'Luz delantera (alta y baja)', 'Luces de cruce', 'Bocina', 'Tablero de instrumentos', 'Soldadura de cajas', 'Tuercas y tornillos', 'Retrovisores', 'Acelerador', 'Documentación'],
  carguera_200cc: ['Nivel de aceite', 'Calidad de aceite', 'Frenos delanteros', 'Frenos traseros', 'Freno de estacionamiento', 'Bomba de freno delantero', 'Caucho delantero', 'Caucho trasero izquierdo', 'Caucho trasero derecho', 'Pernos y tuercas de ruedas traseras', 'Suspensión trasera (Resortes / Ballestas)', 'Luz delantera (alta y baja)', 'Luces de cruce y cocuyos traseros', 'Bocina (Corneta)', 'Tablero de instrumentos', 'Soldadura y estructura de la batea', 'Tuercas y tornillos generales', 'Espejos retrovisores', 'Acelerador y guayas'],
  otro: [],
};
const MODELOS = [['carguera_200cc', 'Bera Carguera 200cc'], ['sbr_150cc', 'Bera SBR 150cc'], ['otro', 'Otro']];

/*
 * Cómo factura un proveedor. Decide si al recibir su mercancía la foto de
 * la factura es obligatoria: el papel que entrega en la mano hay que
 * respaldarlo, el que manda al correo de la empresa ya está respaldado.
 */
const TIPOS_FACTURA = [
  ['fisica', 'Física (entrega el papel)'],
  ['digital', 'Digital (la envía al correo)'],
  ['ambas', 'Depende de la entrega'],
];

const MODULOS = {
  motos: { etiqueta: 'Motos', icono: '🏍️' },
  caja: { etiqueta: 'Caja', icono: '💵' },
  recepcion: { etiqueta: 'Recepción', icono: '📦' },
  solicitudes_negocio: { etiqueta: 'Solicitudes negocio', icono: '📝' },
  solicitudes_productos: { etiqueta: 'Solicitudes productos', icono: '🧃' },
  incidencias: { etiqueta: 'Incidencias', icono: '⚠️' },
};
/* Vistas que antes eran sólo del Master: ahora cada una tiene su permiso */
const VISTAS_MASTER = {
  reportes: { etiqueta: 'Reportes', icono: '📊', permiso: 'ver_reportes' },
  repmotos: { etiqueta: 'Reporte de motos', icono: '🛠️', permiso: 'ver_reporte_motos' },
  finanzas: { etiqueta: 'Finanzas', icono: '💰', permiso: 'ver_finanzas' },
  accesos: { etiqueta: 'Accesos', icono: '🔐', permiso: 'ver_accesos' },
};

/** ¿Tiene esta función especial? El servidor le manda todas al Master. */
const puede = (u, clave) =>
  Boolean(u) && Array.isArray(u.permisos_especiales) && u.permisos_especiales.includes(clave);

/*
 * Los cargos ahora viven en la base y el Master los crea. El backend
 * manda el nombre ya resuelto en "rol_nombre"; esta tabla sólo queda de
 * respaldo para los tres que existían antes de la migración 006.
 */
const ROL_ETIQUETA = { admin: 'Master', motorizados: 'Motorizado', tienda: 'Tienda' };
const nombreRol = (u) => (u && (u.rol_nombre || ROL_ETIQUETA[u.rol] || u.rol)) || '';
const ESTADO_USUARIO_ETIQUETA = { activo: 'Activo', pausado: 'Pausado', eliminado: 'Sin acceso' };
const TONO_ESTADO_USUARIO = { activo: 'verde', pausado: 'ambar', eliminado: 'rojo' };

/* Las solicitudes van en dos secciones separadas */
const TIPOS_SOLICITUD_PRODUCTOS = [['mercancia', 'Mercancía'], ['agua', 'Agua']];
const TIPOS_SOLICITUD_NEGOCIO = [
  ['insumos_generales', 'Insumos generales'], ['mantenimiento', 'Mantenimiento'],
  ['permiso', 'Permiso'], ['otro', 'Otro'],
];
const TIPOS_SOLICITUD = [...TIPOS_SOLICITUD_PRODUCTOS, ...TIPOS_SOLICITUD_NEGOCIO];

/* Los productos se piden por bulto */
const EMPAQUETADOS = [['caja', 'Caja'], ['gavera', 'Gavera'], ['brazo', 'Brazo']];
/* Subcategorías dentro de "mercancía", para describirla mejor */
const SUBCATEGORIAS = [
  ['bebidas', 'Bebidas'], ['snacks', 'Snacks'],
  ['artesanales', 'Artesanales'], ['insumos_agua', 'Insumos de agua'],
];
/* Un proveedor de agua no debe aparecer al registrar mercancía, ni al revés */
const filtrarProveedores = (lista, tipo) =>
  (lista || []).filter((p) => p.tipo === tipo || p.tipo === 'ambos');

/* La lista de productos se agrupa por subcategoría para que no sea una lista plana */
function agruparProductos(productos) {
  const texto = (p) => `${p.nombre} — ${etiquetaDe(EMPAQUETADOS, p.empaquetado)} de ${p.unidades_por_empaquetado}`;
  const grupos = SUBCATEGORIAS
    .map(([v, l]) => [l, (productos || []).filter((p) => p.subcategoria === v).map((p) => [String(p.id), texto(p)])])
    .filter(([, items]) => items.length > 0);
  const otros = (productos || []).filter((p) => !p.subcategoria).map((p) => [String(p.id), texto(p)]);
  if (otros.length) grupos.push(['Otros', otros]);
  return grupos;
}
const EMPAQUETADO_PLURAL = { caja: 'cajas', gavera: 'gaveras', brazo: 'brazos' };
const ESTADOS_SOLICITUD = ['pendiente', 'aprobada', 'en_proceso', 'completada', 'rechazada'];

const TIPOS_INCIDENCIA = [
  ['moto', 'Moto'], ['agua', 'Agua'], ['operativa_tienda', 'Operativa tienda'],
  ['financiera_caja', 'Financiera caja'], ['cliente', 'Cliente'], ['seguridad', 'Seguridad'], ['otro', 'Otro'],
];
const ESTADOS_INCIDENCIA = ['abierta', 'en_revision', 'cerrada'];

const TIPOS_PROVEEDOR = [['agua', 'Agua'], ['mercancia', 'Mercancía'], ['ambos', 'Ambos']];
const CATEGORIAS_PRODUCTO = [['mercancia', 'Mercancía'], ['insumo_tienda', 'Insumo de tienda'], ['agua', 'Agua']];

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function redondear(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return (Math.sign(v) * Math.round((Math.abs(v) + Number.EPSILON) * 100)) / 100;
}
/** La tasa del día se maneja con 4 decimales; el dinero con 2. */
const redondearTasa = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round((v + Number.EPSILON) * 10000) / 10000 : 0;
};
const nf = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 0 });
const nf4 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtBs = (n) => `Bs. ${nf.format(Number(n) || 0)}`;
const fmtUsd = (n) => `$ ${nf.format(Number(n) || 0)}`;
const fmtTasa = (n) => `Bs. ${nf4.format(Number(n) || 0)}`;
const fmtFecha = (s) => {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const fmtFechaHora = (iso) =>
  iso ? new Date(iso).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'short', timeStyle: 'short' }) : '';
const hoyCaracas = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sumarDias = (fechaISO, dias) => {
  const d = new Date(`${fechaISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

function leerSesion() {
  try {
    const usuario = JSON.parse(sessionStorage.getItem(KEY_USER) || 'null');
    const token = sessionStorage.getItem(KEY_TOKEN);
    return usuario && token ? { usuario, token } : null;
  } catch (_) {
    return null;
  }
}

async function apiFetch(ruta, { method = 'GET', body, token } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${ruta}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado. Revise su conexión móvil e intente de nuevo.');
    if (err instanceof TypeError) throw new Error('Sin conexión con el servidor.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

/* ------------------------------------------------------------------ */
/* Fotos                                                               */
/*                                                                     */
/* La foto se comprime EN EL TELÉFONO antes de subirla. Una foto de     */
/* cámara moderna pesa entre 3 y 8 MB; reducida a 1600 px de lado largo */
/* queda en unos 200 kB, que es más que suficiente para ver un daño en  */
/* la lata o leer una factura, y sube rápido con señal móvil.           */
/* ------------------------------------------------------------------ */
const FOTO_LADO_MAX = 1600;
const FOTO_PESO_OBJETIVO = 220 * 1024;
/* Se baja la calidad por pasos hasta que la foto entre en el objetivo */
const FOTO_CALIDADES = [0.82, 0.7, 0.6, 0.5, 0.4];

/**
 * Lee el archivo como imagen. Se pide la orientación "from-image" para
 * que una foto tomada de lado no salga acostada: el teléfono guarda ese
 * dato aparte, en los metadatos, y hay que pedirlo explícitamente.
 */
async function leerImagen(archivo) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(archivo, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(archivo);
      } catch {
        /* algunos navegadores viejos no lo soportan: se usa el respaldo */
      }
    }
  }
  const url = URL.createObjectURL(archivo);
  try {
    return await new Promise((listo, falla) => {
      const img = new Image();
      img.onload = () => listo(img);
      img.onerror = () => falla(new Error('No se pudo leer la foto'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function comprimirFoto(archivo) {
  if (!/^image\//.test(archivo.type || '')) throw new Error('Ese archivo no es una foto');
  const img = await leerImagen(archivo);
  const anchoOrig = img.width;
  const altoOrig = img.height;
  if (!anchoOrig || !altoOrig) throw new Error('No se pudo leer la foto');

  const escala = Math.min(1, FOTO_LADO_MAX / Math.max(anchoOrig, altoOrig));
  const ancho = Math.max(1, Math.round(anchoOrig * escala));
  const alto = Math.max(1, Math.round(altoOrig * escala));

  const lienzo = document.createElement('canvas');
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new Error('El teléfono no pudo procesar la foto');
  ctx.drawImage(img, 0, 0, ancho, alto);
  if (typeof img.close === 'function') img.close();

  let blob = null;
  for (const calidad of FOTO_CALIDADES) {
    // eslint-disable-next-line no-await-in-loop
    blob = await new Promise((listo) => lienzo.toBlob(listo, 'image/jpeg', calidad));
    if (!blob) throw new Error('El teléfono no pudo procesar la foto');
    if (blob.size <= FOTO_PESO_OBJETIVO) break;
  }
  return blob;
}

const pesoLegible = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} kB`);

/**
 * Botón de cámara. Al tocarlo abre la cámara trasera del teléfono,
 * comprime lo que salga y lo sube; se queda con la ruta que devuelve el
 * servidor, que es lo que después viaja con el formulario.
 */
function CapturaFoto({ etiqueta, ayuda, destino, valor, onCambio, subirFoto, aviso, requerido = false }) {
  const [ocupado, setOcupado] = useState('');
  const [vista, setVista] = useState('');
  const [peso, setPeso] = useState(0);
  const refInput = useRef(null);

  // Libera la miniatura al desmontar para no dejar memoria colgando
  useEffect(() => () => { if (vista) URL.revokeObjectURL(vista); }, [vista]);

  const elegir = async (e) => {
    const archivo = e.target.files && e.target.files[0];
    e.target.value = ''; // permite volver a elegir el mismo archivo
    if (!archivo) return;
    try {
      setOcupado('Preparando la foto…');
      const blob = await comprimirFoto(archivo);
      setOcupado('Subiendo…');
      const ruta = await subirFoto(destino, blob);
      setVista((previa) => {
        if (previa) URL.revokeObjectURL(previa);
        return URL.createObjectURL(blob);
      });
      setPeso(blob.size);
      onCambio(ruta);
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setOcupado('');
    }
  };

  const quitar = () => {
    setVista((previa) => { if (previa) URL.revokeObjectURL(previa); return ''; });
    setPeso(0);
    onCambio('');
  };

  return (
    <div className="rounded-xl border border-slate-200 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">
            {etiqueta}
            {requerido && !valor && <span className="text-red-600"> *</span>}
          </p>
          {ayuda && <p className="text-xs text-slate-500">{ayuda}</p>}
        </div>
        {valor ? <Chip tono="verde">Lista</Chip> : requerido && <Chip tono="ambar">Falta</Chip>}
      </div>

      {vista && (
        <img
          src={vista}
          alt={etiqueta}
          className="w-full max-h-56 object-contain rounded-lg bg-slate-50"
        />
      )}

      <input
        ref={refInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={elegir}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-sec flex-1"
          disabled={Boolean(ocupado)}
          onClick={() => refInput.current && refInput.current.click()}
        >
          {ocupado || (valor ? 'Tomar de nuevo' : '📷 Tomar foto')}
        </button>
        {valor && !ocupado && (
          <button type="button" className="btn-sec !px-3" onClick={quitar} aria-label="Quitar la foto">
            Quitar
          </button>
        )}
      </div>
      {peso > 0 && <p className="text-xs text-slate-400">Subida: {pesoLegible(peso)}</p>}
    </div>
  );
}

/** Miniatura de una foto ya guardada: pide el enlace firmado al abrirla. */
function FotoGuardada({ ruta, etiqueta, verFoto, aviso }) {
  const [url, setUrl] = useState('');
  const [cargando, setCargando] = useState(false);

  const abrir = async () => {
    if (url) return;
    setCargando(true);
    try {
      setUrl(await verFoto(ruta));
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setCargando(false);
    }
  };

  if (!ruta) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-500">{etiqueta}</p>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={etiqueta} className="w-full max-h-48 object-contain rounded-lg bg-slate-50" />
        </a>
      ) : (
        <button type="button" className="btn-sec w-full !py-2 !min-h-[40px] !text-sm" disabled={cargando} onClick={abrir}>
          {cargando ? 'Abriendo…' : 'Ver foto'}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componentes base                                                    */
/* ------------------------------------------------------------------ */
function NumInput({ value, onChange, ...rest }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step="any"
      min="0"
      className="campo"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onWheel={(e) => e.target.blur()}
      {...rest}
    />
  );
}

function Campo({ etiqueta, children }) {
  return (
    <label className="block">
      <span className="etiqueta">{etiqueta}</span>
      {children}
    </label>
  );
}

function Select({ valor, onChange, opciones, grupos, vacio, ...rest }) {
  return (
    <select className="campo" value={valor} onChange={(e) => onChange(e.target.value)} {...rest}>
      {vacio !== undefined && <option value="">{vacio}</option>}
      {grupos
        ? grupos.map(([etiqueta, items]) => (
          <optgroup key={etiqueta} label={etiqueta}>
            {items.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </optgroup>
        ))
        : (opciones || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

const Cargando = ({ texto = 'Cargando…' }) => <p className="text-center text-slate-500 py-8">{texto}</p>;
const Vacio = ({ texto }) => <p className="text-center text-slate-400 py-6">{texto}</p>;

function Chip({ children, tono = 'gris' }) {
  const tonos = {
    gris: 'bg-slate-100 text-slate-700',
    verde: 'bg-emerald-100 text-emerald-800',
    rojo: 'bg-red-100 text-red-800',
    ambar: 'bg-amber-100 text-amber-800',
    azul: 'bg-sky-100 text-sky-800',
  };
  return <span className={`chip ${tonos[tono]}`}>{children}</span>;
}

const tonoEstado = (e) => ({
  pendiente: 'ambar', abierta: 'rojo', aprobada: 'azul', en_proceso: 'azul', en_revision: 'azul',
  completada: 'verde', resuelta: 'verde', cerrada: 'verde', rechazada: 'gris',
}[e] || 'gris');
const tonoSeveridad = (s) => ({ alta: 'rojo', media: 'ambar', baja: 'verde' }[s] || 'gris');
const etiquetaEstado = (e) => String(e || '').replace(/_/g, ' ');
const etiquetaDe = (lista, v) => (lista.find(([k]) => k === v) || [v, etiquetaEstado(v)])[1];

function Titulo({ children, derecha }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-xl font-bold text-agua-900">{children}</h2>
      {derecha}
    </div>
  );
}

function Pestanas({ opciones, activa, onChange }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 mb-3" role="tablist">
      {opciones.map(([clave, etiqueta]) => (
        <button
          key={clave}
          role="tab"
          aria-selected={activa === clave}
          onClick={() => onChange(clave)}
          className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold min-h-[40px] ${
            activa === clave ? 'bg-agua-600 text-white' : 'bg-white text-slate-600 border border-slate-300'
          }`}
        >
          {etiqueta}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */
function Login({ onLogin }) {
  const [usuario, setUsuario] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setError('');
    setEnviando(true);
    try {
      const data = await apiFetch('/api/auth/login', { method: 'POST', body: { usuario, pin } });
      onLogin(data.usuario, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <form onSubmit={enviar} className="card w-full max-w-sm space-y-4 border-agua-100 shadow-md">
        <div className="text-center">
          <img
            src="/logo-purissima.png"
            alt="Purissima - pura + natural"
            className="mx-auto w-full max-w-[260px] h-auto"
            width={800}
            height={404}
          />
          <p className="mt-2 text-sm font-semibold tracking-wide text-agua-700">GESTIÓN INTERNA</p>
        </div>
        <Campo etiqueta="Usuario">
          <input
            className="campo"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value.replace(/\s/g, ''))}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </Campo>
        <Campo etiqueta="PIN (4 a 8 dígitos)">
          <input
            className="campo tracking-widest"
            type="password"
            inputMode="numeric"
            pattern="\d{4,8}"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            autoComplete="current-password"
            required
          />
        </Campo>
        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg p-2" role="alert">{error}</p>}
        <button className="btn-primario w-full" disabled={enviando || !usuario || pin.length < 4}>
          {enviando ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Motos                                                               */
/* ------------------------------------------------------------------ */
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const nombreDia = (fechaISO) => DIAS_SEMANA[new Date(`${fechaISO}T00:00:00Z`).getUTCDay()] || '';

const horaCorta = (iso) => (iso
  ? new Date(iso).toLocaleTimeString('es-VE', {
    timeZone: 'America/Caracas', hour: 'numeric', minute: '2-digit', hour12: true,
  })
  : '');

/*
 * La barra de la tienda, arriba de todo y en cualquier módulo.
 *
 * El aviso de apertura no puede vivir dentro de Caja: Caja se abre al
 * final del día, cuando toca cerrar, así que el botón quedaría tocándose
 * a las siete de la noche y la hora de apertura saldría siempre mal.
 *
 * Tres situaciones:
 *   cerrada en día laborable -> alarma grande, porque hay algo que hacer
 *   abierta sin confirmar    -> tarjeta con la hora y el botón de enterado
 *   todo en orden            -> una línea tranquila que no estorba
 */
function BarraTienda({ call, aviso }) {
  const [info, setInfo] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setInfo(await call('/api/tienda/estado'));
    } catch {
      setInfo(null); // si falla, la barra simplemente no aparece
    }
  }, [call]);
  useEffect(() => { cargar(); }, [cargar]);

  const accion = async (ruta, mensaje) => {
    setOcupado(true);
    try {
      await call(ruta, { method: 'POST' });
      aviso(mensaje, 'ok');
      await cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setOcupado(false);
    }
  };

  if (!info || !info.dia) return null;
  const d = info.dia;
  const abierta = d.estado === 'abierta';
  const debeConfirmar = info.ve_confirmacion && abierta && !d.confirmada_por_mi;
  // Sólo es una alarma si hay algo que hacer: día laborable sin apertura
  const esAlarma = d.estado === 'sin_registrar' && d.laborable && (info.puede_abrir || info.ve_confirmacion);

  if (abierta && !debeConfirmar) {
    return (
      <p className="mb-3 text-xs text-slate-500">
        Tienda abierta a las {horaCorta(d.hora_apertura)}
        {d.abrio ? ` · ${d.abrio}` : ''}
        {d.corregida ? ' · hora corregida' : ''}
      </p>
    );
  }

  if (!esAlarma && !debeConfirmar) {
    // Domingo, o día marcado como cerrado a propósito: nada que hacer
    const detalle = d.motivo_cierre || (!d.laborable ? nombreDia(d.fecha) : '');
    return (
      <p className="mb-3 text-xs text-slate-500">
        Tienda cerrada{detalle ? ` · ${detalle}` : ''}
      </p>
    );
  }

  return (
    <div className={`mb-3 rounded-xl p-3 ${abierta ? 'bg-emerald-50' : 'bg-amber-100'}`}>
      <p className={`font-bold ${abierta ? 'text-emerald-900' : 'text-amber-900'}`}>
        {abierta ? `Tienda abierta a las ${horaCorta(d.hora_apertura)}` : 'Tienda cerrada'}
      </p>
      {!abierta && (
        <p className="text-xs text-amber-900 mt-0.5">
          Hoy es {nombreDia(d.fecha)} y la tienda todavía no se marcó como abierta.
          Sin eso no se puede cerrar la caja del día.
        </p>
      )}
      {abierta && d.abrio && <p className="text-xs text-emerald-900 mt-0.5">La abrió {d.abrio}</p>}
      <div className="mt-2 flex gap-2">
        {!abierta && info.puede_abrir && (
          <button
            type="button"
            className="btn-primario flex-1"
            disabled={ocupado}
            onClick={() => accion('/api/tienda/abrir', 'Tienda abierta')}
          >
            {ocupado ? 'Abriendo…' : 'Abrir la tienda'}
          </button>
        )}
        {debeConfirmar && (
          <button
            type="button"
            className="btn-sec flex-1"
            disabled={ocupado}
            onClick={() => accion('/api/tienda/confirmar', 'Confirmado')}
          >
            {ocupado ? '…' : 'Enterado'}
          </button>
        )}
      </div>
    </div>
  );
}

/*
 * El aviso del próximo cambio de aceite, debajo del estado del checklist.
 *
 * Dice las dos cosas que el motorizado necesita: a qué número del tablero
 * toca y cuántos kilómetros le quedan. El color avisa con tiempo:
 * amarillo desde la anticipación configurada, para que haya margen de
 * comprar el aceite sin parar la moto, y rojo sólo cuando ya se pasó.
 */
function AvisoAceite({ aviso }) {
  if (!aviso) return null;
  const estilos = {
    gris: 'bg-slate-50 text-slate-600',
    amarillo: 'bg-amber-100 text-amber-900',
    rojo: 'bg-red-100 text-red-900',
  };
  return (
    <p className={`mt-1 rounded-lg px-2 py-1 text-xs ${estilos[aviso.color] || estilos.gris}`}>
      {aviso.vencido ? (
        <>
          <b>Cambio de aceite vencido</b>
          {' · '}
          {nf0.format(Math.abs(aviso.faltan))} km de más
        </>
      ) : (
        <>
          Siguiente aceite a los <b>{nf0.format(aviso.toca_en)} km</b>
          {' · faltan '}
          {nf0.format(aviso.faltan)}
        </>
      )}
    </p>
  );
}

function FormChecklist({ moto, call, aviso, subirFoto, onListo, onCancelar }) {
  const lista = CHECKLISTS[moto.tipo_modelo] || [];
  const [seUso, setSeUso] = useState(true);
  const [km, setKm] = useState(String(moto.ultimo_kilometraje));
  const [items, setItems] = useState(() => Object.fromEntries(lista.map((i) => [i, true])));
  const [cambioAceite, setCambioAceite] = useState(false);
  const [kmAceite, setKmAceite] = useState('');
  const [tieneFalla, setTieneFalla] = useState(false);
  const [obs, setObs] = useState('');
  const [enviando, setEnviando] = useState(false);
  /* Las tres del día, más la de la falla cuando hay una */
  const [fotos, setFotos] = useState({ tablero: '', frontal: '', trasera: '', falla: '' });
  const [fotosExigidas, setFotosExigidas] = useState(false);

  // Si el almacén de fotos no está configurado todavía, no se exigen:
  // más vale un checklist sin foto que un motorizado que no puede registrar.
  useEffect(() => {
    let vivo = true;
    call('/api/motos/config')
      .then((d) => { if (vivo) setFotosExigidas(Boolean(d.fotos_habilitadas)); })
      .catch(() => { /* si falla, se quedan opcionales */ });
    return () => { vivo = false; };
  }, [call]);

  const hayItemMalo = Object.values(items).some((v) => !v);
  const falla = tieneFalla || (seUso && hayItemMalo);
  const ponerFoto = (clave) => (ruta) => setFotos((p) => ({ ...p, [clave]: ruta }));
  const faltanFotos = fotosExigidas
    && ['tablero', 'frontal', 'trasera'].filter((k) => !fotos[k]);

  const enviar = async (e) => {
    e.preventDefault();
    if (falla && !obs.trim()) return aviso('Describa la falla en la observación', 'error');
    if (cambioAceite) {
      if (kmAceite === '') return aviso('Falta el kilometraje del cambio de aceite', 'error');
      const piso = seUso && km !== '' ? Number(km) : Number(moto.ultimo_kilometraje);
      if (Number(kmAceite) < piso) {
        return aviso(seUso
          ? 'El kilometraje del cambio de aceite no puede ser menor al del arranque del día'
          : 'El kilometraje del cambio de aceite no puede ser menor al último registrado de la moto', 'error');
      }
    }
    if (faltanFotos && faltanFotos.length) {
      return aviso(`Faltan ${faltanFotos.length} foto(s) por tomar`, 'error');
    }
    setEnviando(true);
    try {
      await call(`/api/motos/${moto.id}/checklist`, {
        method: 'POST',
        body: {
          se_uso_hoy: seUso,
          kilometraje_inicial: seUso || km !== '' ? Number(km) : undefined,
          items: seUso ? items : {},
          cambio_aceite_realizado: cambioAceite,
          km_cambio_aceite: cambioAceite ? Number(kmAceite) : undefined,
          tiene_falla: falla,
          observacion_falla: falla ? obs.trim() : undefined,
          foto_tablero: fotos.tablero || undefined,
          foto_frontal: fotos.frontal || undefined,
          foto_trasera: fotos.trasera || undefined,
          foto_falla_url: falla && fotos.falla ? fotos.falla : undefined,
        },
      });
      aviso('Checklist guardado', 'ok');
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form onSubmit={enviar} className="card space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-bold text-lg">{moto.nombre}</h3>
          <p className="text-sm text-slate-500">{moto.placa} · {etiquetaDe(MODELOS, moto.tipo_modelo)}</p>
        </div>
        <button type="button" className="text-slate-500 text-2xl px-2" onClick={onCancelar} aria-label="Cerrar">×</button>
      </div>

      <div>
        <p className="etiqueta">¿Se usó la moto hoy?</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSeUso(true)}
            className={`rounded-xl px-3 py-3 font-semibold min-h-[52px] ${
              seUso ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            Se usó hoy
          </button>
          <button
            type="button"
            onClick={() => setSeUso(false)}
            className={`rounded-xl px-3 py-3 font-semibold min-h-[52px] ${
              !seUso ? 'bg-agua-700 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            No se usó
          </button>
        </div>
      </div>

      {seUso ? (
        <Campo etiqueta="Kilometraje inicial (obligatorio)">
          <NumInput value={km} onChange={setKm} step="1" required />
        </Campo>
      ) : (
        <p className="text-sm text-slate-500">
          Como la moto no se usó, no hace falta el kilometraje ni la revisión de los puntos.
        </p>
      )}

      {seUso && lista.length > 0 && (
        <div className="space-y-2">
          <p className="etiqueta">Revisión ({lista.length} puntos)</p>
          {lista.map((nombre) => (
            <div key={nombre} className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
              <span className="text-sm">{nombre}</span>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => setItems((p) => ({ ...p, [nombre]: true }))}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold min-h-[40px] ${items[nombre] ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                >
                  OK
                </button>
                <button
                  type="button"
                  onClick={() => setItems((p) => ({ ...p, [nombre]: false }))}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold min-h-[40px] ${!items[nombre] ? 'bg-red-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                >
                  Falla
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <label className="flex items-center gap-3 min-h-[44px]">
          <input type="checkbox" className="h-6 w-6" checked={cambioAceite} onChange={(e) => setCambioAceite(e.target.checked)} />
          <span className="font-medium">Se hizo cambio de aceite hoy</span>
        </label>
        {cambioAceite && (
          <div className="mt-1 rounded-xl bg-amber-50 p-3 space-y-2">
            <Campo etiqueta="Kilometraje al momento del cambio (obligatorio)">
              <NumInput value={kmAceite} onChange={setKmAceite} step="1" required />
            </Campo>
            <p className="text-xs text-slate-600">
              El del tablero cuando le cambiaron el aceite, que puede ser mayor al del
              arranque del día. Desde este número se cuenta hasta el próximo cambio.
            </p>
          </div>
        )}
      </div>

      <label className="flex items-center gap-3 min-h-[44px]">
        <input type="checkbox" className="h-6 w-6" checked={falla} disabled={seUso && hayItemMalo} onChange={(e) => setTieneFalla(e.target.checked)} />
        <span className="font-medium">Reportar falla</span>
      </label>
      {falla && (
        <Campo etiqueta="Observación de la falla (obligatoria)">
          <textarea className="campo" rows={3} maxLength={1000} value={obs} onChange={(e) => setObs(e.target.value)} required />
        </Campo>
      )}

      <div className="space-y-2">
        <div>
          <p className="etiqueta">
            Fotos del día{fotosExigidas ? ' (obligatorias)' : ' (opcionales por ahora)'}
          </p>
          <p className="text-xs text-slate-500">
            Se reducen en el teléfono antes de subir, así que pesan poco y suben rápido.
          </p>
        </div>
        <CapturaFoto
          etiqueta="Tablero"
          ayuda="Que se lea el kilometraje"
          destino="tablero"
          valor={fotos.tablero}
          onCambio={ponerFoto('tablero')}
          subirFoto={subirFoto}
          aviso={aviso}
          requerido={fotosExigidas}
        />
        <CapturaFoto
          etiqueta="Frontal"
          ayuda="La moto de frente, completa"
          destino="frontal"
          valor={fotos.frontal}
          onCambio={ponerFoto('frontal')}
          subirFoto={subirFoto}
          aviso={aviso}
          requerido={fotosExigidas}
        />
        <CapturaFoto
          etiqueta="Trasera en contrapicado"
          ayuda="Desde abajo hacia arriba, por detrás"
          destino="trasera"
          valor={fotos.trasera}
          onCambio={ponerFoto('trasera')}
          subirFoto={subirFoto}
          aviso={aviso}
          requerido={fotosExigidas}
        />
        {falla && (
          <CapturaFoto
            etiqueta="Foto de la falla (opcional)"
            ayuda="Si se puede fotografiar, ayuda a resolverla más rápido"
            destino="falla"
            valor={fotos.falla}
            onCambio={ponerFoto('falla')}
            subirFoto={subirFoto}
            aviso={aviso}
          />
        )}
      </div>

      <button className="btn-primario w-full" disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar checklist'}</button>
    </form>
  );
}

function FormMoto({ call, aviso, onListo }) {
  const [f, setF] = useState({ nombre: '', color: '', placa: '', tipo_modelo: 'carguera_200cc', km: '0', aceite: '0' });
  const [enviando, setEnviando] = useState(false);
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/motos', {
        method: 'POST',
        body: {
          nombre: f.nombre, color: f.color, placa: f.placa, tipo_modelo: f.tipo_modelo,
          ultimo_kilometraje: Number(f.km), ultimo_cambio_aceite_km: Number(f.aceite),
        },
      });
      aviso('Moto registrada', 'ok');
      setF({ nombre: '', color: '', placa: '', tipo_modelo: 'carguera_200cc', km: '0', aceite: '0' });
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form onSubmit={enviar} className="card space-y-3">
      <h3 className="font-bold">Registrar moto</h3>
      <Campo etiqueta="Nombre identificador">
        <input className="campo" value={f.nombre} onChange={(e) => set('nombre')(e.target.value)} minLength={2} required placeholder="Moto 3 - Bera SBR" />
      </Campo>
      <div className="grid grid-cols-2 gap-3">
        <Campo etiqueta="Color"><input className="campo" value={f.color} onChange={(e) => set('color')(e.target.value)} minLength={2} required /></Campo>
        <Campo etiqueta="Placa"><input className="campo uppercase" value={f.placa} onChange={(e) => set('placa')(e.target.value.toUpperCase())} minLength={3} required /></Campo>
      </div>
      <Campo etiqueta="Modelo"><Select valor={f.tipo_modelo} onChange={set('tipo_modelo')} opciones={MODELOS} /></Campo>
      <div className="grid grid-cols-2 gap-3">
        <Campo etiqueta="Kilometraje"><NumInput value={f.km} onChange={set('km')} step="1" required /></Campo>
        <Campo etiqueta="Km último aceite"><NumInput value={f.aceite} onChange={set('aceite')} step="1" required /></Campo>
      </div>
      <button className="btn-primario w-full" disabled={enviando}>{enviando ? 'Guardando…' : 'Registrar'}</button>
    </form>
  );
}

function VistaMotos({ usuario, call, aviso, subirFoto }) {
  const [motos, setMotos] = useState(null);
  const [seleccion, setSeleccion] = useState(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const esAdmin = puede(usuario, 'gestionar_motos');

  const cargar = useCallback(async () => {
    try {
      setMotos((await call('/api/motos')).motos);
    } catch (err) {
      aviso(err.message, 'error');
      setMotos([]);
    }
  }, [call, aviso]);

  useEffect(() => { cargar(); }, [cargar]);

  if (seleccion) {
    return (
      <FormChecklist
        moto={seleccion}
        call={call}
        aviso={aviso}
        subirFoto={subirFoto}
        onCancelar={() => setSeleccion(null)}
        onListo={() => { setSeleccion(null); cargar(); }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Titulo derecha={esAdmin && <button className="btn-sec !py-2 !min-h-[40px]" onClick={() => setMostrarForm((v) => !v)}>{mostrarForm ? 'Cerrar' : '+ Moto'}</button>}>
        Motos
      </Titulo>
      {esAdmin && mostrarForm && <FormMoto call={call} aviso={aviso} onListo={() => { setMostrarForm(false); cargar(); }} />}
      {motos === null ? <Cargando /> : motos.length === 0 ? <Vacio texto="No hay motos registradas" /> : (
        motos.map((m) => (
          <div key={m.id} className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold">{m.nombre}</p>
              <p className="text-sm text-slate-500 truncate">{m.placa} · {m.color} · {nf0.format(m.ultimo_kilometraje)} km</p>
              <div className="flex gap-1 mt-1 flex-wrap">
                {m.checklist_hoy ? <Chip tono="verde">Checklist hoy ✓</Chip> : <Chip tono="ambar">Pendiente hoy</Chip>}
              </div>
              <AvisoAceite aviso={m.aviso_aceite} />
            </div>
            <button className="btn-primario shrink-0" disabled={m.checklist_hoy} onClick={() => setSeleccion(m)}>Revisar</button>
          </div>
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Caja                                                                */
/* ------------------------------------------------------------------ */
function VistaCaja({ usuario, call, aviso }) {
  const esAdmin = puede(usuario, 'anular_registros');
  const [hoy, setHoy] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [f, setF] = useState({
    pago_movil_bs: '', efectivo_bs: '', punto_venta_bs: '', tasa_dolar: '',
    impuestos_fiscales_bs: '', costos_operativos_usd: '', observacion: '',
  });
  const [enviando, setEnviando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [h, l] = await Promise.all([call('/api/caja/hoy'), call(`/api/caja${qs({ desde: sumarDias(hoyCaracas(), -14) })}`)]);
      setHoy(h);
      setHistorial(l.cierres);
    } catch (err) {
      aviso(err.message, 'error');
      setHoy({ cierre: null, fecha: hoyCaracas() });
    }
  }, [call, aviso]);

  useEffect(() => { cargar(); }, [cargar]);

  const totalBs = useMemo(
    () => redondear(redondear(f.pago_movil_bs) + redondear(f.efectivo_bs) + redondear(f.punto_venta_bs)),
    [f.pago_movil_bs, f.efectivo_bs, f.punto_venta_bs],
  );
  const tasa = redondearTasa(f.tasa_dolar);
  const totalUsd = useMemo(
    () => (tasa > 0 ? redondear(totalBs / tasa) : 0),
    [totalBs, tasa],
  );
  // Los costos se escriben en dólares; su equivalente en bolívares es lo que resta al neto
  const costosBs = useMemo(
    () => (tasa > 0 ? redondear(redondear(f.costos_operativos_usd) * tasa) : 0),
    [tasa, f.costos_operativos_usd],
  );
  const netoBs = useMemo(
    () => redondear(totalBs - redondear(f.impuestos_fiscales_bs) - costosBs),
    [totalBs, f.impuestos_fiscales_bs, costosBs],
  );
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  const enviar = async (e) => {
    e.preventDefault();
    if (!(tasa > 0)) return aviso('Indique la tasa del dólar del día', 'error');
    if (!window.confirm(`¿Cerrar la caja de hoy?\n\nTotal: ${fmtBs(totalBs)}\nIngreso en dólares: ${fmtUsd(totalUsd)}\n\nNo podrá repetirse.`)) return;
    setEnviando(true);
    try {
      await call('/api/caja/cierre', {
        method: 'POST',
        body: {
          pago_movil_bs: redondear(f.pago_movil_bs),
          efectivo_bs: redondear(f.efectivo_bs),
          punto_venta_bs: redondear(f.punto_venta_bs),
          total_cierre_bs: totalBs,
          tasa_dolar: tasa,
          total_ingreso_dolar: totalUsd,
          impuestos_fiscales_bs: redondear(f.impuestos_fiscales_bs),
          costos_operativos_usd: redondear(f.costos_operativos_usd),
          observacion: f.observacion,
        },
      });
      aviso('Caja cerrada correctamente', 'ok');
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (!hoy) return <Cargando />;
  const c = hoy.cierre;

  return (
    <div className="space-y-4">
      <Titulo>Cierre de caja</Titulo>
      {c ? (
        <div className="card space-y-1">
          <Chip tono="verde">Caja de hoy ya cerrada</Chip>
          <p>Pago móvil: <b>{fmtBs(c.pago_movil_bs)}</b></p>
          <p>Efectivo: <b>{fmtBs(c.efectivo_bs)}</b></p>
          <p>Punto de venta: <b>{fmtBs(c.punto_venta_bs)}</b></p>
          <p className="text-lg">Total: <b>{fmtBs(c.total_cierre_bs)}</b></p>
          <hr className="my-1" />
          <p>Tasa del día: <b>{fmtTasa(c.tasa_dolar)}</b></p>
          <p>Ingreso total: <b>{fmtUsd(c.total_ingreso_dolar)}</b></p>
          <p>Impuestos: <b>{fmtBs(c.impuestos_fiscales_bs)}</b></p>
          <p>Costos operativos: <b>{fmtUsd(c.costos_operativos_usd)}</b> <span className="text-slate-500">({fmtBs(c.costos_operativos_bs)})</span></p>
          <p>Neto en Bs: <b>{fmtBs(redondear(c.total_cierre_bs - c.impuestos_fiscales_bs - c.costos_operativos_bs))}</b></p>
          {c.observacion && <p className="text-sm text-slate-600">Nota: {c.observacion}</p>}
          <p className="text-sm text-slate-500">Registrado por {c.usuario}</p>
        </div>
      ) : (
        <form onSubmit={enviar} className="card space-y-3">
          <p className="text-sm text-slate-500">Fecha: {fmtFecha(hoy.fecha)}</p>
          <Campo etiqueta="Pago móvil (Bs)"><NumInput value={f.pago_movil_bs} onChange={set('pago_movil_bs')} placeholder="0.00" /></Campo>
          <Campo etiqueta="Efectivo (Bs)"><NumInput value={f.efectivo_bs} onChange={set('efectivo_bs')} placeholder="0.00" /></Campo>
          <Campo etiqueta="Punto de venta (Bs)"><NumInput value={f.punto_venta_bs} onChange={set('punto_venta_bs')} placeholder="0.00" /></Campo>
          <div className="rounded-xl bg-agua-50 border border-agua-200 p-3">
            <p className="text-sm text-slate-600">Total Bs (calculado)</p>
            <p className="text-2xl font-extrabold text-agua-800">{fmtBs(totalBs)}</p>
          </div>
          <Campo etiqueta="Tasa del dólar del día (obligatoria)">
            <NumInput value={f.tasa_dolar} onChange={set('tasa_dolar')} placeholder="0.0000" required />
          </Campo>
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3">
            <p className="text-sm text-slate-600">Ingreso total en dólares (calculado)</p>
            <p className="text-xl font-extrabold text-emerald-800">{fmtUsd(totalUsd)}</p>
            <p className="text-xs text-slate-500">Total Bs ÷ tasa del día</p>
          </div>
          <Campo etiqueta="Impuestos fiscales (Bs)">
            <NumInput value={f.impuestos_fiscales_bs} onChange={set('impuestos_fiscales_bs')} placeholder="0.00" />
          </Campo>
          <Campo etiqueta="Costos operativos (USD)">
            <NumInput value={f.costos_operativos_usd} onChange={set('costos_operativos_usd')} placeholder="0.00" />
          </Campo>
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <p className="text-sm text-slate-600">Equivalen a</p>
            <p className="text-lg font-bold text-slate-800">{fmtBs(costosBs)}</p>
            <p className="text-xs text-slate-500">Costos en $ × tasa del día</p>
          </div>
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <p className="text-sm text-slate-600">Neto en Bs (total − impuestos − costos)</p>
            <p className={`text-xl font-extrabold ${netoBs < 0 ? 'text-red-700' : 'text-slate-800'}`}>{fmtBs(netoBs)}</p>
          </div>
          <Campo etiqueta="Observación (opcional)">
            <textarea className="campo" rows={2} maxLength={500} value={f.observacion} onChange={(e) => set('observacion')(e.target.value)} />
          </Campo>
          <button className="btn-primario w-full" disabled={enviando}>{enviando ? 'Cerrando…' : 'Cerrar caja del día'}</button>
        </form>
      )}

      <div>
        <h3 className="font-bold mb-2">Últimos 15 días</h3>
        {historial.length === 0 ? <Vacio texto="Sin cierres recientes" /> : (
          <div className="space-y-2">
            {historial.map((h) => (
              <div key={h.id} className="card !p-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="font-semibold">{fmtFecha(h.fecha)}</span>
                  <span>{fmtBs(h.total_cierre_bs)} · {fmtUsd(h.total_ingreso_dolar)}</span>
                </div>
                {esAdmin && (
                  <div className="mt-2 flex justify-end">
                    <BotonAnular
                      recurso="caja"
                      id={h.id}
                      anulado={h.anulado}
                      call={call}
                      aviso={aviso}
                      onListo={cargar}
                      etiqueta={`el cierre del ${fmtFecha(h.fecha)}`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recepción                                                           */
/* ------------------------------------------------------------------ */
function VistaRecepcion({ usuario, call, aviso, subirFoto, verFoto }) {
  const [tab, setTab] = useState('agua');
  const [datos, setDatos] = useState(null);

  const cargar = useCallback(async () => {
    try {
      const desde = sumarDias(hoyCaracas(), -30);
      const [pv, pr, ea, em] = await Promise.all([
        call('/api/proveedores'),
        call('/api/productos'),
        call(`/api/entradas/agua${qs({ desde })}`),
        call(`/api/entradas/mercancia${qs({ desde })}`),
      ]);
      setDatos({ proveedores: pv.proveedores, productos: pr.productos, agua: ea.entradas, mercancia: em.entradas });
    } catch (err) {
      aviso(err.message, 'error');
      setDatos({ proveedores: [], productos: [], agua: [], mercancia: [] });
    }
  }, [call, aviso]);

  useEffect(() => { cargar(); }, [cargar]);

  const puedeCatalogo = puede(usuario, 'editar_catalogo');
  const puedeAnular = puede(usuario, 'anular_registros');
  const puedeEliminar = puede(usuario, 'eliminar_catalogo');

  // "Proveedores y productos" lo abre la función "Editar catálogo"
  const pestanas = [['agua', 'Agua'], ['mercancia', 'Mercancía']];
  if (puedeCatalogo) pestanas.push(['catalogo', 'Proveedores y productos']);
  const activa = tab === 'catalogo' && !puedeCatalogo ? 'agua' : tab;

  if (!datos) return <Cargando />;
  const props = {
    call, aviso, datos, onListo: cargar, puedeCatalogo, puedeAnular, puedeEliminar,
    subirFoto, verFoto,
  };

  return (
    <div>
      <Titulo>Recepción</Titulo>
      <Pestanas opciones={pestanas} activa={activa} onChange={setTab} />
      {activa === 'agua' && <EntradaAgua {...props} />}
      {activa === 'mercancia' && <EntradaMercancia {...props} />}
      {activa === 'catalogo' && puedeCatalogo && <Catalogo {...props} />}
    </div>
  );
}

/** Botón simple para quien no es Master: agregar un proveedor que falte en la lista. */
function AgregarProveedorRapido({ call, aviso, onListo, tipoPorDefecto = 'ambos' }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({ nombre: '', tipo: tipoPorDefecto, telefono: '' });
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/proveedores', { method: 'POST', body: f });
      aviso('Proveedor agregado', 'ok');
      setF({ nombre: '', tipo: tipoPorDefecto, telefono: '' });
      setAbierto(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (!abierto) {
    return (
      <button type="button" className="btn-sec w-full !py-2 !min-h-[40px] !text-sm" onClick={() => setAbierto(true)}>
        + Agregar proveedor que no está en la lista
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-agua-200 bg-agua-50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-sm">Nuevo proveedor</p>
        <button type="button" className="text-slate-500 text-xl px-2" onClick={() => setAbierto(false)} aria-label="Cerrar">×</button>
      </div>
      <Campo etiqueta="Nombre">
        <input className="campo" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} minLength={2} />
      </Campo>
      <div className="grid grid-cols-2 gap-2">
        <Campo etiqueta="Tipo">
          <Select valor={f.tipo} onChange={(v) => setF({ ...f, tipo: v })} opciones={TIPOS_PROVEEDOR} />
        </Campo>
        <Campo etiqueta="Teléfono">
          <input className="campo" type="tel" value={f.telefono} onChange={(e) => setF({ ...f, telefono: e.target.value })} />
        </Campo>
      </div>
      <button type="button" className="btn-primario w-full !py-2 !min-h-[40px]" disabled={enviando || f.nombre.trim().length < 2} onClick={enviar}>
        {enviando ? 'Guardando…' : 'Guardar proveedor'}
      </button>
    </div>
  );
}

function SinProveedores() {
  return (
    <div className="card text-center text-slate-500">
      Primero registre al menos un proveedor en la pestaña “Proveedores y productos”.
    </div>
  );
}

function EntradaAgua({ call, aviso, datos, onListo, puedeCatalogo, puedeAnular }) {
  const [litraje, setLitraje] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [obs, setObs] = useState('');
  const [incidencia, setIncidencia] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/entradas/agua', {
        method: 'POST',
        body: { litraje: Number(litraje), proveedor_id: Number(proveedor), observaciones: obs, tiene_incidencia: incidencia },
      });
      aviso('Entrada de agua registrada', 'ok');
      setLitraje(''); setObs(''); setIncidencia(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (datos.proveedores.length === 0 && puedeCatalogo) return <SinProveedores />;

  return (
    <div className="space-y-4">
      <form onSubmit={enviar} className="card space-y-3">
        <Campo etiqueta="Litros recibidos"><NumInput value={litraje} onChange={setLitraje} required placeholder="0" /></Campo>
        <Campo etiqueta="Proveedor de agua (obligatorio)">
          <Select
            valor={proveedor}
            onChange={setProveedor}
            opciones={filtrarProveedores(datos.proveedores, 'agua').map((p) => [String(p.id), p.nombre])}
            vacio="Seleccione…"
            required
          />
        </Campo>
        {!puedeCatalogo && <AgregarProveedorRapido call={call} aviso={aviso} onListo={onListo} tipoPorDefecto="agua" />}
        <Campo etiqueta="Observaciones (opcional)">
          <textarea className="campo" rows={2} maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Campo>
        <label className="flex items-center gap-3 min-h-[44px]">
          <input type="checkbox" className="h-6 w-6" checked={incidencia} onChange={(e) => setIncidencia(e.target.checked)} />
          <span className="font-medium">Hubo una incidencia con esta entrega</span>
        </label>
        <button className="btn-primario w-full" disabled={enviando || !litraje || !proveedor}>
          {enviando ? 'Guardando…' : 'Registrar entrada'}
        </button>
      </form>
      <h3 className="font-bold">Últimos 30 días</h3>
      {datos.agua.length === 0 ? <Vacio texto="Sin entradas de agua" /> : datos.agua.map((e) => (
        <div key={e.id} className="card !p-3 text-sm">
          <div className="flex justify-between items-center">
            <span className="truncate">{fmtFecha(e.fecha)} · {e.proveedor}{e.tiene_incidencia ? ' ⚠️' : ''}</span>
            <b className="shrink-0">{nf.format(e.litraje)} L</b>
          </div>
          {puedeAnular && (
            <div className="mt-2 flex justify-end">
              <BotonAnular recurso="entrada-agua" id={e.id} anulado={e.anulado} call={call} aviso={aviso} onListo={onListo} etiqueta="esta entrada de agua" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/*
 * Recibir una solicitud que se pidió antes.
 *
 * Carga los productos de la solicitud con la cantidad que se pidió, y de
 * cada uno se marca qué pasó: llegó completo, llegó con otra cantidad, o
 * no llegó. Lo que no llegó entra con cantidad cero: queda constancia de
 * que se pidió y no vino, y no suma al stock.
 *
 * La solicitud se cierra en una sola entrega, como pasa en el negocio.
 */
const ESTADOS_ITEM = [
  ['completo', 'Llegó completo'],
  ['otra', 'Llegó otra cantidad'],
  ['no_llego', 'No llegó'],
];

function RecibirSolicitud({ call, aviso, onListo, subirFoto, proveedores }) {
  const [solicitudes, setSolicitudes] = useState(null);
  const [selId, setSelId] = useState('');
  const [lineas, setLineas] = useState([]);
  const [factura, setFactura] = useState('');
  const [facturaDigital, setFacturaDigital] = useState(false);
  const [obs, setObs] = useState('');
  const [enviando, setEnviando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setSolicitudes((await call('/api/solicitudes/pendientes-mercancia')).solicitudes);
    } catch (err) {
      aviso(err.message, 'error');
      setSolicitudes([]);
    }
  }, [call, aviso]);
  useEffect(() => { cargar(); }, [cargar]);

  const sel = (solicitudes || []).find((x) => x.id === selId);

  const elegir = (id) => {
    setSelId(id);
    setFactura('');
    setFacturaDigital(false);
    const sol = (solicitudes || []).find((x) => x.id === id);
    const items = sol && Array.isArray(sol.detalle_items) ? sol.detalle_items : [];
    setLineas(items.map((it) => ({
      producto_id: Number(it.producto_id),
      nombre: it.nombre,
      empaquetado: it.empaquetado,
      pedida: Number(it.cantidad_empaques) || 0,
      estado: 'completo',
      cantidad: String(Number(it.cantidad_empaques) || 0),
    })));
  };

  const setLinea = (i, cambios) => setLineas((p) => p.map((l, idx) => (idx === i ? { ...l, ...cambios } : l)));

  const marcar = (i, estado) => {
    const l = lineas[i];
    if (estado === 'completo') setLinea(i, { estado, cantidad: String(l.pedida) });
    else if (estado === 'no_llego') setLinea(i, { estado, cantidad: '0' });
    else setLinea(i, { estado, cantidad: '' });
  };

  /* Cómo factura este proveedor decide si la foto es obligatoria */
  const prov = sel && proveedores.find((p) => p.id === sel.proveedor_id);
  const tipoFactura = (prov && prov.tipo_factura) || (sel && sel.tipo_factura) || 'fisica';
  const permiteDigital = tipoFactura === 'ambas';
  const exigeFoto = tipoFactura === 'fisica' || (permiteDigital && !facturaDigital);

  const enviar = async (e) => {
    e.preventDefault();
    if (!sel) return aviso('Elija una solicitud', 'error');
    for (const l of lineas) {
      if (l.estado === 'otra' && (l.cantidad === '' || Number(l.cantidad) <= 0)) {
        return aviso(`Indique cuánto llegó de ${l.nombre}`, 'error');
      }
    }
    if (!lineas.some((l) => Number(l.cantidad) > 0)) {
      return aviso('No llegó ningún producto. Si de verdad no llegó nada, rechace la solicitud desde Reportes.', 'error');
    }
    setEnviando(true);
    try {
      await call('/api/entradas/mercancia', {
        method: 'POST',
        body: {
          proveedor_id: sel.proveedor_id,
          solicitud_id: sel.id,
          items: lineas.map((l) => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad) })),
          foto_factura_url: factura || undefined,
          factura_digital: permiteDigital ? facturaDigital : undefined,
          observaciones: obs || undefined,
        },
      });
      aviso('Recepción registrada y solicitud cerrada', 'ok');
      setSelId(''); setLineas([]); setObs(''); setFactura(''); setFacturaDigital(false);
      await cargar();
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (solicitudes === null) return <Cargando />;
  if (solicitudes.length === 0) {
    return (
      <div className="card">
        <p className="text-center text-slate-500 text-sm">
          No hay solicitudes de mercancía pendientes. Si llegó algo que nadie pidió
          formalmente, cárgalo abajo a mano.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={enviar} className="card space-y-3">
      <div>
        <h3 className="font-bold">Recibir un pedido que se solicitó</h3>
        <p className="text-xs text-slate-500">
          Marca producto por producto qué llegó de verdad. Lo que no llegó queda
          registrado y no suma al stock.
        </p>
      </div>

      <Campo etiqueta="Solicitud pendiente">
        <Select
          valor={selId}
          onChange={elegir}
          opciones={solicitudes.map((x) => [
            x.id,
            `${fmtFecha(x.fecha)} · ${x.proveedor || 'sin proveedor'} · ${x.titulo}`,
          ])}
          vacio="Seleccione…"
        />
      </Campo>

      {sel && (
        <>
          <p className="text-xs text-slate-500">
            La pidió {sel.pidio}
            {sel.proveedor ? ` · Proveedor: ${sel.proveedor}` : ''}
          </p>

          {lineas.length === 0 ? (
            <Vacio texto="Esa solicitud no tiene productos detallados" />
          ) : lineas.map((l, i) => (
            <div key={l.producto_id} className="rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="flex justify-between items-start gap-2">
                <span className="font-medium min-w-0">{l.nombre}</span>
                <Chip>{`se pidieron ${nf0.format(l.pedida)}`}</Chip>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {ESTADOS_ITEM.map(([clave, etiqueta]) => (
                  <button
                    key={clave}
                    type="button"
                    onClick={() => marcar(i, clave)}
                    className={`rounded-lg px-2 py-2 text-xs font-semibold min-h-[44px] ${
                      l.estado === clave
                        ? (clave === 'no_llego' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white')
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {etiqueta}
                  </button>
                ))}
              </div>
              {l.estado === 'otra' && (
                <Campo etiqueta={`¿Cuántos llegaron? (se pidieron ${nf0.format(l.pedida)})`}>
                  <NumInput value={l.cantidad} onChange={(v) => setLinea(i, { cantidad: v })} required />
                </Campo>
              )}
            </div>
          ))}

          {exigeFoto ? (
            <CapturaFoto
              etiqueta="Foto de la factura"
              ayuda={tipoFactura === 'fisica'
                ? `${sel.proveedor || 'Este proveedor'} entrega factura física: la foto es obligatoria`
                : 'Que se lean los montos y la fecha'}
              destino="factura"
              valor={factura}
              onCambio={setFactura}
              subirFoto={subirFoto}
              aviso={aviso}
              requerido
            />
          ) : (
            <p className="text-xs text-slate-500 rounded-lg bg-slate-50 p-2">
              {tipoFactura === 'digital'
                ? `${sel.proveedor || 'Este proveedor'} envía la factura al correo de la empresa, así que no hace falta la foto.`
                : 'Marcaste factura digital, así que no hace falta la foto.'}
            </p>
          )}

          {permiteDigital && (
            <label className="flex items-center gap-3 min-h-[44px] text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={facturaDigital}
                onChange={(e) => setFacturaDigital(e.target.checked)}
              />
              <span>Factura digital (la enviaron al correo de la empresa)</span>
            </label>
          )}

          <Campo etiqueta="Observaciones (opcional)">
            <textarea className="campo" rows={2} maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} />
          </Campo>

          <button className="btn-primario w-full" disabled={enviando}>
            {enviando ? 'Guardando…' : 'Registrar recepción'}
          </button>
        </>
      )}
    </form>
  );
}

function EntradaMercancia({
  call, aviso, datos, onListo, puedeCatalogo, puedeAnular, subirFoto, verFoto,
}) {
  const [proveedor, setProveedor] = useState('');
  const [obs, setObs] = useState('');
  const [filas, setFilas] = useState([{ producto_id: '', cantidad: '' }]);
  const [factura, setFactura] = useState('');
  const [facturaDigital, setFacturaDigital] = useState(false);
  const [enviando, setEnviando] = useState(false);

  /*
   * La foto de la factura se exige según cómo facture el proveedor
   * elegido, no según lo que decida quien recibe. Si el proveedor entrega
   * papel, la foto es el respaldo de que llegó; si factura al correo, no
   * hay papel que fotografiar.
   */
  const provSel = datos.proveedores.find((p) => String(p.id) === String(proveedor));
  const tipoFactura = (provSel && provSel.tipo_factura) || 'fisica';
  const permiteDigital = tipoFactura === 'ambas';
  const exigeFoto = Boolean(provSel) && (tipoFactura === 'fisica' || (permiteDigital && !facturaDigital));

  const setFila = (i, k, v) => setFilas((p) => p.map((f, idx) => (idx === i ? { ...f, [k]: v } : f)));

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/entradas/mercancia', {
        method: 'POST',
        body: {
          proveedor_id: Number(proveedor),
          observaciones: obs,
          items: filas.map((f) => ({
            producto_id: Number(f.producto_id), cantidad: Number(f.cantidad),
          })),
          foto_factura_url: factura || undefined,
          factura_digital: permiteDigital ? facturaDigital : undefined,
        },
      });
      aviso('Mercancía recibida y stock actualizado', 'ok');
      setFilas([{ producto_id: '', cantidad: '' }]);
      setObs('');
      setFactura('');
      setFacturaDigital(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (datos.proveedores.length === 0 && puedeCatalogo) return <SinProveedores />;
  if (datos.productos.length === 0) {
    return (
      <div className="card space-y-3">
        <p className="text-center text-slate-500">
          {puedeCatalogo
            ? 'Primero registre productos en la pestaña “Proveedores y productos”.'
            : 'Todavía no hay productos cargados. Puedes agregar el primero aquí mismo.'}
        </p>
        {!puedeCatalogo && <AgregarProductoRapido call={call} aviso={aviso} onListo={onListo} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <RecibirSolicitud
        call={call}
        aviso={aviso}
        onListo={onListo}
        subirFoto={subirFoto}
        proveedores={datos.proveedores}
      />

      <form onSubmit={enviar} className="card space-y-3">
        <h3 className="font-bold">O cargar a mano lo que llegó</h3>
        <Campo etiqueta="Proveedor de mercancía (obligatorio)">
          <Select
            valor={proveedor}
            onChange={setProveedor}
            opciones={filtrarProveedores(datos.proveedores, 'mercancia').map((p) => [String(p.id), p.nombre])}
            vacio="Seleccione…"
            required
          />
        </Campo>
        {!puedeCatalogo && <AgregarProveedorRapido call={call} aviso={aviso} onListo={onListo} tipoPorDefecto="mercancia" />}
        {filas.map((f, i) => (
          <div key={i} className="rounded-xl border border-slate-200 p-3 space-y-2">
            <Campo etiqueta={`Producto ${i + 1}`}>
              <Select
                valor={f.producto_id}
                onChange={(v) => setFila(i, 'producto_id', v)}
                opciones={datos.productos.map((p) => [String(p.id), `${p.nombre} (stock ${nf.format(p.stock)})`])}
                vacio="Seleccione…"
                required
              />
            </Campo>
            <Campo etiqueta="Cantidad recibida">
              <NumInput value={f.cantidad} onChange={(v) => setFila(i, 'cantidad', v)} required />
            </Campo>
            {filas.length > 1 && (
              <button type="button" className="text-sm text-red-600 font-semibold" onClick={() => setFilas((p) => p.filter((_, idx) => idx !== i))}>
                Quitar ítem
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn-sec w-full" onClick={() => setFilas((p) => [...p, { producto_id: '', cantidad: '' }])}>
          + Agregar ítem
        </button>
        {!puedeCatalogo && <AgregarProductoRapido call={call} aviso={aviso} onListo={onListo} />}
        {exigeFoto && (
          <CapturaFoto
            etiqueta="Foto de la factura"
            ayuda={tipoFactura === 'fisica'
              ? `${provSel.nombre} entrega factura física: la foto es obligatoria`
              : 'Que se lean los montos y la fecha'}
            destino="factura"
            valor={factura}
            onCambio={setFactura}
            subirFoto={subirFoto}
            aviso={aviso}
            requerido
          />
        )}
        {provSel && !exigeFoto && (
          <p className="text-xs text-slate-500 rounded-lg bg-slate-50 p-2">
            {tipoFactura === 'digital'
              ? `${provSel.nombre} envía la factura al correo de la empresa, así que no hace falta la foto.`
              : 'Marcaste factura digital, así que no hace falta la foto.'}
          </p>
        )}
        {permiteDigital && (
          <label className="flex items-center gap-3 min-h-[44px] text-sm">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={facturaDigital}
              onChange={(e) => setFacturaDigital(e.target.checked)}
            />
            <span>Factura digital (la enviaron al correo de la empresa)</span>
          </label>
        )}
        <Campo etiqueta="Observaciones (opcional)">
          <textarea className="campo" rows={2} maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Campo>
        <button className="btn-primario w-full" disabled={enviando || !proveedor}>{enviando ? 'Guardando…' : 'Registrar recepción'}</button>
      </form>
      <h3 className="font-bold">Últimos 30 días</h3>
      {datos.mercancia.length === 0 ? <Vacio texto="Sin entradas de mercancía" /> : datos.mercancia.map((e) => (
        <div key={e.id} className="card !p-3 text-sm">
          <p className="font-semibold">{fmtFecha(e.fecha)} · {e.proveedor}</p>
          <ul className="list-disc pl-5 text-slate-600">
            {(Array.isArray(e.items_recibidos) ? e.items_recibidos : []).map((it, i) => (
              <li key={i}>{it.nombre || `Producto #${it.producto_id}`}: {nf.format(it.cantidad)}</li>
            ))}
          </ul>
          {e.foto_factura_url && (
            <div className="mt-2">
              <FotoGuardada ruta={e.foto_factura_url} etiqueta="Factura" verFoto={verFoto} aviso={aviso} />
            </div>
          )}
          {puedeAnular && (
            <div className="mt-2 flex justify-end">
              <BotonAnular recurso="entrada-mercancia" id={e.id} anulado={e.anulado} call={call} aviso={aviso} onListo={onListo} etiqueta="esta entrada de mercancía" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Catalogo({ call, aviso, datos, onListo, puedeEliminar }) {
  const [prov, setProv] = useState({
    nombre: '', tipo: 'ambos', contacto: '', rif: '', telefono: '', tipo_factura: 'fisica',
  });
  const [prod, setProd] = useState({
    nombre: '', categoria: 'mercancia', subcategoria: 'bebidas',
    empaquetado: 'caja', unidades_por_empaquetado: '1',
    stock: '', proveedor_habitual_id: '',
  });
  const [guardando, setGuardando] = useState(false);

  const guardar = async (ruta, body, reset) => {
    setGuardando(true);
    try {
      await call(ruta, { method: 'POST', body });
      aviso('Guardado', 'ok');
      reset();
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="card space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          guardar('/api/proveedores', prov, () => setProv({
            nombre: '', tipo: 'ambos', contacto: '', rif: '', telefono: '', tipo_factura: 'fisica',
          }));
        }}
      >
        <h3 className="font-bold">Nuevo proveedor</h3>
        <Campo etiqueta="Nombre"><input className="campo" value={prov.nombre} onChange={(e) => setProv({ ...prov, nombre: e.target.value })} required minLength={2} /></Campo>
        <Campo etiqueta="Tipo"><Select valor={prov.tipo} onChange={(v) => setProv({ ...prov, tipo: v })} opciones={TIPOS_PROVEEDOR} /></Campo>
      <Campo etiqueta="Cómo factura">
        <Select valor={prov.tipo_factura} onChange={(v) => setProv({ ...prov, tipo_factura: v })} opciones={TIPOS_FACTURA} />
      </Campo>
      <p className="text-xs text-slate-500 -mt-1">
        Si entrega factura física, al recibir su mercancía la foto será obligatoria.
        Si la envía al correo de la empresa, no se pedirá.
      </p>
        <Campo etiqueta="Contacto"><input className="campo" value={prov.contacto} onChange={(e) => setProv({ ...prov, contacto: e.target.value })} /></Campo>
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="RIF"><input className="campo" value={prov.rif} onChange={(e) => setProv({ ...prov, rif: e.target.value })} /></Campo>
          <Campo etiqueta="Teléfono"><input className="campo" type="tel" value={prov.telefono} onChange={(e) => setProv({ ...prov, telefono: e.target.value })} /></Campo>
        </div>
        <button className="btn-primario w-full" disabled={guardando}>Guardar proveedor</button>
      </form>

      <form
        className="card space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          guardar('/api/productos', {
            nombre: prod.nombre,
            categoria: prod.categoria,
            subcategoria: prod.subcategoria,
            empaquetado: prod.empaquetado,
            unidades_por_empaquetado: Number(prod.unidades_por_empaquetado || 1),
            stock: Number(prod.stock || 0),
            proveedor_habitual_id: prod.proveedor_habitual_id ? Number(prod.proveedor_habitual_id) : undefined,
          }, () => setProd({
            nombre: '', categoria: 'mercancia', subcategoria: 'bebidas',
            empaquetado: 'caja', unidades_por_empaquetado: '1',
            stock: '', proveedor_habitual_id: '',
          }));
        }}
      >
        <h3 className="font-bold">Nuevo producto</h3>
        <Campo etiqueta="Nombre"><input className="campo" value={prod.nombre} onChange={(e) => setProd({ ...prod, nombre: e.target.value })} required minLength={2} /></Campo>
        <Campo etiqueta="Categoría"><Select valor={prod.categoria} onChange={(v) => setProd({ ...prod, categoria: v })} opciones={CATEGORIAS_PRODUCTO} /></Campo>
        {prod.categoria === 'mercancia' && (
          <Campo etiqueta="Tipo de mercancía">
            <Select valor={prod.subcategoria} onChange={(v) => setProd({ ...prod, subcategoria: v })} opciones={SUBCATEGORIAS} />
          </Campo>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Viene en">
            <Select valor={prod.empaquetado} onChange={(v) => setProd({ ...prod, empaquetado: v })} opciones={EMPAQUETADOS} />
          </Campo>
          <Campo etiqueta="Unidades por empaque">
            <NumInput value={prod.unidades_por_empaquetado} onChange={(v) => setProd({ ...prod, unidades_por_empaquetado: v })} step="1" />
          </Campo>
          <Campo etiqueta="Stock inicial"><NumInput value={prod.stock} onChange={(v) => setProd({ ...prod, stock: v })} /></Campo>
        </div>
        <Campo etiqueta="Proveedor habitual">
          <Select
            valor={prod.proveedor_habitual_id}
            onChange={(v) => setProd({ ...prod, proveedor_habitual_id: v })}
            opciones={datos.proveedores.map((p) => [String(p.id), p.nombre])}
            vacio="—"
          />
        </Campo>
        <button className="btn-primario w-full" disabled={guardando}>Guardar producto</button>
      </form>

      <div>
        <h3 className="font-bold mb-2">Proveedores ({datos.proveedores.length})</h3>
        <p className="text-xs text-slate-500 mb-2">Toca un proveedor para modificar sus datos.</p>
        {datos.proveedores.length === 0 ? <Vacio texto="Sin proveedores" /> : datos.proveedores.map((p) => (
          <ProveedorEditable key={p.id} proveedor={p} call={call} aviso={aviso} onListo={onListo} puedeEliminar={puedeEliminar} />
        ))}

        <h3 className="font-bold mb-2 mt-4">Productos ({datos.productos.length})</h3>
        <p className="text-xs text-slate-500 mb-2">Toca un producto para modificarlo.</p>
        {datos.productos.length === 0 ? <Vacio texto="Sin productos" /> : datos.productos.map((p) => (
          <ProductoEditable key={p.id} producto={p} datos={datos} call={call} aviso={aviso} onListo={onListo} puedeEliminar={puedeEliminar} />
        ))}
      </div>
    </div>
  );
}

/** Producto de la lista; al tocarlo se abre para modificar todos sus datos. */
function ProductoEditable({ producto, datos, call, aviso, onListo, puedeEliminar }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({
    nombre: producto.nombre,
    categoria: producto.categoria,
    subcategoria: producto.subcategoria || 'bebidas',
    empaquetado: producto.empaquetado,
    unidades_por_empaquetado: String(producto.unidades_por_empaquetado),
    stock: String(producto.stock),
    proveedor_habitual_id: producto.proveedor_habitual_id ? String(producto.proveedor_habitual_id) : '',
    activo: producto.activo,
  });
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    setGuardando(true);
    try {
      await call(`/api/productos/${producto.id}`, {
        method: 'PUT',
        body: {
          ...f,
          unidades_por_empaquetado: Number(f.unidades_por_empaquetado || 1),
          stock: Number(f.stock || 0),
          proveedor_habitual_id: f.proveedor_habitual_id ? Number(f.proveedor_habitual_id) : undefined,
        },
      });
      aviso('Producto actualizado', 'ok');
      setAbierto(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="card !p-3 mb-2 w-full flex justify-between items-center text-sm text-left"
      >
        <span className="truncate">
          {producto.nombre}
          <span className="text-slate-400"> · {etiquetaDe(EMPAQUETADOS, producto.empaquetado)} de {producto.unidades_por_empaquetado}</span>
        </span>
        <b className="shrink-0">{nf.format(producto.stock)}</b>
      </button>
    );
  }

  return (
    <div className="card mb-2 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Modificar producto</h4>
        <button type="button" className="text-slate-500 text-2xl px-2" onClick={() => setAbierto(false)} aria-label="Cerrar">×</button>
      </div>
      <Campo etiqueta="Nombre">
        <input className="campo" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} minLength={2} />
      </Campo>
      <Campo etiqueta="Categoría">
        <Select valor={f.categoria} onChange={(v) => setF({ ...f, categoria: v })} opciones={CATEGORIAS_PRODUCTO} />
      </Campo>
      {f.categoria === 'mercancia' && (
        <Campo etiqueta="Tipo de mercancía">
          <Select valor={f.subcategoria} onChange={(v) => setF({ ...f, subcategoria: v })} opciones={SUBCATEGORIAS} />
        </Campo>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Campo etiqueta="Viene en">
          <Select valor={f.empaquetado} onChange={(v) => setF({ ...f, empaquetado: v })} opciones={EMPAQUETADOS} />
        </Campo>
        <Campo etiqueta="Unidades por empaque">
          <NumInput value={f.unidades_por_empaquetado} onChange={(v) => setF({ ...f, unidades_por_empaquetado: v })} step="1" />
        </Campo>
        <Campo etiqueta="Stock">
          <NumInput value={f.stock} onChange={(v) => setF({ ...f, stock: v })} />
        </Campo>
      </div>
      <Campo etiqueta="Proveedor habitual">
        <Select
          valor={f.proveedor_habitual_id}
          onChange={(v) => setF({ ...f, proveedor_habitual_id: v })}
          opciones={datos.proveedores.map((p) => [String(p.id), p.nombre])}
          vacio="—"
        />
      </Campo>
      {puedeEliminar && (
        <label className="flex items-center gap-3 min-h-[44px]">
          <input type="checkbox" className="h-6 w-6" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />
          <span className="font-medium">Producto activo</span>
        </label>
      )}
      <button type="button" className="btn-primario w-full" disabled={guardando} onClick={guardar}>
        {guardando ? 'Guardando…' : 'Guardar cambios'}
      </button>
    </div>
  );
}

/** Proveedor de la lista; al tocarlo se abre para modificar todos sus datos. */
function ProveedorEditable({ proveedor, call, aviso, onListo, puedeEliminar }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({
    nombre: proveedor.nombre,
    tipo: proveedor.tipo,
    contacto: proveedor.contacto || '',
    rif: proveedor.rif || '',
    telefono: proveedor.telefono || '',
    tipo_factura: proveedor.tipo_factura || 'fisica',
    activo: proveedor.activo,
  });
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    setGuardando(true);
    try {
      await call(`/api/proveedores/${proveedor.id}`, { method: 'PUT', body: f });
      aviso('Proveedor actualizado', 'ok');
      setAbierto(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="card !p-3 mb-2 w-full flex justify-between items-center text-sm text-left"
      >
        <span className="truncate">
          {proveedor.nombre}
          {proveedor.telefono ? <span className="text-slate-400"> · {proveedor.telefono}</span> : null}
        </span>
        <span className="flex gap-1 shrink-0">
          <Chip tono="azul">{etiquetaDe(TIPOS_PROVEEDOR, proveedor.tipo)}</Chip>
          {proveedor.tipo_factura === 'digital' && <Chip>factura digital</Chip>}
          {proveedor.tipo_factura === 'ambas' && <Chip>factura variable</Chip>}
        </span>
      </button>
    );
  }

  return (
    <div className="card mb-2 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Modificar proveedor</h4>
        <button type="button" className="text-slate-500 text-2xl px-2" onClick={() => setAbierto(false)} aria-label="Cerrar">×</button>
      </div>
      <Campo etiqueta="Nombre">
        <input className="campo" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} minLength={2} />
      </Campo>
      <Campo etiqueta="Tipo">
        <Select valor={f.tipo} onChange={(v) => setF({ ...f, tipo: v })} opciones={TIPOS_PROVEEDOR} />
      </Campo>
      <Campo etiqueta="Cómo factura">
        <Select valor={f.tipo_factura} onChange={(v) => setF({ ...f, tipo_factura: v })} opciones={TIPOS_FACTURA} />
      </Campo>
      <p className="text-xs text-slate-500 -mt-1">
        Si entrega factura física, al recibir su mercancía la foto será obligatoria.
        Si la envía al correo de la empresa, no se pedirá.
      </p>
      <Campo etiqueta="Contacto">
        <input className="campo" value={f.contacto} onChange={(e) => setF({ ...f, contacto: e.target.value })} />
      </Campo>
      <div className="grid grid-cols-2 gap-2">
        <Campo etiqueta="RIF">
          <input className="campo" value={f.rif} onChange={(e) => setF({ ...f, rif: e.target.value })} />
        </Campo>
        <Campo etiqueta="Teléfono">
          <input className="campo" type="tel" value={f.telefono} onChange={(e) => setF({ ...f, telefono: e.target.value })} />
        </Campo>
      </div>
      {puedeEliminar && (
        <label className="flex items-center gap-3 min-h-[44px]">
          <input type="checkbox" className="h-6 w-6" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />
          <span className="font-medium">Proveedor activo</span>
        </label>
      )}
      <button type="button" className="btn-primario w-full" disabled={guardando} onClick={guardar}>
        {guardando ? 'Guardando…' : 'Guardar cambios'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Solicitudes e Incidencias                                           */
/* ------------------------------------------------------------------ */
function SelectorEstado({ valor, estados, onCambiar }) {
  return (
    <select
      className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
      value={valor}
      onChange={(e) => onCambiar(e.target.value)}
    >
      {estados.map((e) => <option key={e} value={e}>{etiquetaEstado(e)}</option>)}
    </select>
  );
}

/** Botón de anular/reactivar, exclusivo del Master. */
function BotonAnular({ recurso, id, anulado, call, aviso, onListo, etiqueta = 'este registro' }) {
  const [enviando, setEnviando] = useState(false);

  const ejecutar = async () => {
    let motivo = '';
    if (anulado) {
      if (!window.confirm(`¿Reactivar ${etiqueta}? Volverá a contar en los totales.`)) return;
    } else {
      motivo = window.prompt(`¿Por qué se anula ${etiqueta}?\n\nQuedará registrado junto con tu nombre y la fecha.`) || '';
      if (!motivo.trim()) return;
    }
    setEnviando(true);
    try {
      await call(`/api/anular/${recurso}/${id}`, {
        method: 'PUT',
        body: { anulado: !anulado, motivo_anulacion: motivo.trim() },
      });
      aviso(anulado ? 'Registro reactivado' : 'Registro anulado', 'ok');
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <button
      type="button"
      disabled={enviando}
      onClick={ejecutar}
      className={`rounded-lg px-3 py-2 text-sm font-semibold min-h-[40px] ${
        anulado ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
      }`}
    >
      {enviando ? '…' : anulado ? 'Reactivar' : 'Anular'}
    </button>
  );
}

/** Marca visible cuando un registro fue anulado. */
function SelloAnulado({ registro }) {
  if (!registro.anulado) return null;
  return (
    <p className="text-sm text-red-800 bg-red-50 rounded-lg p-2">
      <b>Anulado</b>
      {registro.anulado_por_nombre ? ` por ${registro.anulado_por_nombre}` : ''}
      {registro.anulado_en ? ` · ${fmtFechaHora(registro.anulado_en)}` : ''}
      {registro.motivo_anulacion ? ` — ${registro.motivo_anulacion}` : ''}
    </p>
  );
}

/** Alta rápida de un producto que todavía no está en el catálogo. */
function AgregarProductoRapido({ call, aviso, onListo }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({
    nombre: '', categoria: 'mercancia', subcategoria: 'bebidas',
    empaquetado: 'caja', unidades_por_empaquetado: '1',
  });
  const [enviando, setEnviando] = useState(false);

  const enviar = async () => {
    setEnviando(true);
    try {
      await call('/api/productos', {
        method: 'POST',
        body: { ...f, unidades_por_empaquetado: Number(f.unidades_por_empaquetado || 1) },
      });
      aviso('Producto agregado al catálogo', 'ok');
      setF({
        nombre: '', categoria: 'mercancia', subcategoria: 'bebidas',
        empaquetado: 'caja', unidades_por_empaquetado: '1',
      });
      setAbierto(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (!abierto) {
    return (
      <button type="button" className="btn-sec w-full !py-2 !min-h-[40px] !text-sm" onClick={() => setAbierto(true)}>
        + Agregar un producto que no está en la lista
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-agua-200 bg-agua-50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-sm">Producto nuevo</p>
        <button type="button" className="text-slate-500 text-xl px-2" onClick={() => setAbierto(false)} aria-label="Cerrar">×</button>
      </div>
      <Campo etiqueta="Nombre">
        <input className="campo" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} minLength={2} />
      </Campo>
      <Campo etiqueta="Categoría">
        <Select valor={f.categoria} onChange={(v) => setF({ ...f, categoria: v })} opciones={CATEGORIAS_PRODUCTO} />
      </Campo>
      {f.categoria === 'mercancia' && (
        <Campo etiqueta="Tipo de mercancía">
          <Select valor={f.subcategoria} onChange={(v) => setF({ ...f, subcategoria: v })} opciones={SUBCATEGORIAS} />
        </Campo>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Campo etiqueta="Viene en">
          <Select valor={f.empaquetado} onChange={(v) => setF({ ...f, empaquetado: v })} opciones={EMPAQUETADOS} />
        </Campo>
        <Campo etiqueta="Unidades por empaque">
          <NumInput value={f.unidades_por_empaquetado} onChange={(v) => setF({ ...f, unidades_por_empaquetado: v })} step="1" />
        </Campo>
      </div>
      <button
        type="button"
        className="btn-primario w-full !py-2 !min-h-[40px]"
        disabled={enviando || f.nombre.trim().length < 2}
        onClick={enviar}
      >
        {enviando ? 'Guardando…' : 'Guardar producto'}
      </button>
    </div>
  );
}

/** Tarjeta común para mostrar una solicitud ya enviada. */
function TarjetaSolicitud({ s, tipos, puedeResolver, puedeAnular, call, aviso, onListo }) {
  const detalle = Array.isArray(s.detalle_items) ? s.detalle_items : [];
  return (
    <div className={`card space-y-1 ${s.anulado ? 'opacity-75' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">{s.titulo}</p>
        <Chip tono={s.anulado ? 'gris' : tonoEstado(s.estado)}>
          {s.anulado ? 'anulada' : etiquetaEstado(s.estado)}
        </Chip>
      </div>
      <p className="text-sm text-slate-500">
        {etiquetaDe(tipos, s.tipo_solicitud)}
        {s.proveedor ? ` · ${s.proveedor}` : ''} · {s.usuario} · {fmtFechaHora(s.fecha_hora)}
      </p>
      {s.tipo_solicitud === 'agua' && detalle[0] && detalle[0].litraje !== undefined && (
        <p className="text-sm font-semibold">{nf.format(detalle[0].litraje)} litros</p>
      )}
      {s.tipo_solicitud === 'mercancia' && detalle.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-slate-600">
          {detalle.map((d, i) => (
            <li key={i}>
              {d.nombre}: <b>{d.cantidad_empaques}</b> {EMPAQUETADO_PLURAL[d.empaquetado] || d.empaquetado}
              {d.unidades_totales ? ` (${nf0.format(d.unidades_totales)} unidades)` : ''}
            </li>
          ))}
        </ul>
      )}
      {s.descripcion && <p className="text-sm">{s.descripcion}</p>}
      {s.notas_admin && <p className="text-sm text-agua-800 bg-agua-50 rounded-lg p-2">Master: {s.notas_admin}</p>}
      <SelloAnulado registro={s} />
      {(puedeResolver || puedeAnular) && (
        <div className="flex items-center gap-2 pt-1">
          {puedeResolver && !s.anulado && (
            <SelectorEstado
              valor={s.estado}
              estados={ESTADOS_SOLICITUD}
              onCambiar={async (estado) => {
                try {
                  await call(`/api/solicitudes/${s.id}`, { method: 'PUT', body: { estado, notas_admin: s.notas_admin || '' } });
                  aviso('Estado actualizado', 'ok');
                  onListo();
                } catch (err) {
                  aviso(err.message, 'error');
                }
              }}
            />
          )}
          {puedeAnular && (
            <BotonAnular
              recurso="solicitud"
              id={s.id}
              anulado={s.anulado}
              call={call}
              aviso={aviso}
              onListo={onListo}
              etiqueta="esta solicitud"
            />
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------- Solicitudes del negocio --------------------- */
function VistaSolicitudesNegocio({ usuario, call, aviso }) {
  const [lista, setLista] = useState(null);
  const [verAnuladas, setVerAnuladas] = useState(false);
  const [f, setF] = useState({ tipo_solicitud: 'insumos_generales', titulo: '', descripcion: '' });
  const [enviando, setEnviando] = useState(false);
  const puedeResolver = puede(usuario, 'resolver_solicitudes');
  const puedeAnular = puede(usuario, 'anular_registros');
  const verOpcionAnuladas = puede(usuario, 'ver_anulados');

  const cargar = useCallback(async () => {
    try {
      const d = await call(`/api/solicitudes${qs({ categoria: 'negocio', anuladas: verAnuladas ? 'true' : '' })}`);
      setLista(d.solicitudes);
    } catch (err) {
      aviso(err.message, 'error');
      setLista([]);
    }
  }, [call, aviso, verAnuladas]);
  useEffect(() => { cargar(); }, [cargar]);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/solicitudes', { method: 'POST', body: f });
      aviso('Solicitud enviada', 'ok');
      setF({ tipo_solicitud: 'insumos_generales', titulo: '', descripcion: '' });
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="space-y-4">
      <Titulo>Solicitudes del negocio</Titulo>
      <form onSubmit={enviar} className="card space-y-3">
        <Campo etiqueta="Tipo">
          <Select valor={f.tipo_solicitud} onChange={(v) => setF({ ...f, tipo_solicitud: v })} opciones={TIPOS_SOLICITUD_NEGOCIO} />
        </Campo>
        <Campo etiqueta="Título">
          <input className="campo" value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} minLength={3} maxLength={120} required />
        </Campo>
        <Campo etiqueta="Descripción">
          <textarea className="campo" rows={3} maxLength={2000} value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} />
        </Campo>
        <button className="btn-primario w-full" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar solicitud'}</button>
      </form>

      {verOpcionAnuladas && (
        <label className="card !p-3 flex items-center gap-3 min-h-[44px] text-sm">
          <input type="checkbox" className="h-5 w-5" checked={verAnuladas} onChange={(e) => setVerAnuladas(e.target.checked)} />
          <span>Mostrar también las anuladas</span>
        </label>
      )}

      {lista === null ? <Cargando /> : lista.length === 0 ? <Vacio texto="No hay solicitudes" /> : lista.map((s) => (
        <TarjetaSolicitud
          key={s.id}
          s={s}
          tipos={TIPOS_SOLICITUD_NEGOCIO}
          puedeResolver={puedeResolver}
          puedeAnular={puedeAnular}
          call={call}
          aviso={aviso}
          onListo={cargar}
        />
      ))}
    </div>
  );
}

/* ------------------- Solicitudes de productos ---------------------- */
function VistaSolicitudesProductos({ usuario, call, aviso }) {
  const [tab, setTab] = useState('mercancia');
  const [datos, setDatos] = useState(null);
  const [lista, setLista] = useState(null);
  const [verAnuladas, setVerAnuladas] = useState(false);
  const puedeResolver = puede(usuario, 'resolver_solicitudes');
  const puedeAnular = puede(usuario, 'anular_registros');
  const verOpcionAnuladas = puede(usuario, 'ver_anulados');

  const cargar = useCallback(async () => {
    try {
      const [pr, pv, so] = await Promise.all([
        call('/api/productos'),
        call('/api/proveedores'),
        call(`/api/solicitudes${qs({ categoria: 'productos', anuladas: verAnuladas ? 'true' : '' })}`),
      ]);
      setDatos({ productos: pr.productos, proveedores: pv.proveedores });
      setLista(so.solicitudes);
    } catch (err) {
      aviso(err.message, 'error');
      setDatos({ productos: [], proveedores: [] });
      setLista([]);
    }
  }, [call, aviso, verAnuladas]);
  useEffect(() => { cargar(); }, [cargar]);

  if (!datos) return <Cargando />;

  return (
    <div className="space-y-4">
      <Titulo>Solicitudes de productos</Titulo>
      <Pestanas
        opciones={[['mercancia', 'Mercancía'], ['agua', 'Agua']]}
        activa={tab}
        onChange={setTab}
      />
      {tab === 'mercancia'
        ? <FormSolicitudMercancia datos={datos} call={call} aviso={aviso} onListo={cargar} />
        : <FormSolicitudAgua datos={datos} call={call} aviso={aviso} onListo={cargar} />}

      {verOpcionAnuladas && (
        <label className="card !p-3 flex items-center gap-3 min-h-[44px] text-sm">
          <input type="checkbox" className="h-5 w-5" checked={verAnuladas} onChange={(e) => setVerAnuladas(e.target.checked)} />
          <span>Mostrar también las anuladas</span>
        </label>
      )}

      <h3 className="font-bold">Solicitudes enviadas</h3>
      {lista === null ? <Cargando /> : lista.length === 0 ? <Vacio texto="Todavía no hay solicitudes" /> : lista
        .filter((s) => s.tipo_solicitud === tab)
        .map((s) => (
          <TarjetaSolicitud
            key={s.id}
            s={s}
            tipos={TIPOS_SOLICITUD_PRODUCTOS}
            puedeResolver={puedeResolver}
            puedeAnular={puedeAnular}
            call={call}
            aviso={aviso}
            onListo={cargar}
          />
        ))}
    </div>
  );
}

function FormSolicitudMercancia({ datos, call, aviso, onListo }) {
  const [titulo, setTitulo] = useState('Pedido de mercancía');
  const [descripcion, setDescripcion] = useState('');
  const [filas, setFilas] = useState([{ producto_id: '', cantidad_empaques: '' }]);
  const [enviando, setEnviando] = useState(false);

  const setFila = (i, k, v) => setFilas((p) => p.map((f, idx) => (idx === i ? { ...f, [k]: v } : f)));
  const porId = Object.fromEntries(datos.productos.map((p) => [String(p.id), p]));

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/solicitudes', {
        method: 'POST',
        body: {
          tipo_solicitud: 'mercancia',
          titulo,
          descripcion,
          detalle_items: filas.map((f) => ({
            producto_id: Number(f.producto_id),
            cantidad_empaques: Number(f.cantidad_empaques),
          })),
        },
      });
      aviso('Solicitud de mercancía enviada', 'ok');
      setFilas([{ producto_id: '', cantidad_empaques: '' }]);
      setDescripcion('');
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  const completo = filas.every((f) => f.producto_id && Number(f.cantidad_empaques) > 0);

  return (
    <form onSubmit={enviar} className="card space-y-3">
      <Campo etiqueta="Título">
        <input className="campo" value={titulo} onChange={(e) => setTitulo(e.target.value)} minLength={3} maxLength={120} required />
      </Campo>

      {datos.productos.length === 0 ? (
        <p className="text-sm text-slate-500">No hay productos en el catálogo todavía. Agrégalos con el botón de abajo.</p>
      ) : filas.map((f, i) => {
        const p = porId[f.producto_id];
        const total = p && f.cantidad_empaques ? Number(f.cantidad_empaques) * p.unidades_por_empaquetado : 0;
        return (
          <div key={i} className="rounded-xl border border-slate-200 p-3 space-y-2">
            <Campo etiqueta={`Producto ${i + 1}`}>
              <Select
                valor={f.producto_id}
                onChange={(v) => setFila(i, 'producto_id', v)}
                grupos={agruparProductos(datos.productos)}
                vacio="Seleccione…"
                required
              />
            </Campo>
            <Campo etiqueta={p ? `¿Cuántas ${EMPAQUETADO_PLURAL[p.empaquetado]}?` : 'Cantidad de empaques'}>
              <NumInput value={f.cantidad_empaques} onChange={(v) => setFila(i, 'cantidad_empaques', v)} step="1" required />
            </Campo>
            {total > 0 && (
              <p className="text-sm text-agua-800 bg-agua-50 rounded-lg p-2">
                Son <b>{nf0.format(total)}</b> unidades en total
              </p>
            )}
            {filas.length > 1 && (
              <button type="button" className="text-sm text-red-600 font-semibold" onClick={() => setFilas((p2) => p2.filter((_, idx) => idx !== i))}>
                Quitar producto
              </button>
            )}
          </div>
        );
      })}

      {datos.productos.length > 0 && (
        <button type="button" className="btn-sec w-full" onClick={() => setFilas((p) => [...p, { producto_id: '', cantidad_empaques: '' }])}>
          + Agregar otro producto al pedido
        </button>
      )}

      <AgregarProductoRapido call={call} aviso={aviso} onListo={onListo} />

      <Campo etiqueta="Nota (opcional)">
        <textarea className="campo" rows={2} maxLength={2000} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
      </Campo>
      <button className="btn-primario w-full" disabled={enviando || !completo || datos.productos.length === 0}>
        {enviando ? 'Enviando…' : 'Enviar solicitud'}
      </button>
    </form>
  );
}

function FormSolicitudAgua({ datos, call, aviso, onListo }) {
  const [titulo, setTitulo] = useState('Pedido de agua');
  const [litraje, setLitraje] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/solicitudes', {
        method: 'POST',
        body: {
          tipo_solicitud: 'agua',
          titulo,
          descripcion,
          litraje: Number(litraje),
          proveedor_id: Number(proveedor),
        },
      });
      aviso('Solicitud de agua enviada', 'ok');
      setLitraje('');
      setDescripcion('');
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form onSubmit={enviar} className="card space-y-3">
      <Campo etiqueta="Título">
        <input className="campo" value={titulo} onChange={(e) => setTitulo(e.target.value)} minLength={3} maxLength={120} required />
      </Campo>
      <Campo etiqueta="Litros a solicitar">
        <NumInput value={litraje} onChange={setLitraje} required placeholder="0" />
      </Campo>
      <Campo etiqueta="Proveedor de agua (obligatorio)">
        <Select
          valor={proveedor}
          onChange={setProveedor}
          opciones={filtrarProveedores(datos.proveedores, 'agua').map((p) => [String(p.id), p.nombre])}
          vacio="Seleccione…"
          required
        />
      </Campo>
      <AgregarProveedorRapido call={call} aviso={aviso} onListo={onListo} tipoPorDefecto="agua" />
      <Campo etiqueta="Nota (opcional)">
        <textarea className="campo" rows={2} maxLength={2000} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
      </Campo>
      <button className="btn-primario w-full" disabled={enviando || !litraje || !proveedor}>
        {enviando ? 'Enviando…' : 'Enviar solicitud'}
      </button>
    </form>
  );
}

function VistaIncidencias({ usuario, call, aviso }) {
  const [lista, setLista] = useState(null);
  const [f, setF] = useState({ tipo: 'operativa_tienda', severidad: 'media', titulo: '', descripcion: '' });
  const [enviando, setEnviando] = useState(false);
  const puedeResolver = puede(usuario, 'resolver_incidencias');
  const puedeAnular = puede(usuario, 'anular_registros');
  const esAdmin = puedeResolver || puedeAnular;

  const cargar = useCallback(async () => {
    try {
      setLista((await call('/api/incidencias')).incidencias);
    } catch (err) {
      aviso(err.message, 'error');
      setLista([]);
    }
  }, [call, aviso]);
  useEffect(() => { cargar(); }, [cargar]);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/incidencias', { method: 'POST', body: f });
      aviso('Incidencia reportada', 'ok');
      setF({ tipo: 'operativa_tienda', severidad: 'media', titulo: '', descripcion: '' });
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  const cambiarEstado = async (i, estado) => {
    try {
      await call(`/api/incidencias/${i.id}`, { method: 'PUT', body: { estado, notas_admin: i.notas_admin || '' } });
      aviso('Estado actualizado', 'ok');
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Titulo>Incidencias</Titulo>
      <form onSubmit={enviar} className="card space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Tipo"><Select valor={f.tipo} onChange={(v) => setF({ ...f, tipo: v })} opciones={TIPOS_INCIDENCIA} /></Campo>
          <Campo etiqueta="Severidad">
            <Select valor={f.severidad} onChange={(v) => setF({ ...f, severidad: v })} opciones={[['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta']]} />
          </Campo>
        </div>
        <Campo etiqueta="Título">
          <input className="campo" value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} minLength={3} maxLength={120} required />
        </Campo>
        <Campo etiqueta="Descripción (obligatoria)">
          <textarea className="campo" rows={3} maxLength={2000} value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} required />
        </Campo>
        <button className="btn-primario w-full" disabled={enviando}>{enviando ? 'Enviando…' : 'Reportar incidencia'}</button>
      </form>
      {lista === null ? <Cargando /> : lista.length === 0 ? <Vacio texto="No hay incidencias" /> : lista.map((i) => (
        <div key={i.id} className="card space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">{i.titulo || etiquetaDe(TIPOS_INCIDENCIA, i.tipo)}</p>
            <div className="flex gap-1 shrink-0">
              <Chip tono={tonoSeveridad(i.severidad)}>{i.severidad}</Chip>
              <Chip tono={tonoEstado(i.estado)}>{etiquetaEstado(i.estado)}</Chip>
            </div>
          </div>
          <p className="text-sm text-slate-500">
            {etiquetaDe(TIPOS_INCIDENCIA, i.tipo)}{i.placa ? ` · ${i.placa}` : ''} · {i.usuario} · {fmtFechaHora(i.fecha_hora)}
          </p>
          {i.descripcion && <p className="text-sm">{i.descripcion}</p>}
          {i.notas_admin && <p className="text-sm text-agua-800 bg-agua-50 rounded-lg p-2">Master: {i.notas_admin}</p>}
          <SelloAnulado registro={i} />
          {esAdmin && (
            <div className="flex items-center gap-2 pt-1">
              {puedeResolver && !i.anulado && (
                <SelectorEstado valor={i.estado} estados={ESTADOS_INCIDENCIA} onCambiar={(e) => cambiarEstado(i, e)} />
              )}
              {puedeAnular && (
                <BotonAnular recurso="incidencia" id={i.id} anulado={i.anulado} call={call} aviso={aviso} onListo={cargar} etiqueta="esta incidencia" />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Master: Reportes                                                    */
/* ------------------------------------------------------------------ */
function ResumenCasos({ filas, etiquetas }) {
  if (!filas || filas.length === 0) return null;
  const grupos = filas.reduce((acc, r) => {
    (acc[r.caso] = acc[r.caso] || []).push(r);
    return acc;
  }, {});
  return (
    <div className="card space-y-2">
      <h4 className="font-bold">Por caso y estado</h4>
      {Object.entries(grupos).map(([caso, rs]) => (
        <div key={caso} className="flex items-center justify-between gap-2 text-sm border-b border-slate-100 pb-2">
          <span className="font-semibold">{etiquetaDe(etiquetas, caso)}</span>
          <span className="flex flex-wrap justify-end gap-1">
            {rs.map((r) => <Chip key={r.estado} tono={tonoEstado(r.estado)}>{etiquetaEstado(r.estado)}: {r.total}</Chip>)}
          </span>
        </div>
      ))}
    </div>
  );
}

function VistaReportes({ call, aviso }) {
  const [tab, setTab] = useState('solicitudes');
  const [rango, setRango] = useState('30');
  const [estado, setEstado] = useState('');
  const [categoria, setCategoria] = useState('');
  const [datos, setDatos] = useState(null);

  const cargar = useCallback(async () => {
    setDatos(null);
    try {
      const hoy = hoyCaracas();
      const params = { tipo: tab, estado, categoria, hasta: hoy };
      if (rango !== 'todo') params.desde = sumarDias(hoy, -Number(rango));
      setDatos(await call(`/api/reportes/operativos${qs(params)}`));
    } catch (err) {
      aviso(err.message, 'error');
      setDatos({});
    }
  }, [call, aviso, tab, rango, estado, categoria]);
  useEffect(() => { cargar(); }, [cargar]);

  const cambiarTab = (t) => { setTab(t); setEstado(''); setCategoria(''); };
  const bloque = datos && datos[tab];
  const esSol = tab === 'solicitudes';
  const estados = esSol ? ESTADOS_SOLICITUD : ESTADOS_INCIDENCIA;
  const categorias = esSol ? TIPOS_SOLICITUD : TIPOS_INCIDENCIA;

  return (
    <div className="space-y-3">
      <Titulo>Reportes</Titulo>
      <Pestanas opciones={[['solicitudes', 'Solicitudes'], ['incidencias', 'Incidencias']]} activa={tab} onChange={cambiarTab} />
      <div className="grid grid-cols-3 gap-2">
        <Select
          valor={rango}
          onChange={setRango}
          opciones={[['7', '7 días'], ['30', '30 días'], ['90', '90 días'], ['todo', 'Todo']]}
          aria-label="Periodo"
        />
        <Select valor={estado} onChange={setEstado} opciones={estados.map((e) => [e, etiquetaEstado(e)])} vacio="Estado" aria-label="Estado" />
        <Select valor={categoria} onChange={setCategoria} opciones={categorias} vacio="Tipo" aria-label="Tipo" />
      </div>

      {datos === null ? <Cargando /> : !bloque ? <Vacio texto="Sin datos" /> : (
        <>
          <div className="flex flex-wrap gap-2">
            {bloque.por_estado.map((r) => <Chip key={r.estado} tono={tonoEstado(r.estado)}>{etiquetaEstado(r.estado)}: {r.total}</Chip>)}
            <Chip>Total: {bloque.items.length}</Chip>
          </div>
          <ResumenCasos filas={bloque.por_caso} etiquetas={categorias} />
          {bloque.items.length === 0 ? <Vacio texto="No hay registros con esos filtros" /> : bloque.items.map((it) => (
            <div key={it.id} className="card space-y-1">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{it.titulo || etiquetaDe(categorias, it.tipo_solicitud || it.tipo)}</p>
                <div className="flex gap-1 shrink-0">
                  {it.severidad && <Chip tono={tonoSeveridad(it.severidad)}>{it.severidad}</Chip>}
                  <Chip tono={tonoEstado(it.estado)}>{etiquetaEstado(it.estado)}</Chip>
                </div>
              </div>
              <p className="text-sm text-slate-500">
                {etiquetaDe(categorias, it.tipo_solicitud || it.tipo)}{it.placa ? ` · ${it.placa}` : ''} · {it.usuario} · {fmtFechaHora(it.fecha_hora)}
              </p>
              {it.descripcion && <p className="text-sm">{it.descripcion}</p>}
              {it.notas_admin && <p className="text-sm text-agua-800 bg-agua-50 rounded-lg p-2">Master: {it.notas_admin}</p>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Master: Reporte de motos                                            */
/* ------------------------------------------------------------------ */
/** Edición de la ficha de la moto. Hace falta para corregir el kilometraje
 *  cuando se anula un checklist que lo dejó mal. */
function EditarMoto({ moto, call, aviso, onListo }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({
    nombre: moto.nombre,
    color: moto.color,
    placa: moto.placa,
    tipo_modelo: moto.tipo_modelo,
    ultimo_kilometraje: String(moto.ultimo_kilometraje),
    ultimo_cambio_aceite_km: String(moto.ultimo_cambio_aceite_km),
    activa: moto.activa,
  });
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    setGuardando(true);
    try {
      await call(`/api/motos/${moto.id}`, {
        method: 'PUT',
        body: {
          ...f,
          ultimo_kilometraje: Number(f.ultimo_kilometraje),
          ultimo_cambio_aceite_km: Number(f.ultimo_cambio_aceite_km),
        },
      });
      aviso('Moto actualizada', 'ok');
      setAbierto(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  if (!abierto) {
    return (
      <button type="button" className="btn-sec w-full !py-2 !min-h-[40px] !text-sm" onClick={() => setAbierto(true)}>
        Corregir datos de la moto
      </button>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Corregir datos</h4>
        <button type="button" className="text-slate-500 text-2xl px-2" onClick={() => setAbierto(false)} aria-label="Cerrar">×</button>
      </div>
      <Campo etiqueta="Nombre">
        <input className="campo" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} minLength={2} />
      </Campo>
      <div className="grid grid-cols-2 gap-2">
        <Campo etiqueta="Color">
          <input className="campo" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} minLength={2} />
        </Campo>
        <Campo etiqueta="Placa">
          <input className="campo uppercase" value={f.placa} onChange={(e) => setF({ ...f, placa: e.target.value.toUpperCase() })} minLength={3} />
        </Campo>
      </div>
      <Campo etiqueta="Modelo">
        <Select valor={f.tipo_modelo} onChange={(v) => setF({ ...f, tipo_modelo: v })} opciones={MODELOS} />
      </Campo>
      <div className="grid grid-cols-2 gap-2">
        <Campo etiqueta="Kilometraje actual">
          <NumInput value={f.ultimo_kilometraje} onChange={(v) => setF({ ...f, ultimo_kilometraje: v })} step="1" />
        </Campo>
        <Campo etiqueta="Km del último aceite">
          <NumInput value={f.ultimo_cambio_aceite_km} onChange={(v) => setF({ ...f, ultimo_cambio_aceite_km: v })} step="1" />
        </Campo>
      </div>
      <p className="text-xs text-slate-500">
        Si anulaste un checklist con el kilometraje mal escrito, corrígelo aquí antes de que lo vuelvan a hacer.
      </p>
      <label className="flex items-center gap-3 min-h-[44px]">
        <input type="checkbox" className="h-6 w-6" checked={f.activa} onChange={(e) => setF({ ...f, activa: e.target.checked })} />
        <span className="font-medium">Moto activa</span>
      </label>
      <button type="button" className="btn-primario w-full" disabled={guardando} onClick={guardar}>
        {guardando ? 'Guardando…' : 'Guardar cambios'}
      </button>
    </div>
  );
}

/*
 * Combustible de una moto: lo que se le ha surtido y el formulario para
 * cargar una tanqueada nueva.
 *
 * El monto va en bolívares porque es la moneda con la que se paga en la
 * bomba. No entra a los costos operativos del cierre de caja: esa gestión
 * se lleva aparte.
 */
const METODOS_COMBUSTIBLE = [
  ['transferencia', 'Transferencia'],
  ['pago_movil', 'Pago móvil'],
  ['tarjeta_debito', 'Tarjeta de débito'],
];
const etiquetaMetodo = (m) => (METODOS_COMBUSTIBLE.find(([k]) => k === m) || [null, m])[1];

function TabCombustible({ moto, cargas, totales, call, aviso, onListo, puedeAnular }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({ litros: '', monto_bs: '', metodo_pago: 'pago_movil', observacion: '' });
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/combustible', {
        method: 'POST',
        body: {
          moto_id: moto.id,
          litros: Number(f.litros),
          monto_bs: Number(f.monto_bs || 0),
          metodo_pago: f.metodo_pago,
          observacion: f.observacion || undefined,
        },
      });
      aviso('Combustible registrado', 'ok');
      setF({ litros: '', monto_bs: '', metodo_pago: 'pago_movil', observacion: '' });
      setAbierto(false);
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  const vivas = cargas.filter((c) => !c.anulado);

  return (
    <div className="space-y-3">
      <div className="card space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-bold">⛽ Combustible</h3>
            <p className="text-xs text-slate-500">
              La fecha la pone el sistema. El monto va en bolívares.
            </p>
          </div>
          <button
            type="button"
            className="btn-sec !py-2 !min-h-[40px] shrink-0"
            onClick={() => setAbierto((v) => !v)}
          >
            {abierto ? 'Cerrar' : '+ Cargar'}
          </button>
        </div>

        {totales && vivas.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            <Tarjeta titulo="Tanqueadas" valor={nf0.format(totales.cargas)} />
            <Tarjeta titulo="Litros" valor={nf.format(totales.litros)} />
            <Tarjeta titulo="Gasto" valor={fmtBs(totales.monto_bs)} />
          </div>
        )}

        {abierto && (
          <form onSubmit={enviar} className="rounded-xl bg-slate-50 p-3 space-y-3">
            <p className="font-bold text-sm">{moto.nombre} · {moto.placa}</p>
            <div className="grid grid-cols-2 gap-2">
              <Campo etiqueta="Litros">
                <NumInput value={f.litros} onChange={(v) => setF({ ...f, litros: v })} required />
              </Campo>
              <Campo etiqueta="Monto en Bs">
                <NumInput value={f.monto_bs} onChange={(v) => setF({ ...f, monto_bs: v })} required />
              </Campo>
            </div>
            <Campo etiqueta="Método de pago">
              <Select
                valor={f.metodo_pago}
                onChange={(v) => setF({ ...f, metodo_pago: v })}
                opciones={METODOS_COMBUSTIBLE}
              />
            </Campo>
            <Campo etiqueta="Observación (opcional)">
              <input
                className="campo"
                maxLength={300}
                value={f.observacion}
                onChange={(e) => setF({ ...f, observacion: e.target.value })}
              />
            </Campo>
            <button className="btn-primario w-full" disabled={enviando}>
              {enviando ? 'Guardando…' : 'Registrar combustible'}
            </button>
          </form>
        )}
      </div>

      {cargas.length === 0 ? <Vacio texto="Sin combustible registrado" /> : cargas.map((c) => (
        <div key={c.id} className={`card !p-3 text-sm space-y-1 ${c.anulado ? 'opacity-75' : ''}`}>
          <div className="flex justify-between items-start gap-2">
            <span className="font-semibold">{fmtFecha(c.fecha)}</span>
            <div className="flex gap-1 shrink-0 flex-wrap justify-end">
              {c.anulado && <Chip tono="gris">anulado</Chip>}
              <Chip tono="azul">{etiquetaMetodo(c.metodo_pago)}</Chip>
            </div>
          </div>
          <p className="text-slate-600">
            {nf.format(c.litros)} litros · {fmtBs(c.monto_bs)} · {c.usuario}
          </p>
          {c.observacion && <p className="text-slate-500 text-xs">{c.observacion}</p>}
          <SelloAnulado registro={c} />
          {puedeAnular && (
            <div className="flex justify-end pt-1">
              <BotonAnular
                recurso="combustible"
                id={c.id}
                anulado={c.anulado}
                call={call}
                aviso={aviso}
                onListo={onListo}
                etiqueta={`la carga de combustible del ${fmtFecha(c.fecha)}`}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DetalleMoto({ detalle, onVolver, call, aviso, verFoto, onRecargar, puedeAnular }) {
  const {
    moto, checklists, incidencias, cambios_aceite: cambios,
    combustible = [], combustible_totales: totalesComb,
  } = detalle;
  const [tab, setTab] = useState('checklists');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button className="btn-sec !py-2 !min-h-[40px] !px-3" onClick={onVolver}>←</button>
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-agua-900 truncate">{moto.nombre}</h2>
          <p className="text-sm text-slate-500">
            {moto.placa} · {moto.color} · {etiquetaDe(MODELOS, moto.tipo_modelo)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Tarjeta titulo="Kilometraje" valor={`${nf0.format(moto.ultimo_kilometraje)} km`} destacado />
        <Tarjeta
          titulo="Desde el último aceite"
          valor={`${nf0.format(moto.ultimo_kilometraje - moto.ultimo_cambio_aceite_km)} km`}
        />
      </div>
      <AvisoAceite aviso={moto.aviso_aceite} />

      <EditarMoto moto={moto} call={call} aviso={aviso} onListo={onRecargar} />

      <Pestanas
        opciones={[
          ['checklists', `Checklists (${checklists.length})`],
          ['aceite', `Aceite (${cambios.length})`],
          ['combustible', `Combustible (${combustible.filter((f) => !f.anulado).length})`],
          ['incidencias', `Incidencias (${incidencias.length})`],
        ]}
        activa={tab}
        onChange={setTab}
      />

      {tab === 'checklists' && (checklists.length === 0 ? <Vacio texto="Sin checklists registrados" /> : checklists.map((c) => {
        const items = c.detalles_items && typeof c.detalles_items === 'object' ? c.detalles_items : {};
        const fallas = Object.entries(items).filter(([, ok]) => ok === false).map(([k]) => k);
        return (
          <div key={c.id} className={`card !p-3 mb-2 text-sm space-y-1 ${c.anulado ? 'opacity-75' : ''}`}>
            <div className="flex justify-between items-start gap-2">
              <span className="font-semibold">{fmtFecha(c.fecha_local)}</span>
              <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                {c.anulado && <Chip tono="gris">anulado</Chip>}
                {c.cambio_aceite_realizado && <Chip tono="azul">Cambio de aceite</Chip>}
                {c.tiene_falla ? <Chip tono="rojo">Con falla</Chip> : <Chip tono="verde">Sin novedad</Chip>}
              </div>
            </div>
            <p className="text-slate-500">
              {c.se_uso_hoy ? `Usada · ${nf0.format(c.kilometraje_inicial || 0)} km` : 'No se usó'} · {c.usuario}
            </p>
            {fallas.length > 0 && (
              <p className="text-red-700 bg-red-50 rounded-lg p-2">
                <b>Marcado negativo:</b> {fallas.join(', ')}
              </p>
            )}
            {c.observacion_falla && <p className="text-slate-700">{c.observacion_falla}</p>}
            {(c.foto_tablero || c.foto_frontal || c.foto_trasera || c.foto_falla_url) && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <FotoGuardada ruta={c.foto_tablero} etiqueta="Tablero" verFoto={verFoto} aviso={aviso} />
                <FotoGuardada ruta={c.foto_frontal} etiqueta="Frontal" verFoto={verFoto} aviso={aviso} />
                <FotoGuardada ruta={c.foto_trasera} etiqueta="Trasera" verFoto={verFoto} aviso={aviso} />
                {c.foto_falla_url && !/^https?:\/\//i.test(c.foto_falla_url) && (
                  <FotoGuardada ruta={c.foto_falla_url} etiqueta="La falla" verFoto={verFoto} aviso={aviso} />
                )}
              </div>
            )}
            <SelloAnulado registro={c} />
            <div className="flex justify-end pt-1">
              <BotonAnular
                recurso="checklist"
                id={c.id}
                anulado={c.anulado}
                call={call}
                aviso={aviso}
                onListo={onRecargar}
                etiqueta={`el checklist del ${fmtFecha(c.fecha_local)}`}
              />
            </div>
          </div>
        );
      }))}

      {tab === 'aceite' && (cambios.length === 0 ? <Vacio texto="Sin cambios de aceite registrados" /> : cambios.map((c, i) => (
        <div key={i} className="card !p-3 mb-2 flex justify-between text-sm">
          <span className="font-semibold">{fmtFechaHora(c.fecha)}</span>
          <span>{c.kilometraje !== null ? `${nf0.format(c.kilometraje)} km` : '—'} · {c.usuario}</span>
        </div>
      )))}

      {tab === 'combustible' && (
        <TabCombustible
          moto={moto}
          cargas={combustible}
          totales={totalesComb}
          call={call}
          aviso={aviso}
          onListo={onRecargar}
          puedeAnular={puedeAnular}
        />
      )}

      {tab === 'incidencias' && (incidencias.length === 0 ? <Vacio texto="Sin incidencias" /> : incidencias.map((i) => (
        <div key={i.id} className={`card !p-3 mb-2 text-sm space-y-1 ${i.anulado ? 'opacity-75' : ''}`}>
          <div className="flex justify-between items-start gap-2">
            <span className="font-semibold">{i.titulo}</span>
            <div className="flex gap-1 shrink-0">
              {i.anulado && <Chip tono="gris">anulada</Chip>}
              <Chip tono={tonoSeveridad(i.severidad)}>{i.severidad}</Chip>
              <Chip tono={tonoEstado(i.estado)}>{etiquetaEstado(i.estado)}</Chip>
            </div>
          </div>
          <p className="text-slate-500">{fmtFechaHora(i.fecha_hora)} · {i.usuario}</p>
          {i.descripcion && <p>{i.descripcion}</p>}
          <SelloAnulado registro={i} />
          <div className="flex justify-end pt-1">
            <BotonAnular recurso="incidencia" id={i.id} anulado={i.anulado} call={call} aviso={aviso} onListo={onRecargar} etiqueta="esta incidencia" />
          </div>
        </div>
      )))}
    </div>
  );
}

function VistaReporteMotos({ usuario, call, aviso, verFoto }) {
  const [datos, setDatos] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [abriendo, setAbriendo] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setDatos(await call('/api/reportes/motos'));
    } catch (err) {
      aviso(err.message, 'error');
      setDatos({ motos: [], alertas: { total: 0, incidencias_abiertas: [], items_en_falla: [], aceite_vencido: [] } });
    }
  }, [call, aviso]);
  useEffect(() => { cargar(); }, [cargar]);

  const abrir = async (m) => {
    setAbriendo(true);
    try {
      setDetalle(await call(`/api/reportes/motos/${m.id}`));
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setAbriendo(false);
    }
  };

  const recargarDetalle = useCallback(async () => {
    if (!detalle) return;
    try {
      const fresco = await call(`/api/reportes/motos/${detalle.moto.id}`);
      setDetalle(fresco);
      cargar(); // la lista y las alertas también cambian
    } catch (err) {
      aviso(err.message, 'error');
    }
  }, [detalle, call, aviso, cargar]);

  if (datos === null) return <Cargando />;
  if (detalle) {
    return (
      <DetalleMoto
        detalle={detalle}
        onVolver={() => { setDetalle(null); cargar(); }}
        call={call}
        aviso={aviso}
        verFoto={verFoto}
        onRecargar={recargarDetalle}
        puedeAnular={puede(usuario, 'anular_registros')}
      />
    );
  }

  const a = datos.alertas;

  return (
    <div className="space-y-3">
      <Titulo>Reporte de motos</Titulo>

      {a.total > 0 ? (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 space-y-2">
          <p className="font-bold text-red-800">
            ⚠️ {a.total} {a.total === 1 ? 'asunto requiere' : 'asuntos requieren'} tu atención
          </p>

          {a.incidencias_abiertas.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-red-800 mt-2">Incidencias sin cerrar</p>
              {a.incidencias_abiertas.map((i) => (
                <p key={i.id} className="text-sm text-red-900">
                  • <b>{i.moto} ({i.placa})</b>: {i.titulo} — {fmtFechaHora(i.fecha_hora)}
                </p>
              ))}
            </div>
          )}

          {a.items_en_falla.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-red-800 mt-2">Puntos marcados como negativos (últimos 30 días)</p>
              {a.items_en_falla.slice(0, 15).map((it, i) => (
                <p key={i} className="text-sm text-red-900">
                  • <b>{it.moto}</b>: {it.item} — {fmtFechaHora(it.fecha)}
                </p>
              ))}
              {a.items_en_falla.length > 15 && (
                <p className="text-xs text-red-700">y {a.items_en_falla.length - 15} más…</p>
              )}
            </div>
          )}

          {a.aceite_vencido.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-red-800 mt-2">Cambio de aceite vencido</p>
              {a.aceite_vencido.map((m) => (
                <p key={m.moto_id} className="text-sm text-red-900">
                  • <b>{m.moto} ({m.placa})</b>: {nf0.format(m.km_desde_aceite)} km desde el último cambio
                </p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4">
          <p className="font-bold text-emerald-800">✓ Sin novedades en las motos</p>
          <p className="text-sm text-emerald-700">Ninguna incidencia abierta ni punto marcado como negativo.</p>
        </div>
      )}

      <p className="text-sm text-slate-500">Toca una moto para ver su historial completo.</p>

      {datos.motos.length === 0 ? <Vacio texto="No hay motos registradas" /> : datos.motos.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={abriendo}
          onClick={() => abrir(m)}
          className="card w-full text-left space-y-1 disabled:opacity-60"
        >
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0">
              <p className="font-bold">{m.nombre}</p>
              <p className="text-sm text-slate-500 truncate">
                {m.placa} · {nf0.format(m.ultimo_kilometraje)} km
              </p>
            </div>
            <span className="text-slate-400 shrink-0">›</span>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Chip tono={m.km_desde_aceite >= datos.km_aviso_aceite ? 'rojo' : m.km_desde_aceite >= datos.km_aviso_aceite * 0.85 ? 'ambar' : 'verde'}>
              Aceite: {nf0.format(m.km_desde_aceite)} km
            </Chip>
            {m.incidencias_abiertas > 0 && <Chip tono="rojo">{m.incidencias_abiertas} incidencia(s)</Chip>}
            {m.checklists_con_falla > 0 && <Chip tono="ambar">{m.checklists_con_falla} con falla</Chip>}
            <Chip>{m.checklists_total} checklist(s)</Chip>
            {m.checklist_hoy ? <Chip tono="verde">Hoy ✓</Chip> : <Chip tono="ambar">Falta hoy</Chip>}
          </div>
          {m.ultimo_cambio_aceite && (
            <p className="text-xs text-slate-400">Último aceite: {fmtFechaHora(m.ultimo_cambio_aceite)}</p>
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Master: Finanzas                                                    */
/* ------------------------------------------------------------------ */
function Tarjeta({ titulo, valor, destacado, nota }) {
  return (
    <div className={`rounded-2xl p-4 border ${destacado ? 'bg-agua-600 text-white border-agua-700' : 'bg-white border-slate-200'}`}>
      <p className={`text-sm ${destacado ? 'text-agua-100' : 'text-slate-500'}`}>{titulo}</p>
      <p className="text-xl font-extrabold break-words">{valor}</p>
      {nota && <p className={`text-xs ${destacado ? 'text-agua-100' : 'text-slate-400'}`}>{nota}</p>}
    </div>
  );
}

function TablaPeriodos({ filas, formato }) {
  if (!filas || filas.length === 0) return <Vacio texto="Sin cierres en el periodo" />;
  return (
    <div className="space-y-2">
      {filas.map((r) => (
        <div key={r.periodo} className="card !p-3 text-sm">
          <div className="flex justify-between font-semibold">
            <span>{formato(r.periodo)}</span>
            <span>{fmtBs(r.total_bs)}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 text-slate-600 mt-1">
            <span>P. móvil: {fmtBs(r.pago_movil_bs)}</span>
            <span>Efectivo: {fmtBs(r.efectivo_bs)}</span>
            <span>Punto: {fmtBs(r.punto_venta_bs)}</span>
            <span>Dólares: {fmtUsd(r.total_usd)}</span>
            <span>Impuestos: {fmtBs(r.impuestos_bs)}</span>
            <span>Costos: {fmtUsd(r.costos_usd)}</span>
          </div>
          <div className="flex justify-between mt-1 pt-1 border-t border-slate-100">
            <span className="text-slate-500">Neto</span>
            <b className={Number(r.neto_bs) < 0 ? 'text-red-700' : ''}>{fmtBs(r.neto_bs)}</b>
          </div>
        </div>
      ))}
    </div>
  );
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/*
 * Los promedios de facturación.
 *
 * El dólar va primero porque es lo único comparable entre periodos: en
 * bolívares, una tasa que se movió hace parecer que el negocio creció
 * cuando vendió exactamente lo mismo. El bolívar va debajo como
 * referencia de lo que de verdad pasó por la caja.
 *
 * Y todos los promedios diarios se dividen entre los días que la tienda
 * ABRIÓ, no entre los días del calendario: un domingo cerrado no es un
 * día flojo, es un día que no existió.
 */
function TarjetasPromedios({ p }) {
  const [abierto, setAbierto] = useState(false);
  const sa = p.semana_anterior;
  const c4 = p.ultimas_4_semanas;
  const cm = p.cierre_mes;
  const usd = (v) => (v === null || v === undefined ? '—' : fmtUsd(v));
  const bs = (v) => (v === null || v === undefined ? '' : fmtBs(v));

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-bold">Promedios de facturación</h3>
          <p className="text-xs text-slate-500">
            En dólares, que es lo comparable entre semanas. Divididos entre los días que abrió.
          </p>
        </div>
        <button type="button" className="btn-sec !py-2 !min-h-[40px] shrink-0" onClick={() => setAbierto((v) => !v)}>
          {abierto ? 'Menos' : 'Detalle'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Tarjeta
          titulo="Promedio diario"
          valor={usd(sa.promedio_usd)}
          nota={sa.dias_operados > 0
            ? `${bs(sa.promedio_bs)} · semana pasada, ${nf0.format(sa.dias_operados)} día(s)`
            : 'Sin datos la semana pasada'}
          destacado
        />
        <Tarjeta
          titulo="Promedio semanal"
          valor={usd(c4.promedio_semanal_usd)}
          nota={c4.semanas_con_datos > 0
            ? `${bs(c4.promedio_semanal_bs)} · ${nf0.format(c4.semanas_con_datos)} de las últimas 4 semanas`
            : 'Sin datos en las últimas 4 semanas'}
          destacado
        />
      </div>

      {abierto && (
        <>
          <div>
            <p className="etiqueta">La semana pasada ({fmtFecha(sa.desde)} al {fmtFecha(sa.hasta)})</p>
            <p className="text-sm text-slate-600">
              {usd(sa.total_usd)} en total · {bs(sa.total_bs)} · abrió {nf0.format(sa.dias_operados)} día(s)
            </p>
          </div>

          <div>
            <p className="etiqueta">Las últimas 4 semanas, una por una</p>
            <div className="space-y-1">
              {c4.semanas.map((w) => (
                <div key={w.desde} className="flex justify-between text-sm border-b border-slate-100 py-1">
                  <span className="text-slate-500">
                    {fmtFecha(w.desde)} al {fmtFecha(w.hasta)}
                  </span>
                  <span className="shrink-0">
                    {w.dias_operados > 0
                      ? <>{usd(w.total_usd)} <span className="text-slate-400">· {nf0.format(w.dias_operados)}d</span></>
                      : <span className="text-slate-400">sin datos</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 p-3">
            <p className="font-bold text-sm">
              Cierre de {MESES[Number(cm.mes.slice(5, 7)) - 1]} {cm.mes.slice(0, 4)}
            </p>
            {cm.dias_operados > 0 ? (
              <div className="mt-1 space-y-0.5 text-sm text-slate-600">
                <p>Facturado: <b>{usd(cm.total_usd)}</b> · {bs(cm.total_bs)}</p>
                <p>Promedio por día abierto: <b>{usd(cm.promedio_usd)}</b> · {bs(cm.promedio_bs)}</p>
                <p>Promedio por semana: <b>{usd(cm.promedio_semanal_usd)}</b> · {bs(cm.promedio_semanal_bs)}</p>
                <p>
                  Abrió {nf0.format(cm.dias_operados)} de {nf0.format(cm.dias_esperados)} días laborables
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500 mt-1">Sin cierres registrados ese mes.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function VistaFinanzas({ call, aviso }) {
  const hoy = hoyCaracas();
  const [rango, setRango] = useState('mes');
  const [tab, setTab] = useState('diario');
  const [datos, setDatos] = useState(null);
  const [promedios, setPromedios] = useState(null);
  /* Periodo a medida: un rango continuo o días sueltos no consecutivos */
  const [desde, setDesde] = useState(`${hoy.slice(0, 7)}-01`);
  const [hasta, setHasta] = useState(hoy);
  const [diaSuelto, setDiaSuelto] = useState('');
  const [diasSueltos, setDiasSueltos] = useState([]);
  const [aplicado, setAplicado] = useState(0);

  const cargar = useCallback(async () => {
    setDatos(null);
    try {
      const params = { hasta: hoy };
      if (rango === '7') params.desde = sumarDias(hoy, -6);
      if (rango === 'mes') params.desde = `${hoy.slice(0, 7)}-01`;
      if (rango === '90') params.desde = sumarDias(hoy, -89);
      if (rango === 'libre') {
        if (diasSueltos.length) {
          delete params.hasta;
          params.dias = diasSueltos.join(',');
        } else {
          params.desde = desde;
          params.hasta = hasta;
        }
      }
      setDatos(await call(`/api/reportes/financieros${qs(params)}`));
    } catch (err) {
      aviso(err.message, 'error');
      setDatos({});
    }
  // aplicado fuerza la recarga sólo cuando se toca "Aplicar", para no
  // consultar en cada tecleo mientras se escribe una fecha
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, aviso, rango, hoy, aplicado]);
  useEffect(() => { cargar(); }, [cargar]);

  /* Los promedios no dependen del periodo elegido: son fijos por definición */
  useEffect(() => {
    let vivo = true;
    call('/api/reportes/promedios')
      .then((d) => { if (vivo) setPromedios(d); })
      .catch(() => { if (vivo) setPromedios(null); });
    return () => { vivo = false; };
  }, [call]);

  const agregarDia = () => {
    if (!diaSuelto || diasSueltos.includes(diaSuelto)) return;
    setDiasSueltos((p) => [...p, diaSuelto].sort());
    setDiaSuelto('');
  };

  const t = datos && datos.totales;

  return (
    <div className="space-y-3">
      <Titulo>Finanzas</Titulo>
      <Pestanas
        opciones={[['7', '7 días'], ['mes', 'Este mes'], ['90', '90 días'], ['todo', 'Acumulado'], ['libre', 'A medida']]}
        activa={rango}
        onChange={setRango}
      />

      {promedios && <TarjetasPromedios p={promedios} />}

      {rango === 'libre' && (
        <div className="card space-y-3">
          <div>
            <h3 className="font-bold">Periodo a medida</h3>
            <p className="text-xs text-slate-500">
              Un rango de fechas, o días sueltos para comparar entre sí
              (por ejemplo los últimos tres sábados).
            </p>
          </div>

          {diasSueltos.length === 0 && (
            <div className="grid grid-cols-2 gap-2">
              <Campo etiqueta="Desde">
                <input type="date" className="campo" value={desde} max={hoy} onChange={(e) => setDesde(e.target.value)} />
              </Campo>
              <Campo etiqueta="Hasta">
                <input type="date" className="campo" value={hasta} max={hoy} onChange={(e) => setHasta(e.target.value)} />
              </Campo>
            </div>
          )}

          <div>
            <p className="etiqueta">Días sueltos</p>
            <div className="flex gap-2">
              <input type="date" className="campo" value={diaSuelto} max={hoy} onChange={(e) => setDiaSuelto(e.target.value)} />
              <button type="button" className="btn-sec !px-3 shrink-0" onClick={agregarDia}>Agregar</button>
            </div>
            {diasSueltos.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {diasSueltos.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="chip bg-sky-100 text-sky-800"
                    onClick={() => setDiasSueltos((p) => p.filter((x) => x !== d))}
                  >
                    {fmtFecha(d)} ×
                  </button>
                ))}
                <button type="button" className="chip bg-slate-100 text-slate-700" onClick={() => setDiasSueltos([])}>
                  limpiar
                </button>
              </div>
            )}
          </div>

          <button type="button" className="btn-primario w-full" onClick={() => setAplicado((n) => n + 1)}>
            Aplicar
          </button>
        </div>
      )}
      {datos === null ? <Cargando /> : !t ? <Vacio texto="Sin datos" /> : (
        <>
          <p className="text-sm text-slate-500">
            {datos.desde === '1900-01-01' ? 'Desde el inicio' : fmtFecha(datos.desde)} al {fmtFecha(datos.hasta)} · {t.cierres} cierre(s)
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Tarjeta titulo="Total bolívares" valor={fmtBs(t.total_bs)} destacado />
            <Tarjeta titulo="Total dólares" valor={fmtUsd(t.total_usd)} destacado />
            <Tarjeta titulo="Pago móvil" valor={fmtBs(t.pago_movil_bs)} />
            <Tarjeta titulo="Efectivo" valor={fmtBs(t.efectivo_bs)} />
            <Tarjeta titulo="Punto de venta" valor={fmtBs(t.punto_venta_bs)} />
            <Tarjeta titulo="Impuestos fiscales" valor={fmtBs(t.impuestos_bs)} />
            <Tarjeta titulo="Costos operativos" valor={fmtUsd(t.costos_usd)} nota={`${fmtBs(t.costos_bs)} a la tasa de cada día`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Tarjeta titulo="Neto en Bs" valor={fmtBs(t.neto_bs)} nota="Total − impuestos − costos" />
            <Tarjeta titulo="Tasa promedio" valor={t.tasa_promedio ? fmtTasa(t.tasa_promedio) : '—'} nota="Promedio del periodo" />
          </div>
          {datos.promedios && datos.promedios.dias_operados !== null && (
            <div className="grid grid-cols-2 gap-3">
              <Tarjeta
                titulo="Promedio por día"
                valor={datos.promedios.por_dia_usd !== null ? fmtUsd(datos.promedios.por_dia_usd) : '—'}
                nota={datos.promedios.por_dia_bs !== null ? fmtBs(datos.promedios.por_dia_bs) : ''}
                destacado
              />
              <Tarjeta
                titulo="Días que abrió"
                valor={nf0.format(datos.promedios.dias_operados)}
                nota="El promedio se divide entre estos"
              />
            </div>
          )}
          {Array.isArray(datos.dias_sin_registrar) && datos.dias_sin_registrar.length > 0 && (
            <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-bold">
                {datos.dias_sin_registrar.length === 1
                  ? 'Hay 1 día laborable sin registrar'
                  : `Hay ${datos.dias_sin_registrar.length} días laborables sin registrar`}
              </p>
              <p className="text-xs mt-1">
                Ni apertura ni cierre de caja, así que no entran a los promedios:
                {' '}{datos.dias_sin_registrar.map(fmtFecha).join(', ')}
              </p>
            </div>
          )}
          <Pestanas opciones={[['diario', 'Diario'], ['semanal', 'Semanal'], ['mensual', 'Mensual']]} activa={tab} onChange={setTab} />
          {tab === 'diario' && <TablaPeriodos filas={datos.diario} formato={fmtFecha} />}
          {tab === 'semanal' && <TablaPeriodos filas={datos.semanal} formato={(p) => `Semana del ${fmtFecha(p)}`} />}
          {tab === 'mensual' && <TablaPeriodos filas={datos.mensual} formato={(p) => `${MESES[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`} />}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Master: Accesos                                                     */
/* ------------------------------------------------------------------ */
/*
 * Los cargos del equipo. Un cargo es un PERFIL: guarda su nombre y, dentro,
 * qué formularios trae y qué funciones especiales concede. Al asignarlo, la
 * persona hereda todo eso; al editarlo, cambia para todos los que lo tengan.
 *
 * Sólo el Master entra aquí: quien pudiera crear un cargo se armaría uno con
 * todo y se lo asignaría.
 */
const ROL_VACIO = { nombre: '', modulos_permitidos: [], permisos_especiales: [] };

function PanelRoles({ roles, disponibles, permisosDisp, call, aviso, recargar }) {
  const [editando, setEditando] = useState(null); // clave del rol, o 'nuevo'
  const [borrador, setBorrador] = useState(ROL_VACIO);
  const [guardando, setGuardando] = useState(false);

  const cerrar = () => { setEditando(null); setBorrador(ROL_VACIO); };
  const abrirNuevo = () => { setBorrador(ROL_VACIO); setEditando('nuevo'); };
  const abrirRol = (r) => {
    setBorrador({
      nombre: r.nombre,
      modulos_permitidos: [...(r.modulos_permitidos || [])],
      permisos_especiales: [...(r.permisos_especiales || [])],
    });
    setEditando(r.clave);
  };

  const alternar = (campo, v) => setBorrador((b) => ({
    ...b,
    [campo]: b[campo].includes(v) ? b[campo].filter((x) => x !== v) : [...b[campo], v],
  }));

  const guardar = async (e) => {
    e.preventDefault();
    setGuardando(true);
    try {
      if (editando === 'nuevo') {
        await call('/api/roles', { method: 'POST', body: borrador });
        aviso(`Cargo “${borrador.nombre}” creado. Ya puedes asignarlo.`, 'ok');
      } else {
        await call(`/api/roles/${editando}`, { method: 'PUT', body: borrador });
        aviso(`“${borrador.nombre}” actualizado. Cambia para todos los que lo tengan.`, 'ok');
      }
      cerrar();
      await recargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (r) => {
    if (!window.confirm(`¿Eliminar el cargo “${r.nombre}”? Nadie lo tiene asignado.`)) return;
    try {
      await call(`/api/roles/${r.clave}`, { method: 'DELETE' });
      aviso('Cargo eliminado', 'ok');
      await recargar();
    } catch (err) {
      aviso(err.message, 'error');
    }
  };

  const resumen = (r) => {
    if (r.es_master) return 'Acceso total al sistema';
    const m = (r.modulos_permitidos || []).length;
    const p = (r.permisos_especiales || []).length;
    if (!m && !p) return 'No trae permisos: cada persona los lleva en su ficha';
    return [
      m ? `${m} formulario${m === 1 ? '' : 's'}` : null,
      p ? `${p} función${p === 1 ? '' : 'es'} especial${p === 1 ? '' : 'es'}` : null,
    ].filter(Boolean).join(' · ');
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-bold">Cargos del equipo</h3>
          <p className="text-xs text-slate-500">
            Un cargo guarda sus permisos. Al asignarlo la persona los hereda; si lo
            editas, cambia para todos los que lo tengan.
          </p>
        </div>
        <button
          type="button"
          className="btn-sec !py-2 !min-h-[40px] shrink-0"
          onClick={editando === 'nuevo' ? cerrar : abrirNuevo}
        >
          {editando === 'nuevo' ? 'Cerrar' : '+ Cargo'}
        </button>
      </div>

      <div className="space-y-1">
        {roles.map((r) => (
          <div key={r.clave} className="flex items-center gap-2 py-2 border-b border-slate-100">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{r.nombre}</span>
              <span className="block text-xs text-slate-500">{resumen(r)}</span>
            </span>
            {r.en_uso > 0 && <Chip>{r.en_uso === 1 ? '1 persona' : `${r.en_uso} personas`}</Chip>}
            {r.protegido ? (
              <Chip tono="azul">del sistema</Chip>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-sec !py-1 !px-2 !min-h-[32px] !text-xs shrink-0"
                  onClick={() => (editando === r.clave ? cerrar() : abrirRol(r))}
                >
                  {editando === r.clave ? 'Cerrar' : 'Editar'}
                </button>
                {!r.en_uso && (
                  <button
                    type="button"
                    className="btn !py-1 !px-2 !min-h-[32px] !text-xs bg-red-100 text-red-800 shrink-0"
                    onClick={() => eliminar(r)}
                  >
                    Eliminar
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {editando && (
        <form onSubmit={guardar} className="rounded-xl bg-slate-50 p-3 space-y-3">
          <h4 className="font-bold text-sm">
            {editando === 'nuevo' ? 'Nuevo cargo' : `Editar “${borrador.nombre}”`}
          </h4>
          <Campo etiqueta="Nombre del cargo">
            <input
              className="campo"
              value={borrador.nombre}
              onChange={(e) => setBorrador({ ...borrador, nombre: e.target.value })}
              placeholder="Gerente de Recursos Humanos"
              minLength={3}
              maxLength={60}
              required
            />
          </Campo>

          <div>
            <p className="etiqueta">Formularios que trae</p>
            <div className="space-y-1">
              {disponibles.map((m) => (
                <label key={m} className="flex items-center gap-3 min-h-[40px]">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={borrador.modulos_permitidos.includes(m)}
                    onChange={() => alternar('modulos_permitidos', m)}
                  />
                  <span className="text-sm">
                    {MODULOS[m] ? `${MODULOS[m].icono} ${MODULOS[m].etiqueta}` : m}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {[['ver', 'Lo que puede VER'], ['hacer', 'Lo que puede HACER']].map(([grupo, titulo]) => (
            <div key={grupo}>
              <p className="etiqueta">{titulo}</p>
              <div className="space-y-1">
                {permisosDisp.filter((x) => x.grupo === grupo).map((x) => (
                  <label key={x.clave} className="flex items-start gap-3 py-1">
                    <input
                      type="checkbox"
                      className="h-5 w-5 mt-0.5 shrink-0"
                      checked={borrador.permisos_especiales.includes(x.clave)}
                      onChange={() => alternar('permisos_especiales', x.clave)}
                    />
                    <span className="min-w-0 text-sm">{x.etiqueta}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}

          <p className="text-xs text-slate-500">
            Conceder permisos sigue siendo sólo tuyo: ningún cargo puede repartir
            accesos ni tocar una cuenta de Master.
          </p>
          <button className="btn-primario w-full" disabled={guardando}>
            {guardando ? 'Guardando…' : (editando === 'nuevo' ? 'Crear cargo' : 'Guardar cambios')}
          </button>
        </form>
      )}
    </div>
  );
}

function VistaAccesos({ usuario, call, aviso }) {
  const puedeGestionar = puede(usuario, 'gestionar_empleados');
  const [usuarios, setUsuarios] = useState(null);
  const [roles, setRoles] = useState([]);
  const [disponibles, setDisponibles] = useState(Object.keys(MODULOS));
  const [verEliminados, setVerEliminados] = useState(false);
  const [selId, setSelId] = useState('');
  const [datos, setDatos] = useState({ usuario: '', nombre: '', apellido: '', rol: 'motorizados' });
  const [marcados, setMarcados] = useState([]);
  const [permisosDisp, setPermisosDisp] = useState([]);
  const [puedeConceder, setPuedeConceder] = useState(false);
  const [especiales, setEspeciales] = useState([]);
  const [guardando, setGuardando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [nuevo, setNuevo] = useState({ usuario: '', nombre: '', apellido: '', rol: 'motorizados', pin: '' });

  const cargar = useCallback(async () => {
    try {
      const data = await call(`/api/usuarios${qs({ eliminados: verEliminados ? 'true' : '' })}`);
      setUsuarios(data.usuarios);
      setRoles(data.roles || []);
      setDisponibles(data.modulos_disponibles);
      setPermisosDisp(data.permisos_disponibles || []);
      setPuedeConceder(Boolean(data.puede_conceder));
    } catch (err) {
      aviso(err.message, 'error');
      setUsuarios([]);
    }
  }, [call, aviso, verEliminados]);
  useEffect(() => { cargar(); }, [cargar]);

  const sel = (usuarios || []).find((u) => String(u.id) === String(selId));

  /* Los cargos vienen de la base. El Master los crea en el panel de abajo. */
  const opcionesRol = roles.length
    ? roles.filter((r) => r.activo !== false)
      .map((r) => [r.clave, r.es_master ? `${r.nombre} (acceso total)` : r.nombre])
    : [['motorizados', 'Motorizado'], ['tienda', 'Tienda'], ['admin', 'Master']];

  /*
   * Lo que la persona HEREDA de su cargo. Se muestra marcado y bloqueado:
   * para cambiarlo hay que editar el rol, no la ficha de la persona. Lo
   * que se marca aquí es lo EXTRA que tiene ella y nadie más.
   */
  const heredadosMod = sel && !sel.es_master && Array.isArray(sel.rol_modulos) ? sel.rol_modulos : [];
  const heredadosEsp = sel && !sel.es_master && Array.isArray(sel.rol_permisos) ? sel.rol_permisos : [];

  const seleccionar = (id) => {
    setSelId(id);
    const u = (usuarios || []).find((x) => String(x.id) === String(id));
    if (u) {
      setDatos({ usuario: u.usuario, nombre: u.nombre, apellido: u.apellido || '', rol: u.rol });
      setMarcados([...u.modulos_permitidos]);
      setEspeciales([...(u.permisos_especiales || [])]);
    }
  };

  const alternar = (m) => setMarcados((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));
  const alternarEspecial = (c) =>
    setEspeciales((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  const accion = async (fn, mensaje) => {
    setGuardando(true);
    try {
      await fn();
      aviso(mensaje, 'ok');
      await cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  const guardarDatos = () => accion(
    () => call(`/api/usuarios/${selId}`, { method: 'PUT', body: datos }),
    'Datos actualizados',
  );

  const guardarPermisos = () => accion(
    () => call(`/api/usuarios/${selId}/permisos`, { method: 'PUT', body: { modulos_permitidos: marcados } }),
    'Permisos actualizados. El empleado los verá al recargar.',
  );

  const guardarEspeciales = () => accion(
    () => call(`/api/usuarios/${selId}/especiales`, { method: 'PUT', body: { permisos_especiales: especiales } }),
    'Funciones especiales actualizadas. El empleado las verá al recargar.',
  );

  const cambiarEstado = (estado) => {
    const textos = {
      activo: '¿Reactivar el acceso de esta persona?',
      pausado: '¿Pausar el acceso? No podrá entrar hasta que lo reactives, pero conserva todo su historial.',
      eliminado: '¿Quitarle el acceso de forma permanente? Su historial de gestión se conserva intacto, solo deja de poder entrar.',
    };
    if (!window.confirm(textos[estado])) return undefined;
    return accion(
      () => call(`/api/usuarios/${selId}/estado`, { method: 'PUT', body: { estado } }),
      'Estado actualizado',
    );
  };

  const reiniciarPin = async () => {
    const pin = window.prompt('Nuevo PIN (4 a 8 dígitos):');
    if (!pin) return;
    try {
      await call(`/api/usuarios/${selId}/pin`, { method: 'PUT', body: { pin } });
      aviso('PIN actualizado', 'ok');
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    }
  };

  const crear = async (e) => {
    e.preventDefault();
    setGuardando(true);
    try {
      await call('/api/usuarios', { method: 'POST', body: { ...nuevo, modulos_permitidos: [] } });
      aviso('Empleado creado. Ahora asígnale sus módulos.', 'ok');
      setNuevo({ usuario: '', nombre: '', apellido: '', rol: 'motorizados', pin: '' });
      setCreando(false);
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  if (usuarios === null) return <Cargando />;
  const esYo = sel && sel.id === usuario.id;

  return (
    <div className="space-y-4">
      <Titulo derecha={puedeGestionar && (
        <button className="btn-sec !py-2 !min-h-[40px]" onClick={() => setCreando((v) => !v)}>
          {creando ? 'Cerrar' : '+ Empleado'}
        </button>
      )}>
        Accesos
      </Titulo>

      {creando && puedeGestionar && (
        <form onSubmit={crear} className="card space-y-3">
          <h3 className="font-bold">Nuevo empleado</h3>
          <Campo etiqueta="Usuario para entrar (sin espacios)">
            <input
              className="campo"
              value={nuevo.usuario}
              onChange={(e) => setNuevo({ ...nuevo, usuario: e.target.value.replace(/\s/g, '') })}
              minLength={3}
              maxLength={40}
              autoCapitalize="none"
              required
            />
          </Campo>
          <div className="grid grid-cols-2 gap-2">
            <Campo etiqueta="Nombre">
              <input className="campo" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} minLength={2} required />
            </Campo>
            <Campo etiqueta="Apellido">
              <input className="campo" value={nuevo.apellido} onChange={(e) => setNuevo({ ...nuevo, apellido: e.target.value })} />
            </Campo>
          </div>
          <Campo etiqueta="Rol">
            <Select
              valor={nuevo.rol}
              onChange={(v) => setNuevo({ ...nuevo, rol: v })}
              opciones={opcionesRol}
            />
          </Campo>
          <Campo etiqueta="PIN inicial (4 a 8 dígitos)">
            <input
              className="campo"
              inputMode="numeric"
              pattern="\d{4,8}"
              maxLength={8}
              value={nuevo.pin}
              onChange={(e) => setNuevo({ ...nuevo, pin: e.target.value.replace(/\D/g, '') })}
              required
            />
          </Campo>
          <button className="btn-primario w-full" disabled={guardando}>Crear empleado</button>
        </form>
      )}

      <div className="card space-y-3">
        <Campo etiqueta="Empleado">
          <Select
            valor={selId}
            onChange={seleccionar}
            opciones={usuarios.map((u) => [
              String(u.id),
              `${u.nombre_completo || u.nombre} (${nombreRol(u)})${u.estado === 'activo' ? '' : ` — ${ESTADO_USUARIO_ETIQUETA[u.estado]}`}`,
            ])}
            vacio="Seleccione…"
          />
        </Campo>
        <label className="flex items-center gap-3 min-h-[44px] text-sm">
          <input type="checkbox" className="h-5 w-5" checked={verEliminados} onChange={(e) => setVerEliminados(e.target.checked)} />
          <span>Mostrar también las cuentas sin acceso permanente</span>
        </label>
      </div>

      {sel && (
        <>
          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold">Datos de la cuenta</h3>
              <Chip tono={TONO_ESTADO_USUARIO[sel.estado]}>{ESTADO_USUARIO_ETIQUETA[sel.estado]}</Chip>
            </div>
            {sel.bloqueado && <Chip tono="rojo">Bloqueada por intentos fallidos</Chip>}
            <Campo etiqueta="Usuario para entrar (sin espacios)">
              <input
                className="campo"
                value={datos.usuario}
                onChange={(e) => setDatos({ ...datos, usuario: e.target.value.replace(/\s/g, '') })}
                minLength={3}
                maxLength={40}
                autoCapitalize="none"
              />
            </Campo>
            <div className="grid grid-cols-2 gap-2">
              <Campo etiqueta="Nombre">
                <input className="campo" value={datos.nombre} onChange={(e) => setDatos({ ...datos, nombre: e.target.value })} minLength={2} />
              </Campo>
              <Campo etiqueta="Apellido">
                <input className="campo" value={datos.apellido} onChange={(e) => setDatos({ ...datos, apellido: e.target.value })} />
              </Campo>
            </div>
            <Campo etiqueta="Rol">
              <Select
                valor={datos.rol}
                onChange={(v) => setDatos({ ...datos, rol: v })}
                opciones={opcionesRol}
                disabled={esYo}
              />
            </Campo>
            {esYo && <p className="text-xs text-slate-500">No puedes cambiarte el rol ni quitarte el acceso a ti mismo.</p>}
            {puedeGestionar ? (
              <button className="btn-primario w-full" disabled={guardando} onClick={guardarDatos}>
                {guardando ? 'Guardando…' : 'Guardar datos'}
              </button>
            ) : (
              <p className="text-xs text-slate-500">Sólo de lectura: no tienes la función “Gestionar empleados”.</p>
            )}
          </div>

          <div className="card space-y-3">
            <div>
              <h3 className="font-bold">Formularios que puede ver y llenar</h3>
              {heredadosMod.length > 0 && (
                <p className="text-xs text-slate-500">
                  Los marcados como <b>del cargo</b> los hereda de {nombreRol(sel)} y se cambian
                  editando ese cargo. Aquí marcas lo extra que tiene sólo esta persona.
                </p>
              )}
            </div>
            <div className="space-y-1">
              {disponibles.map((m) => {
                const delRol = heredadosMod.includes(m);
                return (
                  <label key={m} className="flex items-center gap-3 min-h-[44px] border-b border-slate-100">
                    <input
                      type="checkbox"
                      className="h-6 w-6"
                      checked={delRol || marcados.includes(m)}
                      disabled={!puedeConceder || delRol}
                      onChange={() => alternar(m)}
                    />
                    <span className="min-w-0 flex-1">
                      {MODULOS[m] ? `${MODULOS[m].icono} ${MODULOS[m].etiqueta}` : m}
                    </span>
                    {delRol && <Chip tono="azul">del cargo</Chip>}
                  </label>
                );
              })}
            </div>
            {sel.es_master && (
              <p className="text-xs text-slate-500">
                El Master siempre tiene acceso completo; esto solo decide qué ve en su menú.
              </p>
            )}
            {puedeConceder && (
              <button className="btn-primario w-full" disabled={guardando} onClick={guardarPermisos}>
                {guardando ? 'Guardando…' : 'Guardar permisos'}
              </button>
            )}
          </div>

          {sel.es_master ? (
            <div className="card">
              <h3 className="font-bold mb-1">Funciones especiales</h3>
              <p className="text-sm text-slate-500">
                El Master tiene todas las funciones siempre. No hace falta concederlas.
              </p>
            </div>
          ) : (
            <div className="card space-y-4">
              <div>
                <h3 className="font-bold">Funciones especiales</h3>
                <p className="text-xs text-slate-500">
                  Cosas que normalmente sólo hace el Master. Puedes concederlas una por una.
                  {heredadosEsp.length > 0
                    && ` Las marcadas como “del cargo” vienen de ${nombreRol(sel)}.`}
                </p>
              </div>

              {[['ver', 'Lo que puede VER'], ['hacer', 'Lo que puede HACER']].map(([grupo, titulo]) => (
                <div key={grupo}>
                  <p className="etiqueta">{titulo}</p>
                  <div className="space-y-1">
                    {permisosDisp.filter((x) => x.grupo === grupo).map((x) => {
                      const delRol = heredadosEsp.includes(x.clave);
                      return (
                        <label key={x.clave} className="flex items-start gap-3 py-2 border-b border-slate-100">
                          <input
                            type="checkbox"
                            className="h-6 w-6 mt-0.5 shrink-0"
                            checked={delRol || especiales.includes(x.clave)}
                            disabled={!puedeConceder || delRol}
                            onChange={() => alternarEspecial(x.clave)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium">{x.etiqueta}</span>
                            {delRol && <> <Chip tono="azul">del cargo</Chip></>}
                            <span className="block text-xs text-slate-500">{x.detalle}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}

              {puedeConceder ? (
                <button className="btn-primario w-full" disabled={guardando} onClick={guardarEspeciales}>
                  {guardando ? 'Guardando…' : 'Guardar funciones especiales'}
                </button>
              ) : (
                <p className="text-xs text-slate-500">
                  Sólo el Master puede conceder o quitar funciones especiales.
                </p>
              )}
            </div>
          )}

          <div className={`card space-y-3 ${puedeGestionar ? '' : 'hidden'}`}>
            <h3 className="font-bold">Acceso al sistema</h3>
            <div className="grid grid-cols-3 gap-2">
              {['activo', 'pausado', 'eliminado'].map((e) => (
                <button
                  key={e}
                  disabled={guardando || esYo || sel.estado === e}
                  onClick={() => cambiarEstado(e)}
                  className={`btn !px-2 !text-sm ${
                    sel.estado === e
                      ? 'bg-agua-700 text-white'
                      : e === 'eliminado' ? 'bg-red-100 text-red-800' : 'bg-slate-200 text-slate-800'
                  }`}
                >
                  {ESTADO_USUARIO_ETIQUETA[e]}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              Pausar quita el acceso temporalmente. Quitar acceso lo hace de forma permanente.
              En los dos casos el historial de su gestión se conserva intacto.
            </p>
            <button className="btn-sec w-full" onClick={reiniciarPin}>Cambiar su PIN</button>
          </div>
        </>
      )}

      {puedeConceder && (
        <PanelRoles
          roles={roles}
          disponibles={disponibles}
          permisosDisp={permisosDisp}
          call={call}
          aviso={aviso}
          recargar={cargar}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Master: Ajustes                                                     */
/*                                                                     */
/* Valores que antes estaban escritos en el código y cambiarlos exigía  */
/* un despliegue. Ahora los cambia el Master desde aquí.               */
/* ------------------------------------------------------------------ */
const DIAS_AJUSTES = [
  [1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'],
  [5, 'Viernes'], [6, 'Sábado'], [7, 'Domingo'],
];

function VistaAjustes({ call, aviso }) {
  const [dias, setDias] = useState(null);
  const [kmAceite, setKmAceite] = useState('');
  const [anticipacion, setAnticipacion] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [cerrarDia, setCerrarDia] = useState({ fecha: hoyCaracas(), motivo: '' });
  const [corregir, setCorregir] = useState({ fecha: hoyCaracas(), hora: '' });

  const cargar = useCallback(async () => {
    try {
      const d = await call('/api/ajustes');
      setDias(Array.isArray(d.ajustes.dias_apertura) ? d.ajustes.dias_apertura : []);
      setKmAceite(String(d.ajustes.km_aceite));
      setAnticipacion(String(d.ajustes.km_aviso_anticipacion));
    } catch (err) {
      aviso(err.message, 'error');
      setDias([]);
    }
  }, [call, aviso]);
  useEffect(() => { cargar(); }, [cargar]);

  const alternarDia = (n) => setDias((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].sort()));

  const guardar = async () => {
    if (!dias || dias.length === 0) return aviso('Debe quedar al menos un día de apertura', 'error');
    setGuardando(true);
    try {
      await call('/api/ajustes', {
        method: 'PUT',
        body: {
          dias_apertura: dias,
          km_aceite: Number(kmAceite),
          km_aviso_anticipacion: Number(anticipacion),
        },
      });
      aviso('Ajustes guardados', 'ok');
      await cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setGuardando(false);
    }
  };

  const marcarCerrado = async () => {
    if (!cerrarDia.motivo.trim()) return aviso('Indique por qué no se abrió ese día', 'error');
    try {
      await call('/api/tienda/cerrada', {
        method: 'PUT',
        body: { fecha: cerrarDia.fecha, motivo_cierre: cerrarDia.motivo.trim() },
      });
      aviso('Día marcado como cerrado', 'ok');
      setCerrarDia({ fecha: hoyCaracas(), motivo: '' });
    } catch (err) {
      aviso(err.message, 'error');
    }
  };

  const corregirHora = async () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(corregir.hora)) {
      return aviso('La hora debe ir como HH:MM, por ejemplo 08:15', 'error');
    }
    try {
      await call('/api/tienda/hora', {
        method: 'PUT',
        body: { fecha: corregir.fecha, hora: corregir.hora },
      });
      aviso('Hora de apertura corregida', 'ok');
      setCorregir({ fecha: hoyCaracas(), hora: '' });
    } catch (err) {
      aviso(err.message, 'error');
    }
  };

  if (dias === null) return <Cargando />;

  return (
    <div className="space-y-4">
      <Titulo>Ajustes</Titulo>

      <div className="card space-y-3">
        <div>
          <h3 className="font-bold">Días que se espera abrir</h3>
          <p className="text-xs text-slate-500">
            Los días que no marques no piden apertura, no exigen cierre de caja y no
            entran a los promedios de finanzas.
          </p>
        </div>
        <div className="space-y-1">
          {DIAS_AJUSTES.map(([n, etiqueta]) => (
            <label key={n} className="flex items-center gap-3 min-h-[44px] border-b border-slate-100">
              <input type="checkbox" className="h-6 w-6" checked={dias.includes(n)} onChange={() => alternarDia(n)} />
              <span>{etiqueta}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="card space-y-3">
        <div>
          <h3 className="font-bold">Cambio de aceite</h3>
          <p className="text-xs text-slate-500">
            Cada cuántos kilómetros toca, y con cuánta anticipación quieres que el
            cartel se ponga amarillo.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Cada cuántos km">
            <NumInput value={kmAceite} onChange={setKmAceite} step="100" required />
          </Campo>
          <Campo etiqueta="Avisar con (km)">
            <NumInput value={anticipacion} onChange={setAnticipacion} step="50" required />
          </Campo>
        </div>
      </div>

      <button className="btn-primario w-full" disabled={guardando} onClick={guardar}>
        {guardando ? 'Guardando…' : 'Guardar ajustes'}
      </button>

      <div className="card space-y-3">
        <div>
          <h3 className="font-bold">Marcar un día como cerrado</h3>
          <p className="text-xs text-slate-500">
            Para un feriado o un día de inventario. Ese día no entra a los promedios
            y queda distinguido de un olvido.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Fecha">
            <input
              type="date"
              className="campo"
              value={cerrarDia.fecha}
              max={hoyCaracas()}
              onChange={(e) => setCerrarDia({ ...cerrarDia, fecha: e.target.value })}
            />
          </Campo>
          <Campo etiqueta="Motivo">
            <input
              className="campo"
              maxLength={300}
              placeholder="Feriado"
              value={cerrarDia.motivo}
              onChange={(e) => setCerrarDia({ ...cerrarDia, motivo: e.target.value })}
            />
          </Campo>
        </div>
        <button type="button" className="btn-sec w-full" onClick={marcarCerrado}>
          Marcar como cerrado
        </button>
      </div>

      <div className="card space-y-3">
        <div>
          <h3 className="font-bold">Corregir una hora de apertura</h3>
          <p className="text-xs text-slate-500">
            Si abrieron a las ocho y nadie marcó hasta las dos. Queda anotado que la
            corregiste tú, y la hora original se conserva.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Fecha">
            <input
              type="date"
              className="campo"
              value={corregir.fecha}
              max={hoyCaracas()}
              onChange={(e) => setCorregir({ ...corregir, fecha: e.target.value })}
            />
          </Campo>
          <Campo etiqueta="Hora real (HH:MM)">
            <input
              className="campo"
              inputMode="numeric"
              placeholder="08:15"
              maxLength={5}
              value={corregir.hora}
              onChange={(e) => setCorregir({ ...corregir, hora: e.target.value })}
            />
          </Campo>
        </div>
        <button type="button" className="btn-sec w-full" onClick={corregirHora}>
          Corregir la hora
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mi cuenta                                                           */
/* ------------------------------------------------------------------ */
function VistaPerfil({ usuario, call, aviso }) {
  const [actual, setActual] = useState('');
  const [nuevo, setNuevo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/auth/pin', { method: 'PUT', body: { pin_actual: actual, pin_nuevo: nuevo } });
      aviso('PIN actualizado', 'ok');
      setActual(''); setNuevo('');
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="space-y-4">
      <Titulo>Mi cuenta</Titulo>
      <div className="card">
        <p className="font-bold text-lg">{usuario.nombre_completo || usuario.nombre}</p>
        <p className="text-slate-500">{nombreRol(usuario)}</p>
        <p className="text-sm text-slate-400 mt-1">Usuario de ingreso: <b>{usuario.usuario}</b></p>
      </div>
      <form onSubmit={enviar} className="card space-y-3">
        <h3 className="font-bold">Cambiar PIN</h3>
        <Campo etiqueta="PIN actual">
          <input className="campo" type="password" inputMode="numeric" maxLength={8} value={actual} onChange={(e) => setActual(e.target.value.replace(/\D/g, ''))} required />
        </Campo>
        <Campo etiqueta="PIN nuevo (4 a 8 dígitos)">
          <input className="campo" type="password" inputMode="numeric" maxLength={8} value={nuevo} onChange={(e) => setNuevo(e.target.value.replace(/\D/g, ''))} required />
        </Campo>
        <button className="btn-primario w-full" disabled={enviando || actual.length < 4 || nuevo.length < 4}>Actualizar PIN</button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Aplicación                                                          */
/* ------------------------------------------------------------------ */
export default function PurissimaApp() {
  const [sesion, setSesion] = useState(leerSesion);
  const [vista, setVista] = useState(null);
  const [toast, setToast] = useState(null);

  const aviso = useCallback((mensaje, tipo = 'ok') => setToast({ mensaje, tipo, id: Date.now() }), []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const cerrarSesion = useCallback(() => {
    sessionStorage.removeItem(KEY_USER);
    sessionStorage.removeItem(KEY_TOKEN);
    setSesion(null);
    setVista(null);
  }, []);

  const iniciarSesion = (usuario, token) => {
    sessionStorage.setItem(KEY_USER, JSON.stringify(usuario));
    sessionStorage.setItem(KEY_TOKEN, token);
    setSesion({ usuario, token });
    setVista(null);
  };

  const token = sesion && sesion.token;
  const call = useCallback(
    async (ruta, opciones = {}) => {
      try {
        return await apiFetch(ruta, { ...opciones, token });
      } catch (err) {
        if (err.status === 401 && token) {
          aviso('Su sesión venció. Ingrese nuevamente.', 'error');
          cerrarSesion();
        }
        throw err;
      }
    },
    [token, cerrarSesion, aviso],
  );

  /*
   * Las fotos no pasan por apiFetch: viajan como imagen cruda y no como
   * JSON, para no cargar con el 33 % que agregaría codificarlas en texto.
   * Reciben el blob ya comprimido por comprimirFoto.
   */
  const subirFoto = useCallback(async (destino, blob) => {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), 60000); // subir tarda más que una consulta
    try {
      const res = await fetch(`${API_BASE}/api/fotos/${destino}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
        body: blob,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) { aviso('Su sesión venció. Ingrese nuevamente.', 'error'); cerrarSesion(); }
        throw new Error(data.error || `Error ${res.status}`);
      }
      return data.ruta;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('La foto tardó demasiado en subir. Revise su señal e intente de nuevo.');
      if (err instanceof TypeError) throw new Error('Sin conexión con el servidor.');
      throw err;
    } finally {
      clearTimeout(reloj);
    }
  }, [token, cerrarSesion, aviso]);

  /* Pide el enlace temporal para ver una foto ya guardada */
  const verFoto = useCallback(
    async (ruta) => (await call(`/api/fotos/firma${qs({ ruta })}`)).url,
    [call],
  );

  // Relee los permisos al abrir o recargar: el Master pudo haberlos cambiado
  useEffect(() => {
    if (!token) return undefined;
    let activo = true;
    apiFetch('/api/auth/me', { token })
      .then((d) => {
        if (!activo) return;
        sessionStorage.setItem(KEY_USER, JSON.stringify(d.usuario));
        setSesion((s) => (s ? { ...s, usuario: d.usuario } : s));
      })
      .catch((err) => { if (err.status === 401) cerrarSesion(); });
    return () => { activo = false; };
  }, [token, cerrarSesion]);

  // Menú dinámico: se construye leyendo modulos_permitidos (JSONB) del usuario
  const menu = useMemo(() => {
    if (!sesion) return [];
    const u = sesion.usuario;
    const permitidos = Array.isArray(u.modulos_permitidos) ? u.modulos_permitidos : [];
    const items = Object.keys(MODULOS)
      .filter((m) => permitidos.includes(m))
      .map((m) => ({ clave: m, ...MODULOS[m] }));
    Object.entries(VISTAS_MASTER).forEach(([clave, v]) => {
      if (puede(u, v.permiso)) items.push({ clave, ...v });
    });
    // Los ajustes no se conceden por función: son del Master y de nadie más
    if (u.es_master) items.push({ clave: 'ajustes', etiqueta: 'Ajustes', icono: '⚙️' });
    return items;
  }, [sesion]);

  useEffect(() => {
    if (!sesion) return;
    if (vista !== 'perfil' && !menu.some((m) => m.clave === vista)) {
      setVista(menu.length ? menu[0].clave : 'perfil');
    }
  }, [menu, vista, sesion]);

  if (!sesion) {
    return (
      <>
        <Login onLogin={iniciarSesion} />
        <Toast toast={toast} />
      </>
    );
  }

  const { usuario } = sesion;
  const props = { usuario, call, aviso, subirFoto, verFoto };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-agua-700 text-white shadow">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-2xl">💧</span>
            <div className="leading-tight min-w-0">
              <p className="font-extrabold truncate">{usuario.nombre_completo || usuario.nombre}</p>
              <p className="text-xs text-agua-100 truncate">{nombreRol(usuario)}</p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button className="rounded-lg px-3 py-2 text-sm bg-agua-800 min-h-[40px]" onClick={() => setVista('perfil')} aria-label="Mi cuenta">👤</button>
            <button className="rounded-lg px-3 py-2 text-sm bg-agua-800 min-h-[40px]" onClick={cerrarSesion}>Salir</button>
          </div>
        </div>
        <nav className="flex gap-2 overflow-x-auto px-3 pb-2" aria-label="Módulos">
          {menu.length === 0 && <span className="text-sm text-agua-100 py-2">Sin módulos asignados. Contacte al Master.</span>}
          {menu.map((m) => (
            <button
              key={m.clave}
              onClick={() => setVista(m.clave)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold min-h-[40px] ${vista === m.clave ? 'bg-white text-agua-800' : 'bg-agua-600 text-white'}`}
            >
              <span aria-hidden="true">{m.icono}</span> {m.etiqueta}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-4 pb-24">
        <BarraTienda call={call} aviso={aviso} />
        {vista === 'motos' && <VistaMotos {...props} />}
        {vista === 'caja' && <VistaCaja {...props} />}
        {vista === 'recepcion' && <VistaRecepcion {...props} />}
        {vista === 'solicitudes_negocio' && <VistaSolicitudesNegocio {...props} />}
        {vista === 'solicitudes_productos' && <VistaSolicitudesProductos {...props} />}
        {vista === 'incidencias' && <VistaIncidencias {...props} />}
        {vista === 'reportes' && puede(usuario, 'ver_reportes') && <VistaReportes {...props} />}
        {vista === 'repmotos' && puede(usuario, 'ver_reporte_motos') && <VistaReporteMotos {...props} />}
        {vista === 'finanzas' && puede(usuario, 'ver_finanzas') && <VistaFinanzas {...props} />}
        {vista === 'accesos' && puede(usuario, 'ver_accesos') && <VistaAccesos {...props} />}
        {vista === 'ajustes' && usuario.es_master && <VistaAjustes {...props} />}
        {vista === 'perfil' && <VistaPerfil {...props} />}
      </main>
      <Toast toast={toast} />
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      className={`fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md rounded-xl px-4 py-3 text-white shadow-lg ${toast.tipo === 'error' ? 'bg-red-600' : 'bg-emerald-600'}`}
    >
      {toast.mensaje}
    </div>
  );
}
