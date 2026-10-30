// Panel principal, reportes y notificaciones
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const config  = require('../lib/config');
const queue   = require('../queue');
const { requirePerm } = require('../lib/auth');
const { filtroContactos } = require('../lib/filtros');
const { ah } = require('../lib/utils');

async function resumenEnvios() {
  const [[c]] = await db.query("SELECT COUNT(*) AS n, GROUP_CONCAT(nombre ORDER BY id SEPARATOR ', ') AS nombres FROM campanas WHERE estado = 'enviando'");
  const b = await queue.bloqueo();
  const enviando = Number(c.n) > 0 && !b;
  return {
    hoy: await queue.enviadosHoy(), limite: await config.getInt('limite_diario'),
    cola: { corriendo: enviando, mensaje: enviando ? `Enviando: ${c.nombres}` : Number(c.n) ? b?.msg : null },
  };
}

router.get('/dashboard', requirePerm('dashboard.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos({}, req);
  const yo = req.user.id;

  const [[kpi]] = await db.query(`SELECT
      COUNT(*) AS contactos,
      SUM(n.created_at >= CURDATE() - INTERVAL 7 DAY) AS nuevos_7d,
      SUM(e.tipo = 'abierta') AS abiertos,
      COALESCE(SUM(IF(e.tipo = 'abierta', n.valor_estimado, 0)), 0) AS valor_abierto,
      SUM(e.tipo = 'ganada') AS ganados,
      COALESCE(SUM(IF(e.tipo = 'ganada', n.valor_estimado, 0)), 0) AS valor_ganado,
      SUM(n.ultimo_entrante_at > NOW() - INTERVAL 24 HOUR) AS ventana_abierta
    FROM negocios n LEFT JOIN etapas e ON e.clave = n.estado_crm WHERE ${where}`, vals);

  const [embudo] = await db.query(`
    SELECT e.clave, e.nombre, e.color, e.tipo, COUNT(n.id) AS total, COALESCE(SUM(n.valor_estimado),0) AS valor
    FROM etapas e LEFT JOIN negocios n ON n.estado_crm = e.clave AND ${where}
    GROUP BY e.id ORDER BY e.orden`, vals);

  const [[msg]] = await db.query(`SELECT
      SUM(m.direccion = 'entrante' AND m.created_at >= CURDATE() - INTERVAL 7 DAY) AS recibidos_7d,
      SUM(m.direccion = 'saliente' AND m.created_at >= CURDATE() - INTERVAL 7 DAY) AS enviados_7d,
      SUM(m.direccion = 'entrante' AND m.leido = 0) AS sin_leer
    FROM chat_mensajes m JOIN negocios n ON n.id = m.negocio_id WHERE ${where}`, vals);

  const [serie] = await db.query(`
    SELECT DATE(m.created_at) AS dia, SUM(m.direccion='saliente') AS enviados, SUM(m.direccion='entrante') AS recibidos
    FROM chat_mensajes m JOIN negocios n ON n.id = m.negocio_id
    WHERE m.created_at >= CURDATE() - INTERVAL 13 DAY AND ${where}
    GROUP BY DATE(m.created_at) ORDER BY dia`, vals);

  const [reuniones] = await db.query(`
    SELECT d.id, d.titulo, d.fecha_hora, d.tipo, d.enlace, n.id AS negocio_id, n.nombre
    FROM demos d JOIN negocios n ON n.id = d.negocio_id
    WHERE d.estado = 'agendada' AND d.fecha_hora >= NOW() - INTERVAL 1 HOUR AND ${where}
    ORDER BY d.fecha_hora LIMIT 6`, vals);

  const [tareas] = await db.query(`
    SELECT t.id, t.titulo, t.vence_at, t.prioridad, n.id AS negocio_id, n.nombre AS negocio_nombre
    FROM tareas t LEFT JOIN negocios n ON n.id = t.negocio_id
    WHERE t.estado = 'pendiente' AND t.asignado_a = ?
    ORDER BY t.vence_at IS NULL, t.vence_at LIMIT 8`, [yo]);
  const [[tcount]] = await db.query(`SELECT SUM(vence_at < NOW()) AS vencidas, SUM(DATE(vence_at) = CURDATE()) AS hoy, COUNT(*) AS total
    FROM tareas WHERE estado = 'pendiente' AND asignado_a = ?`, [yo]);

  const [actividad] = await db.query(`
    SELECT h.id, h.tipo, h.contenido, h.usuario, h.created_at, n.id AS negocio_id, n.nombre
    FROM crm_historial h JOIN negocios n ON n.id = h.negocio_id
    WHERE ${where} ORDER BY h.id DESC LIMIT 12`, vals);

  let leads = null;
  if (req.user.can('leads.ver')) {
    const [[l]] = await db.query("SELECT SUM(estado='nuevo') AS nuevos, COUNT(*) AS total FROM leads_vetclinic");
    leads = l;
  }

  res.json({
    ok: true, kpi, embudo, mensajes: msg, serie, reuniones, tareas, tareas_resumen: tcount, actividad, leads,
    envios: req.user.can('envios.ver') ? await resumenEnvios() : null,
  });
}));

router.get('/reportes', requirePerm('reportes.ver'), ah(async (req, res) => {
  const desde = req.query.desde || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const hasta = req.query.hasta || new Date().toISOString().slice(0, 10);
  const R = [desde, hasta];

  const [envios] = await db.query(`
    SELECT DATE(e.enviado_at) AS dia,
      COUNT(*) AS enviados, SUM(e.estado IN ('entregado','leido')) AS entregados, SUM(e.estado = 'leido') AS leidos
    FROM envios e WHERE e.enviado_at >= ? AND e.enviado_at < DATE_ADD(?, INTERVAL 1 DAY)
    GROUP BY DATE(e.enviado_at) ORDER BY dia`, R);

  const [campanas] = await db.query(`
    SELECT c.id, c.nombre, COUNT(e.id) AS enviados,
      SUM(e.estado IN ('entregado','leido')) AS entregados, SUM(e.estado = 'leido') AS leidos, SUM(e.estado = 'fallido') AS fallidos,
      (SELECT COUNT(DISTINCT m.negocio_id) FROM chat_mensajes m JOIN envios e2 ON e2.negocio_id = m.negocio_id AND e2.campana_id = c.id
        WHERE m.direccion = 'entrante' AND m.created_at > e2.enviado_at) AS respondieron
    FROM campanas c JOIN envios e ON e.campana_id = c.id
    WHERE e.created_at >= ? AND e.created_at < DATE_ADD(?, INTERVAL 1 DAY)
    GROUP BY c.id ORDER BY enviados DESC LIMIT 20`, R);

  const [etapas] = await db.query(`
    SELECT e.nombre, e.color, e.tipo, COUNT(n.id) AS total, COALESCE(SUM(n.valor_estimado),0) AS valor
    FROM etapas e LEFT JOIN negocios n ON n.estado_crm = e.clave GROUP BY e.id ORDER BY e.orden`);

  // Agrupar sobre una tabla derivada: compatible con sql_mode=ONLY_FULL_GROUP_BY
  const [rubros] = await db.query(`
    SELECT x.nombre, COUNT(*) AS total, SUM(x.ganado) AS ganados FROM (
      SELECT COALESCE(NULLIF(n.rubro_busqueda,''),'(sin rubro)') AS nombre, (e.tipo = 'ganada') AS ganado
      FROM negocios n LEFT JOIN etapas e ON e.clave = n.estado_crm) x
    GROUP BY x.nombre ORDER BY total DESC LIMIT 10`);

  const [distritos] = await db.query(`
    SELECT x.nombre, COUNT(*) AS total FROM (
      SELECT COALESCE(NULLIF(distrito,''),'(sin distrito)') AS nombre FROM negocios) x
    GROUP BY x.nombre ORDER BY total DESC LIMIT 10`);

  const [vendedores] = await db.query(`
    SELECT u.id, u.nombre,
      (SELECT COUNT(*) FROM negocios n WHERE n.asignado_a = u.id) AS contactos,
      (SELECT COUNT(*) FROM negocios n JOIN etapas e ON e.clave = n.estado_crm WHERE n.asignado_a = u.id AND e.tipo = 'ganada') AS ganados,
      (SELECT COALESCE(SUM(n.valor_estimado),0) FROM negocios n JOIN etapas e ON e.clave = n.estado_crm WHERE n.asignado_a = u.id AND e.tipo = 'ganada') AS valor_ganado,
      (SELECT COUNT(*) FROM crm_historial h WHERE h.usuario_id = u.id AND h.created_at >= ? AND h.created_at < DATE_ADD(?, INTERVAL 1 DAY)) AS actividades,
      (SELECT COUNT(*) FROM chat_mensajes m WHERE m.usuario_id = u.id AND m.created_at >= ? AND m.created_at < DATE_ADD(?, INTERVAL 1 DAY)) AS mensajes,
      (SELECT COUNT(*) FROM tareas t WHERE t.asignado_a = u.id AND t.estado = 'completada' AND t.completada_at >= ? AND t.completada_at < DATE_ADD(?, INTERVAL 1 DAY)) AS tareas
    FROM usuarios u WHERE u.activo = 1 ORDER BY ganados DESC, actividades DESC`, [...R, ...R, ...R]);

  const [origenes] = await db.query(`SELECT x.nombre, COUNT(*) AS total FROM (SELECT COALESCE(origen,'google') AS nombre FROM negocios) x GROUP BY x.nombre ORDER BY total DESC`);

  res.json({ ok: true, desde, hasta, envios, campanas, etapas, rubros, distritos, vendedores, origenes });
}));

// ── Notificaciones del usuario ────────────────────────────────────────────
router.get('/notificaciones', ah(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM notificaciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM notificaciones WHERE usuario_id = ? AND leida = 0', [req.user.id]);
  res.json({ ok: true, rows, sin_leer: n });
}));
router.post('/notificaciones/leer', ah(async (req, res) => {
  if (req.body.id) await db.query('UPDATE notificaciones SET leida = 1 WHERE id = ? AND usuario_id = ?', [req.body.id, req.user.id]);
  else await db.query('UPDATE notificaciones SET leida = 1 WHERE usuario_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

// Búsqueda global (barra superior)
router.get('/buscar', ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, contactos: [] });
  if (!req.user.can('contactos.ver')) return res.json({ ok: true, contactos: [] });
  const { where, vals } = filtroContactos({ q }, req);
  const [contactos] = await db.query(`SELECT n.id, n.nombre, n.distrito, n.estado_crm, n.whatsapp, n.telefono
    FROM negocios n WHERE ${where} ORDER BY n.ultima_actividad_at DESC, n.id DESC LIMIT 8`, vals);
  res.json({ ok: true, contactos });
}));

module.exports = router;
