const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { audit } = require('../lib/audit');
const { ah, HttpError, texto } = require('../lib/utils');
const A = require('../lib/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lista mínima para selects de asignación (cualquier usuario autenticado)
router.get('/opciones', ah(async (req, res) => {
  const [rows] = await db.query('SELECT id, nombre FROM usuarios WHERE activo = 1 ORDER BY nombre');
  res.json({ ok: true, rows });
}));

router.use(A.requirePerm('usuarios.gestionar'));

router.get('/', ah(async (req, res) => {
  const [rows] = await db.query(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.activo, u.rol_id, r.nombre AS rol, u.ultimo_acceso,
           u.debe_cambiar_password, u.created_at, (u.bloqueado_hasta > NOW()) AS bloqueado,
           (SELECT COUNT(*) FROM negocios n WHERE n.asignado_a = u.id) AS contactos
    FROM usuarios u JOIN roles r ON r.id = u.rol_id ORDER BY u.activo DESC, u.nombre`);
  res.json({ ok: true, rows });
}));

async function adminsActivos(excluirId) {
  const [[r]] = await db.query(`
    SELECT COUNT(*) AS n FROM usuarios u JOIN roles r ON r.id = u.rol_id
    WHERE u.activo = 1 AND r.permisos LIKE '%"*"%' AND u.id <> ?`, [excluirId || 0]);
  return r.n;
}

async function validarRol(rolId) {
  const [[r]] = await db.query('SELECT id FROM roles WHERE id = ?', [rolId]);
  if (!r) throw new HttpError(400, 'Rol inválido.');
}

router.post('/', ah(async (req, res) => {
  const nombre = texto(req.body.nombre, 150);
  const email  = String(req.body.email || '').trim().toLowerCase();
  const rolId  = parseInt(req.body.rol_id, 10);
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Correo inválido.');
  await validarRol(rolId);

  let pass = req.body.password ? String(req.body.password) : null;
  const generada = !pass;
  if (generada) pass = A.passwordTemporal();
  else await A.validarPassword(pass, { email });

  try {
    const [r] = await db.query(
      'INSERT INTO usuarios (nombre, email, telefono, password_hash, rol_id, debe_cambiar_password) VALUES (?,?,?,?,?,1)',
      [nombre, email, texto(req.body.telefono, 30), await A.hashPassword(pass), rolId]);
    await audit(req, 'usuario_creado', { entidad: 'usuario', entidadId: r.insertId, detalle: { email, rolId } });
    res.json({ ok: true, id: r.insertId, password_temporal: generada ? pass : undefined });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'Ya existe un usuario con ese correo.');
    throw e;
  }
}));

router.put('/:id', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [[u]] = await db.query('SELECT * FROM usuarios WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');

  const nombre = texto(req.body.nombre, 150) || u.nombre;
  const email  = req.body.email ? String(req.body.email).trim().toLowerCase() : u.email;
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Correo inválido.');
  const rolId  = req.body.rol_id ? parseInt(req.body.rol_id, 10) : u.rol_id;
  await validarRol(rolId);
  const activo = req.body.activo === undefined ? u.activo : (req.body.activo ? 1 : 0);

  if (id === req.user.id && (!activo || rolId !== u.rol_id))
    throw new HttpError(400, 'No puedes desactivarte ni cambiar tu propio rol.');
  const [[rolNuevo]] = await db.query('SELECT permisos FROM roles WHERE id = ?', [rolId]);
  if ((!activo || !String(rolNuevo.permisos).includes('"*"')) && (await adminsActivos(id)) === 0)
    throw new HttpError(400, 'Debe quedar al menos un administrador activo.');

  // Cambio de rol, correo o desactivación → cerrar sesiones abiertas
  const invalidar = rolId !== u.rol_id || !activo || email !== u.email;
  try {
    await db.query(
      `UPDATE usuarios SET nombre=?, email=?, telefono=?, rol_id=?, activo=?, token_version = token_version + ? WHERE id=?`,
      [nombre, email, texto(req.body.telefono, 30) ?? u.telefono, rolId, activo, invalidar ? 1 : 0, id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'Ya existe un usuario con ese correo.');
    throw e;
  }
  await audit(req, 'usuario_editado', { entidad: 'usuario', entidadId: id, detalle: { email, rolId, activo } });
  res.json({ ok: true });
}));

router.post('/:id/reset-password', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pass = A.passwordTemporal();
  const [r] = await db.query(
    `UPDATE usuarios SET password_hash=?, debe_cambiar_password=1, token_version=token_version+1,
       intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=?`, [await A.hashPassword(pass), id]);
  if (!r.affectedRows) throw new HttpError(404, 'Usuario no encontrado');
  await audit(req, 'password_reseteada', { entidad: 'usuario', entidadId: id });
  res.json({ ok: true, password_temporal: pass });
}));

router.post('/:id/desbloquear', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('UPDATE usuarios SET intentos_fallidos=0, bloqueado_hasta=NULL WHERE id=?', [id]);
  await audit(req, 'usuario_desbloqueado', { entidad: 'usuario', entidadId: id });
  res.json({ ok: true });
}));

router.post('/:id/cerrar-sesiones', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('UPDATE usuarios SET token_version=token_version+1 WHERE id=?', [id]);
  await audit(req, 'sesiones_cerradas', { entidad: 'usuario', entidadId: id });
  res.json({ ok: true });
}));

router.delete('/:id', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario.');
  if ((await adminsActivos(id)) === 0) throw new HttpError(400, 'Debe quedar al menos un administrador activo.');
  const reasignar = req.body?.reasignar_a ? parseInt(req.body.reasignar_a, 10) : null;
  await db.query('UPDATE negocios SET asignado_a=? WHERE asignado_a=?', [reasignar, id]);
  await db.query('UPDATE tareas SET asignado_a=? WHERE asignado_a=?', [reasignar, id]);
  await db.query('UPDATE demos SET asignado_a=? WHERE asignado_a=?', [reasignar, id]);
  await db.query('DELETE FROM notificaciones WHERE usuario_id=?', [id]);
  const [r] = await db.query('DELETE FROM usuarios WHERE id=?', [id]);
  if (!r.affectedRows) throw new HttpError(404, 'Usuario no encontrado');
  await audit(req, 'usuario_eliminado', { entidad: 'usuario', entidadId: id, detalle: { reasignar } });
  res.json({ ok: true });
}));

module.exports = router;
