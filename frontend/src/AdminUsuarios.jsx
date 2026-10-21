import React, { useState, useEffect, useCallback, useRef } from 'react';

// AÑADIDO: Panel para que el administrador (gerente general) cree usuarios,
// asigne sus PINs y los active o desactive.

const ROLES = [
  { valor: 'motorizados', etiqueta: 'Motorizados' },
  { valor: 'tienda', etiqueta: 'Tienda' },
  { valor: 'admin', etiqueta: 'Administrador' }
];

const NUEVO_USUARIO_INICIAL = { nombre: '', rol: 'tienda', pin: '' };

export default function AdminUsuarios({ apiFetch, mostrarNotificacion, usuarioActualId }) {
  const [usuarios, setUsuarios] = useState([]);
  const [nuevo, setNuevo] = useState(NUEVO_USUARIO_INICIAL);
  const [editandoPinId, setEditandoPinId] = useState(null);
  const [pinNuevo, setPinNuevo] = useState('');
  const [cargando, setCargando] = useState(false);

  // mostrarNotificacion cambia en cada render de App; se guarda en una ref
  // para que la carga de usuarios no se repita en bucle.
  const notificarRef = useRef(mostrarNotificacion);
  notificarRef.current = mostrarNotificacion;

  const cargarUsuarios = useCallback(async () => {
    try {
      const data = await apiFetch('/api/usuarios');
      if (Array.isArray(data)) setUsuarios(data);
    } catch (err) {
      notificarRef.current('error', err.message);
    }
  }, [apiFetch]);

  useEffect(() => { cargarUsuarios(); }, [cargarUsuarios]);

  const soloDigitos = (texto) => texto.replace(/\D/g, '').slice(0, 4);

  const handleCrear = async (e) => {
    e.preventDefault();
    if (!nuevo.nombre.trim()) return mostrarNotificacion('error', 'Escriba el nombre del usuario.');
    if (!/^\d{4}$/.test(nuevo.pin)) return mostrarNotificacion('error', 'El PIN debe ser de 4 dígitos.');

    setCargando(true);
    try {
      await apiFetch('/api/usuarios', { method: 'POST', body: JSON.stringify({ ...nuevo, nombre: nuevo.nombre.trim() }) });
      mostrarNotificacion('exito', `Usuario "${nuevo.nombre.trim()}" creado. Entréguele su PIN.`);
      setNuevo(NUEVO_USUARIO_INICIAL);
      cargarUsuarios();
    } catch (err) {
      mostrarNotificacion('error', err.message);
    } finally { setCargando(false); }
  };

  const handleCambiarPin = async (u) => {
    if (!/^\d{4}$/.test(pinNuevo)) return mostrarNotificacion('error', 'El PIN debe ser de 4 dígitos.');

    setCargando(true);
    try {
      await apiFetch(`/api/usuarios/${u.id}/pin`, { method: 'POST', body: JSON.stringify({ pin: pinNuevo }) });
      mostrarNotificacion('exito', `PIN de "${u.nombre}" actualizado.`);
      setEditandoPinId(null);
      setPinNuevo('');
    } catch (err) {
      mostrarNotificacion('error', err.message);
    } finally { setCargando(false); }
  };

  const handleCambiarEstado = async (u) => {
    setCargando(true);
    try {
      await apiFetch(`/api/usuarios/${u.id}/estado`, { method: 'POST', body: JSON.stringify({ activo: !u.activo }) });
      mostrarNotificacion('exito', `Usuario "${u.nombre}" ${u.activo ? 'desactivado' : 'activado'}.`);
      cargarUsuarios();
    } catch (err) {
      mostrarNotificacion('error', err.message);
    } finally { setCargando(false); }
  };

  const etiquetaRol = (valor) => (ROLES.find(r => r.valor === valor) || {}).etiqueta || valor;

  return (
    <div className="max-w-xl mx-auto bg-white p-6 rounded-xl shadow">
      <h3 className="text-xl font-bold text-sky-900 mb-4">Usuarios</h3>

      <form onSubmit={handleCrear} className="space-y-3 mb-6 bg-sky-50 p-4 rounded-lg">
        <p className="font-semibold text-sky-900 text-sm">Nuevo usuario</p>
        <input
          type="text" maxLength={100} value={nuevo.nombre}
          onChange={e => setNuevo({ ...nuevo, nombre: e.target.value })}
          className="w-full border p-2 rounded" placeholder="Nombre" required
        />
        <div className="grid grid-cols-2 gap-3">
          <select value={nuevo.rol} onChange={e => setNuevo({ ...nuevo, rol: e.target.value })} className="w-full border p-2 rounded bg-white">
            {ROLES.map(r => <option key={r.valor} value={r.valor}>{r.etiqueta}</option>)}
          </select>
          <input
            type="password" inputMode="numeric" maxLength={4} value={nuevo.pin}
            onChange={e => setNuevo({ ...nuevo, pin: soloDigitos(e.target.value) })}
            className="w-full border p-2 rounded text-center tracking-widest" placeholder="PIN (4 dígitos)" required
          />
        </div>
        <button type="submit" disabled={cargando} className="w-full bg-sky-600 text-white py-2 rounded font-bold">
          {cargando ? 'Guardando...' : 'Crear usuario'}
        </button>
      </form>

      <div className="space-y-3">
        {usuarios.map(u => (
          <div key={u.id} className={`border p-4 rounded-lg ${u.activo ? '' : 'opacity-60'}`}>
            <div className="flex justify-between items-center">
              <div>
                <p className="font-bold">{u.nombre}{u.id === usuarioActualId ? ' (usted)' : ''}</p>
                <p className="text-xs text-gray-500">{etiquetaRol(u.rol)} | {u.activo ? 'Activo' : 'Inactivo'}</p>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => { setEditandoPinId(editandoPinId === u.id ? null : u.id); setPinNuevo(''); }}
                  className="bg-sky-600 text-white px-3 py-2 rounded text-sm"
                >
                  Cambiar PIN
                </button>
                {u.id !== usuarioActualId && (
                  <button
                    onClick={() => handleCambiarEstado(u)} disabled={cargando}
                    className={`px-3 py-2 rounded text-sm text-white ${u.activo ? 'bg-red-500' : 'bg-emerald-600'}`}
                  >
                    {u.activo ? 'Desactivar' : 'Activar'}
                  </button>
                )}
              </div>
            </div>

            {editandoPinId === u.id && (
              <div className="mt-3 flex space-x-2">
                <input
                  type="password" inputMode="numeric" maxLength={4} value={pinNuevo}
                  onChange={e => setPinNuevo(soloDigitos(e.target.value))}
                  className="flex-1 border p-2 rounded text-center tracking-widest" placeholder="Nuevo PIN" autoFocus
                />
                <button onClick={() => handleCambiarPin(u)} disabled={cargando} className="bg-emerald-600 text-white px-4 py-2 rounded text-sm font-bold">
                  Guardar
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
