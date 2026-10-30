const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requirePerm } = require('../lib/auth');
const { asegurarAcceso } = require('../lib/filtros');
const { ah, HttpError, texto, entero } = require('../lib/utils');

const TIPOS   = ['virtual', 'presencial', 'telefonica'];
const ESTADOS = ['agendada', 'realizada', 'cancelada', 'reprogramada', 'no_asistio'];

router.get('/', requirePerm('agenda.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  if (!req.user.can('contactos.ver_todos')) { w.push('(n.asignado_a = ? OR d.asignado_a = ?)'); v.push(req.user.id, req.user.id); }
  if (req.query.estado)     { w.push('d.estado = ?');     v.push(req.query.estado); }
  if (req.query.negocio_id) { w.push('d.negocio_id = ?'); v.push(parseInt(req.query.negocio_id, 10)); }
  if (req.query.desde)      { w.push('d.fecha_hora >= ?'); v.push(req.query.desde); }
  if (req.query.hasta)      { w.push('d.fecha_hora < ?');  v.push(req.query.hasta); }
  if (req.query.asignado === 'yo') { w.push('d.asignado_a = ?'); v.push(req.user.id); }
  const [rows] = await db.query(`
    SELECT d.*, n.nombre, n.telefono, n.whatsapp, n.distrito, u.nombre AS asignado_nombre
    FROM demos d JOIN negocios n ON n.id = d.negocio_id LEFT JOIN usuarios u ON u.id = d.asignado_a
    WHERE ${w.join(' AND ')} ORDER BY d.fecha_hora ASC LIMIT 1000`, v);
  res.json({ ok: true, rows });
}));

function leer(body, previo = {}) {
  const d = {
    titulo:       body.titulo !== undefined ? texto(body.titulo, 300) : previo.titulo,
    fecha_hora:   body.fecha_hora || previo.fecha_hora,
    duracion_min: body.duracion_min !== undefined ? entero(body.duracion_min, 60, 5, 600) : (previo.duracion_min || 60),
    tipo:         TIPOS.includes(body.tipo) ? body.tipo : (previo.tipo || 'virtual'),
    enlace:       body.enlace !== undefined ? texto(body.enlace, 500) : previo.enlace,
    notas:        body.notas !== undefined ? texto(body.notas, 5000) : previo.notas,
    estado:       ESTADOS.includes(body.estado) ? body.estado : (previo.estado || 'agendada'),
    asignado_a:   body.asignado_a !== undefined ? (parseInt(body.asignado_a, 10) || null) : previo.asignado_a,
  };
  if (!d.fecha_hora || Number.isNaN(new Date(d.fecha_hora).getTime())) throw new HttpError(400, 'Fecha y hora inválidas.');
  if (d.enlace && !/^https?:\/\//i.test(d.enlace)) throw new HttpError(400, 'El enlace debe empezar con http:// o https://');
  return d;
}

router.post('/', requirePerm('agenda.gestionar'), ah(async (req, res) => {
  const negocioId = parseInt(req.body.negocio_id, 10);
  if (!negocioId) throw new HttpError(400, 'Selecciona un contacto.');
  await asegurarAcceso(req, negocioId);
  const d = leer(req.body);
  d.titulo = d.titulo || 'Reunión';
  d.asignado_a = d.asignado_a || req.user.id;
  d.negocio_id = negocioId;
  d.responsable = req.user.nombre;
  const [r] = await db.query('INSERT INTO demos SET ?', [d]);
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?)',
    [negocioId, 'reunion', `Reunión agendada: ${d.titulo} — ${new Date(d.fecha_hora).toLocaleString('es-PE')}`, req.user.nombre, req.user.id]);
  await db.query('UPDATE negocios SET ultima_actividad_at = NOW() WHERE id = ?', [negocioId]);
  res.json({ ok: true, id: r.insertId });
}));

router.put('/:id', requirePerm('agenda.gestionar'), ah(async (req, res) => {
  const [[previo]] = await db.query('SELECT * FROM demos WHERE id = ?', [req.params.id]);
  if (!previo) throw new HttpError(404, 'Reunión no encontrada');
  await asegurarAcceso(req, previo.negocio_id);
  const d = leer(req.body, previo);
  if (new Date(d.fecha_hora).getTime() !== new Date(previo.fecha_hora).getTime()) {
    d.recordatorio_24h = 0; d.recordatorio_1h = 0;
  }
  await db.query('UPDATE demos SET ? WHERE id = ?', [d, previo.id]);
  if (d.estado !== previo.estado) {
    await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?)',
      [previo.negocio_id, 'reunion', `Reunión "${d.titulo}" marcada como ${d.estado.replace('_', ' ')}`, req.user.nombre, req.user.id]);
  }
  res.json({ ok: true });
}));

router.delete('/:id', requirePerm('agenda.gestionar'), ah(async (req, res) => {
  const [[d]] = await db.query('SELECT negocio_id FROM demos WHERE id = ?', [req.params.id]);
  if (!d) throw new HttpError(404, 'Reunión no encontrada');
  await asegurarAcceso(req, d.negocio_id);
  await db.query('DELETE FROM demos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
