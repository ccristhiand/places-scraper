const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { audit } = require('../lib/audit');
const { ah, HttpError, texto } = require('../lib/utils');
const { PERMISOS, TODOS, requirePerm } = require('../lib/auth');

router.get('/', requirePerm('roles.gestionar', 'usuarios.gestionar'), ah(async (req, res) => {
  const [rows] = await db.query(`
    SELECT r.*, (SELECT COUNT(*) FROM usuarios u WHERE u.rol_id = r.id) AS usuarios
    FROM roles r ORDER BY r.es_sistema DESC, r.nombre`);
  for (const r of rows) { try { r.permisos = JSON.parse(r.permisos); } catch { r.permisos = []; } }
  res.json({ ok: true, rows, catalogo: PERMISOS });
}));

router.use(requirePerm('roles.gestionar'));

function leerRol(body) {
  const nombre = texto(body.nombre, 80);
  if (!nombre) throw new HttpError(400, 'El nombre del rol es obligatorio.');
  const permisos = [...new Set((body.permisos || []).filter(p => TODOS.includes(p)))];
  if (!permisos.length) throw new HttpError(400, 'Selecciona al menos un permiso.');
  return { nombre, descripcion: texto(body.descripcion, 255), permisos };
}

router.post('/', ah(async (req, res) => {
  const r = leerRol(req.body);
  try {
    const [x] = await db.query('INSERT INTO roles (nombre, descripcion, permisos) VALUES (?,?,?)',
      [r.nombre, r.descripcion, JSON.stringify(r.permisos)]);
    await audit(req, 'rol_creado', { entidad: 'rol', entidadId: x.insertId, detalle: r });
    res.json({ ok: true, id: x.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'Ya existe un rol con ese nombre.');
    throw e;
  }
}));

router.put('/:id', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [[rol]] = await db.query('SELECT * FROM roles WHERE id = ?', [id]);
  if (!rol) throw new HttpError(404, 'Rol no encontrado');
  if (rol.es_sistema) throw new HttpError(400, 'El rol Administrador no se puede modificar.');
  const r = leerRol(req.body);
  try {
    await db.query('UPDATE roles SET nombre=?, descripcion=?, permisos=? WHERE id=?',
      [r.nombre, r.descripcion, JSON.stringify(r.permisos), id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'Ya existe un rol con ese nombre.');
    throw e;
  }
  await audit(req, 'rol_editado', { entidad: 'rol', entidadId: id, detalle: r });
  res.json({ ok: true });
}));

router.delete('/:id', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [[rol]] = await db.query('SELECT es_sistema, (SELECT COUNT(*) FROM usuarios WHERE rol_id = roles.id) AS n FROM roles WHERE id = ?', [id]);
  if (!rol) throw new HttpError(404, 'Rol no encontrado');
  if (rol.es_sistema) throw new HttpError(400, 'El rol Administrador no se puede eliminar.');
  if (rol.n) throw new HttpError(400, `Hay ${rol.n} usuario(s) con este rol. Cámbialos de rol antes de eliminarlo.`);
  await db.query('DELETE FROM roles WHERE id = ?', [id]);
  await audit(req, 'rol_eliminado', { entidad: 'rol', entidadId: id });
  res.json({ ok: true });
}));

module.exports = router;
