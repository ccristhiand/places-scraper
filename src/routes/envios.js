// Historial de mensajes de campañas y estado del procesador
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const config  = require('../lib/config');
const queue   = require('../queue');
const { requirePerm } = require('../lib/auth');
const { ah, entero } = require('../lib/utils');

router.get('/', requirePerm('envios.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  if (req.query.campana_id) { w.push('e.campana_id = ?'); v.push(parseInt(req.query.campana_id, 10)); }
  if (req.query.estado)     { w.push('e.estado = ?');     v.push(req.query.estado); }
  if (req.query.q)          { w.push('(n.nombre LIKE ? OR e.numero LIKE ?)'); v.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const lim = entero(req.query.limit, 50, 1, 500), off = entero(req.query.offset, 0, 0);
  const [rows] = await db.query(`
    SELECT e.id, e.campana_id, e.negocio_id, e.numero, e.estado, e.error_msg, e.intentos, e.enviado_at, e.entregado_at,
           e.leido_at, e.created_at, n.nombre, c.nombre AS campana_nombre
    FROM envios e JOIN negocios n ON n.id = e.negocio_id LEFT JOIN campanas c ON c.id = e.campana_id
    WHERE ${w.join(' AND ')} ORDER BY e.id DESC LIMIT ? OFFSET ?`, [...v, lim, off]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM envios e JOIN negocios n ON n.id = e.negocio_id WHERE ${w.join(' AND ')}`, v);
  res.json({ ok: true, rows, total });
}));

router.get('/estado', requirePerm('envios.ver'), ah(async (req, res) => {
  const [[c]] = await db.query(`SELECT
      SUM(estado IN ('pendiente','procesando')) AS pendientes,
      SUM(estado IN ('enviado','entregado','leido') AND enviado_at >= CURDATE()) AS hoy,
      SUM(estado = 'fallido' AND created_at >= CURDATE()) AS fallidos_hoy
    FROM envios`);
  const [enCurso] = await db.query("SELECT id, nombre, estado, total, enviados, fallidos FROM campanas WHERE estado IN ('enviando','programada','pausada') ORDER BY id");
  res.json({
    ok: true,
    procesador: queue.getEstado(),
    bloqueo: await queue.bloqueo(),
    pendientes: Number(c.pendientes || 0),
    hoy: Number(c.hoy || 0),
    fallidos_hoy: Number(c.fallidos_hoy || 0),
    limite: await config.getInt('limite_diario'),
    campanas: enCurso,
  });
}));

module.exports = router;
