import { useCallback, useEffect, useMemo, useState } from 'react';

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

const MODULOS = {
  motos: { etiqueta: 'Motos', icono: '🏍️' },
  caja: { etiqueta: 'Caja', icono: '💵' },
  recepcion: { etiqueta: 'Recepción', icono: '📦' },
  solicitudes: { etiqueta: 'Solicitudes', icono: '📝' },
  incidencias: { etiqueta: 'Incidencias', icono: '⚠️' },
};
const VISTAS_MASTER = {
  reportes: { etiqueta: 'Reportes', icono: '📊' },
  repmotos: { etiqueta: 'Reporte de motos', icono: '🛠️' },
  finanzas: { etiqueta: 'Finanzas', icono: '💰' },
  accesos: { etiqueta: 'Accesos', icono: '🔐' },
};

const ROL_ETIQUETA = { admin: 'Master', motorizados: 'Motorizado', tienda: 'Tienda' };
const ESTADO_USUARIO_ETIQUETA = { activo: 'Activo', pausado: 'Pausado', eliminado: 'Sin acceso' };
const TONO_ESTADO_USUARIO = { activo: 'verde', pausado: 'ambar', eliminado: 'rojo' };

const TIPOS_SOLICITUD = [
  ['mercancia', 'Mercancía'], ['agua', 'Agua'], ['insumos_generales', 'Insumos generales'],
  ['mantenimiento', 'Mantenimiento'], ['permiso', 'Permiso'], ['otro', 'Otro'],
];
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

function Select({ valor, onChange, opciones, vacio, ...rest }) {
  return (
    <select className="campo" value={valor} onChange={(e) => onChange(e.target.value)} {...rest}>
      {vacio !== undefined && <option value="">{vacio}</option>}
      {opciones.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
function FormChecklist({ moto, call, aviso, onListo, onCancelar }) {
  const lista = CHECKLISTS[moto.tipo_modelo] || [];
  const [seUso, setSeUso] = useState(true);
  const [km, setKm] = useState(String(moto.ultimo_kilometraje));
  const [items, setItems] = useState(() => Object.fromEntries(lista.map((i) => [i, true])));
  const [cambioAceite, setCambioAceite] = useState(false);
  const [tieneFalla, setTieneFalla] = useState(false);
  const [obs, setObs] = useState('');
  const [enviando, setEnviando] = useState(false);

  const hayItemMalo = Object.values(items).some((v) => !v);
  const falla = tieneFalla || (seUso && hayItemMalo);

  const enviar = async (e) => {
    e.preventDefault();
    if (falla && !obs.trim()) return aviso('Describa la falla en la observación', 'error');
    setEnviando(true);
    try {
      await call(`/api/motos/${moto.id}/checklist`, {
        method: 'POST',
        body: {
          se_uso_hoy: seUso,
          kilometraje_inicial: seUso || km !== '' ? Number(km) : undefined,
          items: seUso ? items : {},
          cambio_aceite_realizado: cambioAceite,
          tiene_falla: falla,
          observacion_falla: falla ? obs.trim() : undefined,
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

      <label className="flex items-center gap-3 min-h-[44px]">
        <input type="checkbox" className="h-6 w-6" checked={seUso} onChange={(e) => setSeUso(e.target.checked)} />
        <span className="font-medium">La moto se usó hoy</span>
      </label>

      <Campo etiqueta={seUso ? 'Kilometraje inicial (obligatorio)' : 'Kilometraje (opcional)'}>
        <NumInput value={km} onChange={setKm} step="1" required={seUso} />
      </Campo>

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

      <label className="flex items-center gap-3 min-h-[44px]">
        <input type="checkbox" className="h-6 w-6" checked={cambioAceite} onChange={(e) => setCambioAceite(e.target.checked)} />
        <span className="font-medium">Se hizo cambio de aceite hoy</span>
      </label>

      <label className="flex items-center gap-3 min-h-[44px]">
        <input type="checkbox" className="h-6 w-6" checked={falla} disabled={seUso && hayItemMalo} onChange={(e) => setTieneFalla(e.target.checked)} />
        <span className="font-medium">Reportar falla</span>
      </label>
      {falla && (
        <Campo etiqueta="Observación de la falla (obligatoria)">
          <textarea className="campo" rows={3} maxLength={1000} value={obs} onChange={(e) => setObs(e.target.value)} required />
        </Campo>
      )}

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

function VistaMotos({ usuario, call, aviso }) {
  const [motos, setMotos] = useState(null);
  const [seleccion, setSeleccion] = useState(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const esAdmin = usuario.rol === 'admin';

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
                <Chip tono={m.km_desde_aceite >= 3000 ? 'rojo' : m.km_desde_aceite >= 2500 ? 'ambar' : 'verde'}>
                  Aceite: {nf0.format(m.km_desde_aceite)} km
                </Chip>
                {m.checklist_hoy ? <Chip tono="verde">Checklist hoy ✓</Chip> : <Chip tono="ambar">Pendiente hoy</Chip>}
              </div>
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
function VistaCaja({ call, aviso }) {
  const [hoy, setHoy] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [f, setF] = useState({
    pago_movil_bs: '', efectivo_bs: '', punto_venta_bs: '', tasa_dolar: '',
    dolares_vendidos: '', impuestos_fiscales_bs: '', costos_operativos_bs: '', observacion: '',
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
    () => (tasa > 0 ? redondear(redondear(totalBs / tasa) + redondear(f.dolares_vendidos)) : 0),
    [totalBs, tasa, f.dolares_vendidos],
  );
  const netoBs = useMemo(
    () => redondear(totalBs - redondear(f.impuestos_fiscales_bs) - redondear(f.costos_operativos_bs)),
    [totalBs, f.impuestos_fiscales_bs, f.costos_operativos_bs],
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
          dolares_vendidos: redondear(f.dolares_vendidos),
          total_ingreso_dolar: totalUsd,
          impuestos_fiscales_bs: redondear(f.impuestos_fiscales_bs),
          costos_operativos_bs: redondear(f.costos_operativos_bs),
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
          <p>Dólares vendidos: <b>{fmtUsd(c.dolares_vendidos)}</b></p>
          <p>Ingreso total: <b>{fmtUsd(c.total_ingreso_dolar)}</b></p>
          <p>Impuestos: <b>{fmtBs(c.impuestos_fiscales_bs)}</b></p>
          <p>Costos operativos: <b>{fmtBs(c.costos_operativos_bs)}</b></p>
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
          <Campo etiqueta="Dólares vendidos (USD)"><NumInput value={f.dolares_vendidos} onChange={set('dolares_vendidos')} placeholder="0.00" /></Campo>
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3">
            <p className="text-sm text-slate-600">Ingreso total en dólares (calculado)</p>
            <p className="text-xl font-extrabold text-emerald-800">{fmtUsd(totalUsd)}</p>
            <p className="text-xs text-slate-500">Total Bs ÷ tasa + dólares vendidos</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Campo etiqueta="Impuestos (Bs)"><NumInput value={f.impuestos_fiscales_bs} onChange={set('impuestos_fiscales_bs')} placeholder="0.00" /></Campo>
            <Campo etiqueta="Costos oper. (Bs)"><NumInput value={f.costos_operativos_bs} onChange={set('costos_operativos_bs')} placeholder="0.00" /></Campo>
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
              <div key={h.id} className="card !p-3 flex justify-between text-sm">
                <span className="font-semibold">{fmtFecha(h.fecha)}</span>
                <span>{fmtBs(h.total_cierre_bs)} · {fmtUsd(h.total_ingreso_dolar)}</span>
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
function VistaRecepcion({ usuario, call, aviso }) {
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

  const esAdmin = usuario.rol === 'admin';

  // "Proveedores y productos" es exclusivo del Master
  const pestanas = [['agua', 'Agua'], ['mercancia', 'Mercancía']];
  if (esAdmin) pestanas.push(['catalogo', 'Proveedores y productos']);
  const activa = tab === 'catalogo' && !esAdmin ? 'agua' : tab;

  if (!datos) return <Cargando />;
  const props = { call, aviso, datos, esAdmin, onListo: cargar };

  return (
    <div>
      <Titulo>Recepción</Titulo>
      <Pestanas opciones={pestanas} activa={activa} onChange={setTab} />
      {activa === 'agua' && <EntradaAgua {...props} />}
      {activa === 'mercancia' && <EntradaMercancia {...props} />}
      {activa === 'catalogo' && esAdmin && <Catalogo {...props} />}
    </div>
  );
}

/** Botón simple para quien no es Master: agregar un proveedor que falte en la lista. */
function AgregarProveedorRapido({ call, aviso, onListo }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({ nombre: '', tipo: 'ambos', telefono: '' });
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      await call('/api/proveedores', { method: 'POST', body: f });
      aviso('Proveedor agregado', 'ok');
      setF({ nombre: '', tipo: 'ambos', telefono: '' });
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

function EntradaAgua({ call, aviso, datos, onListo, esAdmin }) {
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

  if (datos.proveedores.length === 0 && esAdmin) return <SinProveedores />;

  return (
    <div className="space-y-4">
      <form onSubmit={enviar} className="card space-y-3">
        <Campo etiqueta="Litros recibidos"><NumInput value={litraje} onChange={setLitraje} required placeholder="0" /></Campo>
        <Campo etiqueta="Proveedor (obligatorio)">
          <Select
            valor={proveedor}
            onChange={setProveedor}
            opciones={datos.proveedores.map((p) => [String(p.id), p.nombre])}
            vacio="Seleccione…"
            required
          />
        </Campo>
        {!esAdmin && <AgregarProveedorRapido call={call} aviso={aviso} onListo={onListo} />}
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
        <div key={e.id} className="card !p-3 flex justify-between text-sm">
          <span className="truncate">{fmtFecha(e.fecha)} · {e.proveedor}{e.tiene_incidencia ? ' ⚠️' : ''}</span>
          <b className="shrink-0">{nf.format(e.litraje)} L</b>
        </div>
      ))}
    </div>
  );
}

function EntradaMercancia({ call, aviso, datos, onListo, esAdmin }) {
  const [proveedor, setProveedor] = useState('');
  const [obs, setObs] = useState('');
  const [filas, setFilas] = useState([{ producto_id: '', cantidad: '', costo_usd: '' }]);
  const [enviando, setEnviando] = useState(false);

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
            producto_id: Number(f.producto_id), cantidad: Number(f.cantidad), costo_usd: Number(f.costo_usd || 0),
          })),
        },
      });
      aviso('Mercancía recibida y stock actualizado', 'ok');
      setFilas([{ producto_id: '', cantidad: '', costo_usd: '' }]);
      setObs('');
      onListo();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  if (datos.proveedores.length === 0 && esAdmin) return <SinProveedores />;
  if (datos.productos.length === 0) {
    return (
      <div className="card text-center text-slate-500">
        {esAdmin
          ? 'Primero registre productos en la pestaña “Proveedores y productos”.'
          : 'Todavía no hay productos cargados. Pídele al Master que los registre.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={enviar} className="card space-y-3">
        <Campo etiqueta="Proveedor (obligatorio)">
          <Select
            valor={proveedor}
            onChange={setProveedor}
            opciones={datos.proveedores.map((p) => [String(p.id), p.nombre])}
            vacio="Seleccione…"
            required
          />
        </Campo>
        {!esAdmin && <AgregarProveedorRapido call={call} aviso={aviso} onListo={onListo} />}
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
            <div className="grid grid-cols-2 gap-2">
              <Campo etiqueta="Cantidad"><NumInput value={f.cantidad} onChange={(v) => setFila(i, 'cantidad', v)} required /></Campo>
              <Campo etiqueta="Costo USD (unit.)"><NumInput value={f.costo_usd} onChange={(v) => setFila(i, 'costo_usd', v)} /></Campo>
            </div>
            {filas.length > 1 && (
              <button type="button" className="text-sm text-red-600 font-semibold" onClick={() => setFilas((p) => p.filter((_, idx) => idx !== i))}>
                Quitar ítem
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn-sec w-full" onClick={() => setFilas((p) => [...p, { producto_id: '', cantidad: '', costo_usd: '' }])}>
          + Agregar ítem
        </button>
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
        </div>
      ))}
    </div>
  );
}

function Catalogo({ call, aviso, datos, onListo }) {
  const [prov, setProv] = useState({ nombre: '', tipo: 'ambos', contacto: '', rif: '', telefono: '' });
  const [prod, setProd] = useState({ nombre: '', categoria: 'mercancia', unidad: 'unidad', precio_usd: '', stock: '', proveedor_habitual_id: '' });
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
          guardar('/api/proveedores', prov, () => setProv({ nombre: '', tipo: 'ambos', contacto: '', rif: '', telefono: '' }));
        }}
      >
        <h3 className="font-bold">Nuevo proveedor</h3>
        <Campo etiqueta="Nombre"><input className="campo" value={prov.nombre} onChange={(e) => setProv({ ...prov, nombre: e.target.value })} required minLength={2} /></Campo>
        <Campo etiqueta="Tipo"><Select valor={prov.tipo} onChange={(v) => setProv({ ...prov, tipo: v })} opciones={TIPOS_PROVEEDOR} /></Campo>
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
            nombre: prod.nombre, categoria: prod.categoria, unidad: prod.unidad,
            precio_usd: Number(prod.precio_usd || 0), stock: Number(prod.stock || 0),
            proveedor_habitual_id: prod.proveedor_habitual_id ? Number(prod.proveedor_habitual_id) : undefined,
          }, () => setProd({ nombre: '', categoria: 'mercancia', unidad: 'unidad', precio_usd: '', stock: '', proveedor_habitual_id: '' }));
        }}
      >
        <h3 className="font-bold">Nuevo producto</h3>
        <Campo etiqueta="Nombre"><input className="campo" value={prod.nombre} onChange={(e) => setProd({ ...prod, nombre: e.target.value })} required minLength={2} /></Campo>
        <Campo etiqueta="Categoría"><Select valor={prod.categoria} onChange={(v) => setProd({ ...prod, categoria: v })} opciones={CATEGORIAS_PRODUCTO} /></Campo>
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Unidad"><input className="campo" value={prod.unidad} onChange={(e) => setProd({ ...prod, unidad: e.target.value })} /></Campo>
          <Campo etiqueta="Precio USD"><NumInput value={prod.precio_usd} onChange={(v) => setProd({ ...prod, precio_usd: v })} /></Campo>
          <Campo etiqueta="Stock inicial"><NumInput value={prod.stock} onChange={(v) => setProd({ ...prod, stock: v })} /></Campo>
          <Campo etiqueta="Proveedor habitual">
            <Select
              valor={prod.proveedor_habitual_id}
              onChange={(v) => setProd({ ...prod, proveedor_habitual_id: v })}
              opciones={datos.proveedores.map((p) => [String(p.id), p.nombre])}
              vacio="—"
            />
          </Campo>
        </div>
        <button className="btn-primario w-full" disabled={guardando}>Guardar producto</button>
      </form>

      <div>
        <h3 className="font-bold mb-2">Proveedores ({datos.proveedores.length})</h3>
        <p className="text-xs text-slate-500 mb-2">Toca un proveedor para modificar sus datos.</p>
        {datos.proveedores.length === 0 ? <Vacio texto="Sin proveedores" /> : datos.proveedores.map((p) => (
          <ProveedorEditable key={p.id} proveedor={p} call={call} aviso={aviso} onListo={onListo} />
        ))}
        <h3 className="font-bold mb-2 mt-4">Inventario ({datos.productos.length})</h3>
        {datos.productos.length === 0 ? <Vacio texto="Sin productos" /> : datos.productos.map((p) => (
          <div key={p.id} className="card !p-3 mb-2 flex justify-between text-sm">
            <span className="truncate">{p.nombre}{p.proveedor ? <span className="text-slate-400"> · {p.proveedor}</span> : null}</span>
            <b className="shrink-0">{nf.format(p.stock)} {p.unidad}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Proveedor de la lista; al tocarlo se abre para modificar todos sus datos. */
function ProveedorEditable({ proveedor, call, aviso, onListo }) {
  const [abierto, setAbierto] = useState(false);
  const [f, setF] = useState({
    nombre: proveedor.nombre,
    tipo: proveedor.tipo,
    contacto: proveedor.contacto || '',
    rif: proveedor.rif || '',
    telefono: proveedor.telefono || '',
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
        <Chip tono="azul">{etiquetaDe(TIPOS_PROVEEDOR, proveedor.tipo)}</Chip>
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
      <label className="flex items-center gap-3 min-h-[44px]">
        <input type="checkbox" className="h-6 w-6" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />
        <span className="font-medium">Proveedor activo</span>
      </label>
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

function VistaSolicitudes({ usuario, call, aviso }) {
  const [lista, setLista] = useState(null);
  const [f, setF] = useState({ tipo_solicitud: 'mercancia', titulo: '', descripcion: '' });
  const [enviando, setEnviando] = useState(false);
  const esAdmin = usuario.rol === 'admin';

  const cargar = useCallback(async () => {
    try {
      setLista((await call('/api/solicitudes')).solicitudes);
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
      await call('/api/solicitudes', { method: 'POST', body: f });
      aviso('Solicitud enviada', 'ok');
      setF({ tipo_solicitud: 'mercancia', titulo: '', descripcion: '' });
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    } finally {
      setEnviando(false);
    }
  };

  const cambiarEstado = async (s, estado) => {
    try {
      await call(`/api/solicitudes/${s.id}`, { method: 'PUT', body: { estado, notas_admin: s.notas_admin || '' } });
      aviso('Estado actualizado', 'ok');
      cargar();
    } catch (err) {
      aviso(err.message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Titulo>Solicitudes</Titulo>
      <form onSubmit={enviar} className="card space-y-3">
        <Campo etiqueta="Tipo">
          <Select valor={f.tipo_solicitud} onChange={(v) => setF({ ...f, tipo_solicitud: v })} opciones={TIPOS_SOLICITUD} />
        </Campo>
        <Campo etiqueta="Título">
          <input className="campo" value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} minLength={3} maxLength={120} required />
        </Campo>
        <Campo etiqueta="Descripción">
          <textarea className="campo" rows={3} maxLength={2000} value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} />
        </Campo>
        <button className="btn-primario w-full" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar solicitud'}</button>
      </form>
      {lista === null ? <Cargando /> : lista.length === 0 ? <Vacio texto="No hay solicitudes" /> : lista.map((s) => (
        <div key={s.id} className="card space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">{s.titulo || etiquetaDe(TIPOS_SOLICITUD, s.tipo_solicitud)}</p>
            <Chip tono={tonoEstado(s.estado)}>{etiquetaEstado(s.estado)}</Chip>
          </div>
          <p className="text-sm text-slate-500">
            {etiquetaDe(TIPOS_SOLICITUD, s.tipo_solicitud)} · {s.usuario} · {fmtFechaHora(s.fecha_hora)}
          </p>
          {s.descripcion && <p className="text-sm">{s.descripcion}</p>}
          {s.notas_admin && <p className="text-sm text-agua-800 bg-agua-50 rounded-lg p-2">Master: {s.notas_admin}</p>}
          {esAdmin && <SelectorEstado valor={s.estado} estados={ESTADOS_SOLICITUD} onCambiar={(e) => cambiarEstado(s, e)} />}
        </div>
      ))}
    </div>
  );
}

function VistaIncidencias({ usuario, call, aviso }) {
  const [lista, setLista] = useState(null);
  const [f, setF] = useState({ tipo: 'operativa_tienda', severidad: 'media', titulo: '', descripcion: '' });
  const [enviando, setEnviando] = useState(false);
  const esAdmin = usuario.rol === 'admin';

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
          {esAdmin && <SelectorEstado valor={i.estado} estados={ESTADOS_INCIDENCIA} onCambiar={(e) => cambiarEstado(i, e)} />}
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
function DetalleMoto({ detalle, onVolver }) {
  const { moto, checklists, incidencias, cambios_aceite: cambios } = detalle;
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

      <Pestanas
        opciones={[
          ['checklists', `Checklists (${checklists.length})`],
          ['aceite', `Aceite (${cambios.length})`],
          ['incidencias', `Incidencias (${incidencias.length})`],
        ]}
        activa={tab}
        onChange={setTab}
      />

      {tab === 'checklists' && (checklists.length === 0 ? <Vacio texto="Sin checklists registrados" /> : checklists.map((c) => {
        const items = c.detalles_items && typeof c.detalles_items === 'object' ? c.detalles_items : {};
        const fallas = Object.entries(items).filter(([, ok]) => ok === false).map(([k]) => k);
        return (
          <div key={c.id} className="card !p-3 mb-2 text-sm space-y-1">
            <div className="flex justify-between items-start gap-2">
              <span className="font-semibold">{fmtFecha(c.fecha_local)}</span>
              <div className="flex gap-1 shrink-0">
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
          </div>
        );
      }))}

      {tab === 'aceite' && (cambios.length === 0 ? <Vacio texto="Sin cambios de aceite registrados" /> : cambios.map((c, i) => (
        <div key={i} className="card !p-3 mb-2 flex justify-between text-sm">
          <span className="font-semibold">{fmtFechaHora(c.fecha)}</span>
          <span>{c.kilometraje !== null ? `${nf0.format(c.kilometraje)} km` : '—'} · {c.usuario}</span>
        </div>
      )))}

      {tab === 'incidencias' && (incidencias.length === 0 ? <Vacio texto="Sin incidencias" /> : incidencias.map((i) => (
        <div key={i.id} className="card !p-3 mb-2 text-sm space-y-1">
          <div className="flex justify-between items-start gap-2">
            <span className="font-semibold">{i.titulo}</span>
            <div className="flex gap-1 shrink-0">
              <Chip tono={tonoSeveridad(i.severidad)}>{i.severidad}</Chip>
              <Chip tono={tonoEstado(i.estado)}>{etiquetaEstado(i.estado)}</Chip>
            </div>
          </div>
          <p className="text-slate-500">{fmtFechaHora(i.fecha_hora)} · {i.usuario}</p>
          {i.descripcion && <p>{i.descripcion}</p>}
        </div>
      )))}
    </div>
  );
}

function VistaReporteMotos({ call, aviso }) {
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

  if (datos === null) return <Cargando />;
  if (detalle) return <DetalleMoto detalle={detalle} onVolver={() => setDetalle(null)} />;

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
            <span>Costos: {fmtBs(r.costos_bs)}</span>
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

function VistaFinanzas({ call, aviso }) {
  const [rango, setRango] = useState('mes');
  const [tab, setTab] = useState('diario');
  const [datos, setDatos] = useState(null);

  const cargar = useCallback(async () => {
    setDatos(null);
    try {
      const hoy = hoyCaracas();
      const params = { hasta: hoy };
      if (rango === '7') params.desde = sumarDias(hoy, -6);
      if (rango === 'mes') params.desde = `${hoy.slice(0, 7)}-01`;
      if (rango === '90') params.desde = sumarDias(hoy, -89);
      setDatos(await call(`/api/reportes/financieros${qs(params)}`));
    } catch (err) {
      aviso(err.message, 'error');
      setDatos({});
    }
  }, [call, aviso, rango]);
  useEffect(() => { cargar(); }, [cargar]);

  const t = datos && datos.totales;

  return (
    <div className="space-y-3">
      <Titulo>Finanzas</Titulo>
      <Pestanas
        opciones={[['7', 'Últimos 7 días'], ['mes', 'Este mes'], ['90', '90 días'], ['todo', 'Acumulado']]}
        activa={rango}
        onChange={setRango}
      />
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
            <Tarjeta titulo="Dólares vendidos" valor={fmtUsd(t.dolares_vendidos)} />
            <Tarjeta titulo="Impuestos fiscales" valor={fmtBs(t.impuestos_bs)} />
            <Tarjeta titulo="Costos operativos" valor={fmtBs(t.costos_bs)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Tarjeta titulo="Neto en Bs" valor={fmtBs(t.neto_bs)} nota="Total − impuestos − costos" />
            <Tarjeta titulo="Tasa promedio" valor={t.tasa_promedio ? fmtTasa(t.tasa_promedio) : '—'} nota="Promedio del periodo" />
          </div>
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
function VistaAccesos({ usuario, call, aviso }) {
  const [usuarios, setUsuarios] = useState(null);
  const [disponibles, setDisponibles] = useState(Object.keys(MODULOS));
  const [verEliminados, setVerEliminados] = useState(false);
  const [selId, setSelId] = useState('');
  const [datos, setDatos] = useState({ usuario: '', nombre: '', apellido: '', rol: 'motorizados' });
  const [marcados, setMarcados] = useState([]);
  const [guardando, setGuardando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [nuevo, setNuevo] = useState({ usuario: '', nombre: '', apellido: '', rol: 'motorizados', pin: '' });

  const cargar = useCallback(async () => {
    try {
      const data = await call(`/api/usuarios${qs({ eliminados: verEliminados ? 'true' : '' })}`);
      setUsuarios(data.usuarios);
      setDisponibles(data.modulos_disponibles);
    } catch (err) {
      aviso(err.message, 'error');
      setUsuarios([]);
    }
  }, [call, aviso, verEliminados]);
  useEffect(() => { cargar(); }, [cargar]);

  const sel = (usuarios || []).find((u) => String(u.id) === String(selId));

  const seleccionar = (id) => {
    setSelId(id);
    const u = (usuarios || []).find((x) => String(x.id) === String(id));
    if (u) {
      setDatos({ usuario: u.usuario, nombre: u.nombre, apellido: u.apellido || '', rol: u.rol });
      setMarcados([...u.modulos_permitidos]);
    }
  };

  const alternar = (m) => setMarcados((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));

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
      <Titulo derecha={
        <button className="btn-sec !py-2 !min-h-[40px]" onClick={() => setCreando((v) => !v)}>
          {creando ? 'Cerrar' : '+ Empleado'}
        </button>
      }>
        Accesos
      </Titulo>

      {creando && (
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
              opciones={[['motorizados', 'Motorizado'], ['tienda', 'Tienda'], ['admin', 'Master']]}
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
              `${u.nombre_completo || u.nombre} (${ROL_ETIQUETA[u.rol] || u.rol})${u.estado === 'activo' ? '' : ` — ${ESTADO_USUARIO_ETIQUETA[u.estado]}`}`,
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
                opciones={[['motorizados', 'Motorizado'], ['tienda', 'Tienda'], ['admin', 'Master']]}
                disabled={esYo}
              />
            </Campo>
            {esYo && <p className="text-xs text-slate-500">No puedes cambiarte el rol ni quitarte el acceso a ti mismo.</p>}
            <button className="btn-primario w-full" disabled={guardando} onClick={guardarDatos}>
              {guardando ? 'Guardando…' : 'Guardar datos'}
            </button>
          </div>

          <div className="card space-y-3">
            <h3 className="font-bold">Formularios que puede ver y llenar</h3>
            <div className="space-y-1">
              {disponibles.map((m) => (
                <label key={m} className="flex items-center gap-3 min-h-[44px] border-b border-slate-100">
                  <input type="checkbox" className="h-6 w-6" checked={marcados.includes(m)} onChange={() => alternar(m)} />
                  <span>{MODULOS[m] ? `${MODULOS[m].icono} ${MODULOS[m].etiqueta}` : m}</span>
                </label>
              ))}
            </div>
            {sel.rol === 'admin' && (
              <p className="text-xs text-slate-500">
                El Master siempre tiene acceso completo; esto solo decide qué ve en su menú.
              </p>
            )}
            <button className="btn-primario w-full" disabled={guardando} onClick={guardarPermisos}>
              {guardando ? 'Guardando…' : 'Guardar permisos'}
            </button>
          </div>

          <div className="card space-y-3">
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
        <p className="text-slate-500">{ROL_ETIQUETA[usuario.rol] || usuario.rol}</p>
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
    if (u.rol === 'admin') Object.entries(VISTAS_MASTER).forEach(([clave, v]) => items.push({ clave, ...v }));
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
  const props = { usuario, call, aviso };
  const esAdmin = usuario.rol === 'admin';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-agua-700 text-white shadow">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-2xl">💧</span>
            <div className="leading-tight min-w-0">
              <p className="font-extrabold truncate">{usuario.nombre_completo || usuario.nombre}</p>
              <p className="text-xs text-agua-100 truncate">{ROL_ETIQUETA[usuario.rol] || usuario.rol}</p>
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
        {vista === 'motos' && <VistaMotos {...props} />}
        {vista === 'caja' && <VistaCaja {...props} />}
        {vista === 'recepcion' && <VistaRecepcion {...props} />}
        {vista === 'solicitudes' && <VistaSolicitudes {...props} />}
        {vista === 'incidencias' && <VistaIncidencias {...props} />}
        {vista === 'reportes' && esAdmin && <VistaReportes {...props} />}
        {vista === 'repmotos' && esAdmin && <VistaReporteMotos {...props} />}
        {vista === 'finanzas' && esAdmin && <VistaFinanzas {...props} />}
        {vista === 'accesos' && esAdmin && <VistaAccesos {...props} />}
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
