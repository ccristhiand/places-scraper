const db = require('../db');
const { parsePermisos } = require('./auth');

function io() { return global.io; }

// Evento en tiempo real para todos los usuarios conectados
function emitir(evento, data) {
  if (io()) io().to('auth').emit(evento, data);
}

// Notificación persistente (campana) para usuarios concretos
async function notificar(usuarioIds, { tipo = 'info', titulo, cuerpo = null, enlace = null }) {
  const ids = [...new Set((usuarioIds || []).filter(Boolean))];
  for (const uid of ids) {
    try {
      const [r] = await db.query(
        'INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, enlace) VALUES (?,?,?,?,?)',
        [uid, tipo, String(titulo).slice(0, 200), cuerpo ? String(cuerpo).slice(0, 500) : null, enlace]
      );
      if (io()) io().to(`u:${uid}`).emit('notificacion', { id: r.insertId, tipo, titulo, cuerpo, enlace });
    } catch (e) { console.error('Notificación:', e.message); }
  }
}

// Notifica a todos los usuarios activos que tengan un permiso
async function notificarPermiso(permiso, datos) {
  const [rows] = await db.query(
    'SELECT u.id, r.permisos FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.activo = 1'
  );
  const ids = rows.filter(r => parsePermisos(r.permisos).has(permiso)).map(r => r.id);
  await notificar(ids, datos);
}

module.exports = { emitir, notificar, notificarPermiso };
