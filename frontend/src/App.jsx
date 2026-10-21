import React, { useState, useEffect, useCallback } from 'react';
import AdminUsuarios from './AdminUsuarios'; // AÑADIDO: gestión de usuarios

const API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) ||
  (typeof process !== 'undefined' && process.env && process.env.REACT_APP_API_URL) ||
  'http://localhost:4000';

const INITIAL_CAJA_STATE = {
  pago_movil_bs: '', efectivo_bs: '', punto_venta_bs: '', tasa_dolar: '', dolares_vendidos: '', impuestos_fiscales_bs: '', costos_operativos_bs: '', incidencia_caja: ''
};

const INITIAL_CHECKLIST_STATE = {
  se_uso_hoy: true, kilometraje_inicial: '', cambio_aceite_realizado: false, detalles_items: { frenos: 'ok', luces: 'ok', cauchos: 'ok', motor: 'ok' }, observacion_falla: '', foto_falla_url: ''
};

export default function PurissimaApp() {
  const [usuario, setUsuario] = useState(() => {
    try { const s = sessionStorage.getItem('purissima_user'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [token, setToken] = useState(() => sessionStorage.getItem('purissima_token') || '');

  const [pinInput, setPinInput] = useState('');
  const [vista, setVista] = useState('motos');
  const [motos, setMotos] = useState([]);
  const [motoSeleccionada, setMotoSeleccionada] = useState(null);

  const [cargando, setCargando] = useState(false);
  const [mensajeAlerta, setMensajeAlerta] = useState({ tipo: '', texto: '' });

  const [cajaData, setCajaData] = useState(INITIAL_CAJA_STATE);
  const [checklistData, setChecklistData] = useState(INITIAL_CHECKLIST_STATE);

  const mostrarNotificacion = (tipo, texto) => {
    setMensajeAlerta({ tipo, texto });
    setTimeout(() => setMensajeAlerta({ tipo: '', texto: '' }), 5000);
  };

  const cerrarSesion = useCallback(() => {
    sessionStorage.removeItem('purissima_user');
    sessionStorage.removeItem('purissima_token');
    setUsuario(null); setToken(''); setPinInput(''); setMotoSeleccionada(null); setMotos([]);
  }, []);

  const apiFetch = useCallback(async (endpoint, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    };

    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(12000) // Timeout de 12s para redes móviles inestables
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && usuario) {
      cerrarSesion();
      throw new Error('Su sesión ha expirado.');
    }
    if (!res.ok) throw new Error(data.error || 'Error en la petición.');
    return data;
  }, [token, usuario, cerrarSesion]);

  const cargarMotos = useCallback(async () => {
    if (!usuario || !['motorizados', 'admin'].includes(usuario.rol)) return;
    try {
      const data = await apiFetch('/api/motos');
      if (Array.isArray(data)) setMotos(data);
    } catch (err) {
      mostrarNotificacion('error', err.message);
    }
  }, [usuario, apiFetch]);

  useEffect(() => { cargarMotos(); }, [cargarMotos]);

  const handleLogin = async (e) => {
    if (e) e.preventDefault();
    if (!/^\d{4}$/.test(pinInput)) return mostrarNotificacion('error', 'El PIN debe ser de 4 dígitos.');

    setCargando(true);
    try {
      const data = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: pinInput }) });
      if (data.success && data.usuario) {
        setUsuario(data.usuario);
        if (data.token) { setToken(data.token); sessionStorage.setItem('purissima_token', data.token); }
        sessionStorage.setItem('purissima_user', JSON.stringify(data.usuario));
        setPinInput('');
        setVista(data.usuario.rol === 'motorizados' ? 'motos' : 'tienda');
      }
    } catch (err) {
      mostrarNotificacion('error', err.message);
    } finally { setCargando(false); }
  };

  const handleGuardarChecklist = async (e) => {
    e.preventDefault();
    if (!motoSeleccionada) return;

    if (Object.values(checklistData.detalles_items).includes('x') && !checklistData.observacion_falla.trim()) {
      return mostrarNotificacion('error', 'Debe detallar la falla marcada.');
    }

    setCargando(true);
    try {
      await apiFetch('/api/motos/checklist', {
        method: 'POST',
        body: JSON.stringify({ moto_id: motoSeleccionada.id, ...checklistData, kilometraje_inicial: checklistData.se_uso_hoy ? Number(checklistData.kilometraje_inicial) : null })
      });
      mostrarNotificacion('exito', 'Checklist guardado con éxito.');
      setMotoSeleccionada(null);
      cargarMotos();
    } catch (err) {
      mostrarNotificacion('error', err.message);
    } finally { setCargando(false); }
  };

  const handleCierreCaja = async (e) => {
    e.preventDefault();
    setCargando(true);
    try {
      const data = await apiFetch('/api/caja/cierre', { method: 'POST', body: JSON.stringify(cajaData) });
      if (data.success) {
        mostrarNotificacion('exito', `Cierre exitoso! Bs. ${data.total_cierre_bs} | $${data.total_ingreso_dolar}`);
        setCajaData(INITIAL_CAJA_STATE);
      }
    } catch (err) {
      mostrarNotificacion('error', err.message);
    } finally { setCargando(false); }
  };

  const totalBsPreview = (Number(cajaData.pago_movil_bs) || 0) + (Number(cajaData.efectivo_bs) || 0) + (Number(cajaData.punto_venta_bs) || 0);
  const totalUsdPreview = Number(cajaData.tasa_dolar) > 0 ? totalBsPreview / Number(cajaData.tasa_dolar) : 0;

  if (!usuario) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-sky-900 text-white p-4">
        <form onSubmit={handleLogin} className="flex flex-col items-center w-full max-w-xs">
          <h1 className="text-3xl font-bold mb-2">Purissima Cloud</h1>
          <p className="text-sky-200 mb-6">PIN de empleado (4 dígitos)</p>
          {mensajeAlerta.texto && <div className="bg-red-600 text-sm p-3 rounded mb-4 text-center w-full">{mensajeAlerta.texto}</div>}
          <input
            type="password" inputMode="numeric" maxLength={4} value={pinInput}
            onChange={e => setPinInput(e.target.value.replace(/\D/g, ''))}
            className="text-center text-3xl tracking-widest text-black p-3 rounded-lg w-48 mb-4 font-bold outline-none"
            placeholder="••••" autoFocus required
          />
          <button type="submit" disabled={cargando || pinInput.length !== 4} className="w-full bg-sky-500 hover:bg-sky-400 text-white font-bold py-3 rounded-lg">
            {cargando ? 'Verificando...' : 'Entrar'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <header className="max-w-4xl mx-auto bg-white shadow p-4 rounded-xl flex justify-between items-center mb-6">
        <div>
          <h2 className="font-bold text-lg text-sky-900">Purissima - Cloud</h2>
          <p className="text-sm text-gray-500">Usuario: {usuario.nombre} ({usuario.rol})</p>
        </div>
        {usuario.rol === 'admin' && (
          <div className="flex bg-gray-100 p-1 rounded-lg">
            <button onClick={() => setVista('motos')} className={`px-3 py-1 rounded text-sm ${vista === 'motos' ? 'bg-sky-600 text-white' : 'text-gray-600'}`}>Motos</button>
            <button onClick={() => setVista('tienda')} className={`px-3 py-1 rounded text-sm ${vista === 'tienda' ? 'bg-sky-600 text-white' : 'text-gray-600'}`}>Caja</button>
            <button onClick={() => setVista('usuarios')} className={`px-3 py-1 rounded text-sm ${vista === 'usuarios' ? 'bg-sky-600 text-white' : 'text-gray-600'}`}>Usuarios</button>
          </div>
        )}
        <button onClick={cerrarSesion} className="bg-red-500 text-white px-4 py-2 rounded-lg text-sm">Cerrar Sesión</button>
      </header>

      {mensajeAlerta.texto && (
        <div className={`max-w-xl mx-auto mb-6 p-4 rounded-xl text-white font-medium flex justify-between ${mensajeAlerta.tipo === 'error' ? 'bg-red-600' : 'bg-emerald-600'}`}>
          <span>{mensajeAlerta.texto}</span>
          <button onClick={() => setMensajeAlerta({ tipo: '', texto: '' })}>✕</button>
        </div>
      )}

      {(usuario.rol === 'motorizados' || (usuario.rol === 'admin' && vista === 'motos')) && (
        <div className="max-w-md mx-auto bg-white p-6 rounded-xl shadow">
          <h3 className="text-xl font-bold text-sky-900 mb-4">Flota de Motos</h3>
          <div className="space-y-3">
            {motos.map(moto => (
              <div key={moto.id} className="border p-4 rounded-lg flex justify-between items-center">
                <div>
                  <p className="font-bold">{moto.nombre}</p>
                  <p className="text-xs text-gray-500">Placa: {moto.placa} | Km: {moto.ultimo_kilometraje}</p>
                </div>
                <button onClick={() => { setMotoSeleccionada(moto); setChecklistData({ ...INITIAL_CHECKLIST_STATE, kilometraje_inicial: moto.ultimo_kilometraje }); }} className="bg-sky-600 text-white px-3 py-2 rounded text-sm">Revisar</button>
              </div>
            ))}
          </div>

          {motoSeleccionada && (
            <form onSubmit={handleGuardarChecklist} className="mt-6 border-t pt-6 space-y-4">
              <h4 className="font-bold text-sky-900">Checklist: {motoSeleccionada.nombre}</h4>
              <label className="flex items-center space-x-2 text-sm">
                <input type="checkbox" checked={checklistData.se_uso_hoy} onChange={e => setChecklistData({ ...checklistData, se_uso_hoy: e.target.checked })} />
                <span>¿Se usará hoy?</span>
              </label>
              {checklistData.se_uso_hoy && (
                <>
                  <input type="number" min={motoSeleccionada.ultimo_kilometraje} value={checklistData.kilometraje_inicial} onChange={e => setChecklistData({ ...checklistData, kilometraje_inicial: e.target.value })} className="w-full border p-2 rounded" placeholder="Kilometraje inicial" required />
                  <label className="flex items-center space-x-2 text-sm text-emerald-700">
                    <input type="checkbox" checked={checklistData.cambio_aceite_realizado} onChange={e => setChecklistData({ ...checklistData, cambio_aceite_realizado: e.target.checked })} />
                    <span>¿Cambio de aceite hoy?</span>
                  </label>
                  <textarea value={checklistData.observacion_falla} onChange={e => setChecklistData({ ...checklistData, observacion_falla: e.target.value })} className="w-full border p-2 rounded text-sm" placeholder="Observación si hay falla..." />
                </>
              )}
              <button type="submit" disabled={cargando} className="w-full bg-sky-600 text-white py-2 rounded font-bold">Guardar Checklist</button>
            </form>
          )}
        </div>
      )}

      {(usuario.rol === 'tienda' || (usuario.rol === 'admin' && vista === 'tienda')) && (
        <div className="max-w-xl mx-auto bg-white p-6 rounded-xl shadow">
          <h3 className="text-xl font-bold text-sky-900 mb-4">Cierre de Caja Diario</h3>
          <form onSubmit={handleCierreCaja} className="space-y-4">
            <input type="number" min="0" step="0.01" value={cajaData.pago_movil_bs} onChange={e => setCajaData({ ...cajaData, pago_movil_bs: e.target.value })} className="w-full border p-2 rounded" placeholder="Pago Móvil (Bs)" required />
            <input type="number" min="0" step="0.01" value={cajaData.efectivo_bs} onChange={e => setCajaData({ ...cajaData, efectivo_bs: e.target.value })} className="w-full border p-2 rounded" placeholder="Efectivo (Bs)" required />
            <input type="number" min="0" step="0.01" value={cajaData.punto_venta_bs} onChange={e => setCajaData({ ...cajaData, punto_venta_bs: e.target.value })} className="w-full border p-2 rounded" placeholder="Punto de Venta (Bs)" required />
            <div className="grid grid-cols-2 gap-4">
              <input type="number" min="0.0001" step="0.0001" value={cajaData.tasa_dolar} onChange={e => setCajaData({ ...cajaData, tasa_dolar: e.target.value })} className="w-full border p-2 rounded" placeholder="Tasa Dólar" required />
              <input type="number" min="0" step="0.01" value={cajaData.dolares_vendidos} onChange={e => setCajaData({ ...cajaData, dolares_vendidos: e.target.value })} className="w-full border p-2 rounded" placeholder="Divisas USD" required />
            </div>
            <div className="bg-sky-50 p-3 rounded flex justify-between text-sm">
              <span>Total Bs: <b>{totalBsPreview.toFixed(2)}</b></span>
              <span className="text-emerald-700">Equivalente: <b>${totalUsdPreview.toFixed(2)} USD</b></span>
            </div>
            <textarea value={cajaData.incidencia_caja} onChange={e => setCajaData({ ...cajaData, incidencia_caja: e.target.value })} className="w-full border p-2 rounded" placeholder="Incidencias con caja (opcional)..." />
            <button type="submit" disabled={cargando} className="w-full bg-emerald-600 text-white py-3 rounded font-bold">
              {cargando ? 'Procesando...' : 'Guardar Cierre de Caja'}
            </button>
          </form>
        </div>
      )}

      {usuario.rol === 'admin' && vista === 'usuarios' && (
        <AdminUsuarios apiFetch={apiFetch} mostrarNotificacion={mostrarNotificacion} usuarioActualId={usuario.id} />
      )}
    </div>
  );
}