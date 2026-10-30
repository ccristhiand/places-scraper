const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { filtroContactos, asegurarAcceso } = require('../lib/filtros');
const { ah, HttpError, texto } = require('../lib/utils');

// ── Etapas del pipeline ───────────────────────────────────────────────────
router.get('/etapas', ah(async (req, res) => {
  const [rows] = await db.query(`
    SELECT e.*, (SELECT COUNT(*) FROM negocios n WHERE n.estado_crm = e.clave) AS contactos
    FROM etapas e ORDER BY e.orden, e.id`);
  res.json({ ok: true, rows });
}));

// Reemplaza la lista completa de etapas (orden incluido)
router.put('/etapas', requirePerm('config.editar'), ah(async (req, res) => {
  const lista = Array.isArray(req.body.etapas) ? req.body.etapas : [];
  if (lista.length < 2) throw new HttpError(400, 'Debe haber al menos 2 etapas.');
  const limpio = lista.map((e, i) => {
    const nombre = texto(e.nombre, 80);
    if (!nombre) throw new HttpError(400, 'Todas las etapas necesitan nombre.');
    const clave = texto(e.clave, 40) || nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return {
      clave, nombre,
      color: /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : '#64748b',
      tipo: ['abierta', 'ganada', 'perdida'].includes(e.tipo) ? e.tipo : 'abierta',
      orden: i,
    };
  });
  if (new Set(limpio.map(e => e.clave)).size !== limpio.length) throw new HttpError(400, 'Hay etapas con nombres repetidos.');
  if (!limpio.some(e => e.tipo === 'ganada')) throw new HttpError(400, 'Marca al menos una etapa como "Ganada".');

  const [actuales] = await db.query('SELECT e.clave, e.nombre, (SELECT COUNT(*) FROM negocios n WHERE n.estado_crm = e.clave) AS n FROM etapas e');
  const nuevas = new Set(limpio.map(e => e.clave));
  for (const a of actuales) {
    if (!nuevas.has(a.clave) && a.n > 0) throw new HttpError(400, `La etapa "${a.nombre}" tiene ${a.n} contactos. Muévelos antes de eliminarla.`);
  }
  await db.query('DELETE FROM etapas WHERE clave NOT IN (?)', [[...nuevas]]);
  for (const e of limpio) {
    await db.query(`INSERT INTO etapas (clave, nombre, color, tipo, orden) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), color=VALUES(color), tipo=VALUES(tipo), orden=VALUES(orden)`,
      [e.clave, e.nombre, e.color, e.tipo, e.orden]);
  }
  await audit(req, 'etapas_editadas', { detalle: limpio.map(e => e.nombre) });
  res.json({ ok: true });
}));

// ── Pipeline (kanban) ─────────────────────────────────────────────────────
router.get('/pipeline', requirePerm('pipeline.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos({ ...req.query, etapa: undefined }, req);
  const porEtapa = Math.min(parseInt(req.query.limite, 10) || 50, 200);
  const [etapas] = await db.query('SELECT * FROM etapas ORDER BY orden, id');
  const [tot] = await db.query(`SELECT n.estado_crm AS clave, COUNT(*) AS total, COALESCE(SUM(n.valor_estimado),0) AS valor
    FROM negocios n WHERE ${where} GROUP BY n.estado_crm`, vals);
  const tmap = Object.fromEntries(tot.map(t => [t.clave, t]));
  const columnas = [];
  for (const e of etapas) {
    const [cards] = await db.query(`
      SELECT n.id, n.nombre, n.contacto_nombre, n.distrito, n.rubro_busqueda, n.valor_estimado, n.etiquetas,
             n.asignado_a, u.nombre AS asignado_nombre, n.ultima_actividad_at, n.ultimo_entrante_at, n.updated_at,
             (SELECT COUNT(*) FROM tareas t WHERE t.negocio_id = n.id AND t.estado = 'pendiente') AS tareas
      FROM negocios n LEFT JOIN usuarios u ON u.id = n.asignado_a
      WHERE ${where} AND n.estado_crm = ?
      ORDER BY COALESCE(n.ultima_actividad_at, n.updated_at) DESC LIMIT ?`, [...vals, e.clave, porEtapa]);
    columnas.push({ ...e, total: tmap[e.clave]?.total || 0, valor: Number(tmap[e.clave]?.valor || 0), cards });
  }
  res.json({ ok: true, columnas });
}));

// ── Historial y actividad de un contacto ──────────────────────────────────
router.get('/:negocioId/historial', requirePerm('contactos.ver'), ah(async (req, res) => {
  const id = parseInt(req.params.negocioId, 10);
  await asegurarAcceso(req, id);
  const [rows] = await db.query('SELECT * FROM crm_historial WHERE negocio_id = ? ORDER BY created_at DESC, id DESC LIMIT 300', [id]);
  res.json({ ok: true, rows });
}));

const TIPOS = ['comentario', 'llamada', 'reunion', 'email', 'whatsapp', 'visita'];

router.post('/:negocioId/actividad', requirePerm('contactos.editar'), ah(async (req, res) => {
  const id = parseInt(req.params.negocioId, 10);
  await asegurarAcceso(req, id);
  const contenido = texto(req.body.contenido, 5000);
  if (!contenido) throw new HttpError(400, 'Escribe el detalle de la actividad.');
  const tipo = TIPOS.includes(req.body.tipo) ? req.body.tipo : 'comentario';
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?)',
    [id, tipo, contenido, req.user.nombre, req.user.id]);
  await db.query('UPDATE negocios SET ultima_actividad_at = NOW() WHERE id = ?', [id]);
  res.json({ ok: true });
}));

router.delete('/actividad/:id', requirePerm('contactos.editar'), ah(async (req, res) => {
  const [[h]] = await db.query('SELECT negocio_id, usuario_id, tipo FROM crm_historial WHERE id = ?', [req.params.id]);
  if (!h) throw new HttpError(404, 'Actividad no encontrada');
  await asegurarAcceso(req, h.negocio_id);
  if (h.usuario_id !== req.user.id && !req.user.can('contactos.eliminar'))
    throw new HttpError(403, 'Solo puedes borrar tus propias notas.');
  if (!TIPOS.includes(h.tipo)) throw new HttpError(400, 'Los eventos del sistema no se pueden borrar.');
  await db.query('DELETE FROM crm_historial WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
