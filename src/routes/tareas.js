const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requirePerm } = require('../lib/auth');
const { asegurarAcceso } = require('../lib/filtros');
const { notificar } = require('../lib/notificar');
const { ah, HttpError, texto } = require('../lib/utils');

const PRIORIDADES = ['baja', 'media', 'alta'];

router.get('/', requirePerm('tareas.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  const verTodo = req.user.can('contactos.ver_todos');
  const asignado = req.query.asignado || (verTodo ? '' : 'yo');
  if (asignado === 'yo' || !verTodo) { w.push('t.asignado_a = ?'); v.push(req.user.id); }
  else if (asignado && asignado !== 'todos') { w.push('t.asignado_a = ?'); v.push(parseInt(asignado, 10) || 0); }

  if (req.query.negocio_id) { w.push('t.negocio_id = ?'); v.push(parseInt(req.query.negocio_id, 10)); }
  const estado = req.query.estado || 'pendiente';
  if (estado !== 'todas') { w.push('t.estado = ?'); v.push(estado); }
  switch (req.query.rango) {
    case 'vencidas': w.push('t.vence_at < NOW()'); break;
    case 'hoy':      w.push('DATE(t.vence_at) = CURDATE()'); break;
    case 'semana':   w.push('t.vence_at < CURDATE() + INTERVAL 7 DAY'); break;
    case 'sin_fecha':w.push('t.vence_at IS NULL'); break;
  }
  const [rows] = await db.query(`
    SELECT t.*, n.nombre AS negocio_nombre, u.nombre AS asignado_nombre, c.nombre AS creado_por_nombre
    FROM tareas t
    LEFT JOIN negocios n ON n.id = t.negocio_id
    LEFT JOIN usuarios u ON u.id = t.asignado_a
    LEFT JOIN usuarios c ON c.id = t.creado_por
    WHERE ${w.join(' AND ')}
    ORDER BY t.estado = 'completada', t.vence_at IS NULL, t.vence_at ASC, FIELD(t.prioridad,'alta','media','baja')
    LIMIT 500`, v);
  res.json({ ok: true, rows });
}));

async function leer(req, previo = {}) {
  const t = {
    titulo:      req.body.titulo !== undefined ? texto(req.body.titulo, 255) : previo.titulo,
    descripcion: req.body.descripcion !== undefined ? texto(req.body.descripcion, 5000) : previo.descripcion,
    vence_at:    req.body.vence_at !== undefined ? (req.body.vence_at || null) : previo.vence_at,
    prioridad:   PRIORIDADES.includes(req.body.prioridad) ? req.body.prioridad : (previo.prioridad || 'media'),
    negocio_id:  req.body.negocio_id !== undefined ? (parseInt(req.body.negocio_id, 10) || null) : previo.negocio_id,
    asignado_a:  req.body.asignado_a !== undefined ? (parseInt(req.body.asignado_a, 10) || null) : (previo.asignado_a ?? req.user.id),
  };
  if (!t.titulo) throw new HttpError(400, 'La tarea necesita un título.');
  if (t.negocio_id) await asegurarAcceso(req, t.negocio_id);
  if (t.asignado_a !== req.user.id && t.asignado_a !== previo.asignado_a && !req.user.can('contactos.asignar'))
    throw new HttpError(403, 'No puedes asignar tareas a otros usuarios.');
  return t;
}

router.post('/', requirePerm('tareas.gestionar'), ah(async (req, res) => {
  const t = await leer(req);
  t.creado_por = req.user.id;
  const [r] = await db.query('INSERT INTO tareas SET ?', [t]);
  if (t.asignado_a && t.asignado_a !== req.user.id)
    await notificar([t.asignado_a], { tipo: 'tarea', titulo: `Nueva tarea: ${t.titulo}`, cuerpo: `Asignada por ${req.user.nombre}`, enlace: '#/tareas' });
  res.json({ ok: true, id: r.insertId });
}));

async function cargar(req, id) {
  const [[t]] = await db.query('SELECT * FROM tareas WHERE id = ?', [id]);
  if (!t) throw new HttpError(404, 'Tarea no encontrada');
  if (!req.user.can('contactos.ver_todos') && t.asignado_a !== req.user.id && t.creado_por !== req.user.id)
    throw new HttpError(403, 'No tienes acceso a esta tarea.');
  return t;
}

router.put('/:id', requirePerm('tareas.gestionar'), ah(async (req, res) => {
  const previo = await cargar(req, req.params.id);
  const t = await leer(req, previo);
  if (t.vence_at !== previo.vence_at) t.notificada = 0;
  await db.query('UPDATE tareas SET ? WHERE id = ?', [t, previo.id]);
  res.json({ ok: true });
}));

router.post('/:id/estado', requirePerm('tareas.gestionar'), ah(async (req, res) => {
  const t = await cargar(req, req.params.id);
  const completada = req.body.estado === 'completada';
  await db.query('UPDATE tareas SET estado = ?, completada_at = ? WHERE id = ?',
    [completada ? 'completada' : 'pendiente', completada ? new Date() : null, t.id]);
  if (completada && t.negocio_id) {
    await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?)',
      [t.negocio_id, 'tarea', `Tarea completada: ${t.titulo}`, req.user.nombre, req.user.id]);
  }
  res.json({ ok: true });
}));

router.delete('/:id', requirePerm('tareas.gestionar'), ah(async (req, res) => {
  const t = await cargar(req, req.params.id);
  await db.query('DELETE FROM tareas WHERE id = ?', [t.id]);
  res.json({ ok: true });
}));

module.exports = router;
