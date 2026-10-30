const db = require('../db');

// Registro de auditoría: nunca debe romper la operación principal
async function audit(req, accion, { entidad = null, entidadId = null, detalle = null } = {}) {
  try {
    await db.query(
      'INSERT INTO auditoria (usuario_id, usuario_email, accion, entidad, entidad_id, detalle, ip) VALUES (?,?,?,?,?,?,?)',
      [
        req?.user?.id || null,
        req?.user?.email || req?.auditEmail || null,
        accion,
        entidad,
        entidadId,
        detalle ? String(typeof detalle === 'string' ? detalle : JSON.stringify(detalle)).slice(0, 2000) : null,
        req?.ip || null,
      ]
    );
  } catch (e) {
    console.error('Auditoría:', e.message);
  }
}

module.exports = { audit };
