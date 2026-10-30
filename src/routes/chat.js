const express = require('express');
const router  = express.Router();
const db      = require('../db');
const meta    = require('../meta');
const { requirePerm } = require('../lib/auth');
const { filtroContactos, asegurarAcceso } = require('../lib/filtros');
const { enviarAContacto, ventanaAbierta } = require('../lib/mensajeria');
const { upload } = require('../lib/uploads');
const { ah, HttpError, texto } = require('../lib/utils');

// Conversaciones: contactos con mensajes, más recientes primero
router.get('/', requirePerm('chat.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos({ q: req.query.q, asignado: req.query.asignado }, req);
  const extra = req.query.filtro === 'no_leidos' ? 'HAVING no_leidos > 0' : '';
  const [rows] = await db.query(`
    SELECT n.id, MAX(n.nombre) AS nombre, MAX(n.whatsapp) AS whatsapp, MAX(n.telefono) AS telefono,
           MAX(n.estado_crm) AS estado_crm, MAX(n.asignado_a) AS asignado_a, MAX(u.nombre) AS asignado_nombre,
           MAX(n.ultimo_entrante_at) AS ultimo_entrante_at, MAX(m.created_at) AS ultimo_msg,
           SUM(m.direccion = 'entrante' AND m.leido = 0) AS no_leidos,
           SUBSTRING_INDEX(GROUP_CONCAT(REPLACE(LEFT(m.contenido, 80), '\n', ' ') ORDER BY m.created_at DESC SEPARATOR '\u0001'), '\u0001', 1) AS ultimo_texto,
           SUBSTRING_INDEX(GROUP_CONCAT(m.direccion ORDER BY m.created_at DESC), ',', 1) AS ultima_direccion
    FROM chat_mensajes m
    JOIN negocios n ON n.id = m.negocio_id
    LEFT JOIN usuarios u ON u.id = n.asignado_a
    WHERE ${where}
    GROUP BY n.id ${extra}
    ORDER BY ultimo_msg DESC
    LIMIT 200`, vals);
  rows.forEach(r => { r.ventana_abierta = ventanaAbierta(r); r.no_leidos = Number(r.no_leidos || 0); });
  res.json({ ok: true, rows });
}));

router.get('/no-leidos', requirePerm('chat.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos({}, req);
  const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM chat_mensajes m JOIN negocios n ON n.id = m.negocio_id
    WHERE m.direccion = 'entrante' AND m.leido = 0 AND ${where}`, vals);
  res.json({ ok: true, total: r.n });
}));

// ── Respuestas rápidas ────────────────────────────────────────────────────
router.get('/respuestas', requirePerm('chat.ver'), ah(async (req, res) => {
  const [rows] = await db.query('SELECT id, atajo, texto FROM respuestas_rapidas ORDER BY atajo');
  res.json({ ok: true, rows });
}));
router.post('/respuestas', requirePerm('chat.enviar'), ah(async (req, res) => {
  const atajo = texto(req.body.atajo, 40), t = texto(req.body.texto, 4000);
  if (!atajo || !t) throw new HttpError(400, 'Completa el atajo y el texto.');
  const [r] = await db.query('INSERT INTO respuestas_rapidas (atajo, texto, creado_por) VALUES (?,?,?)', [atajo.replace(/^\//, ''), t, req.user.id]);
  res.json({ ok: true, id: r.insertId });
}));
router.delete('/respuestas/:id', requirePerm('chat.enviar'), ah(async (req, res) => {
  await db.query('DELETE FROM respuestas_rapidas WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ── Conversación ──────────────────────────────────────────────────────────
router.get('/:negocioId', requirePerm('chat.ver'), ah(async (req, res) => {
  const id = parseInt(req.params.negocioId, 10);
  await asegurarAcceso(req, id);
  const [[n]] = await db.query(`SELECT n.id, n.nombre, n.contacto_nombre, n.whatsapp, n.telefono, n.telefono_int, n.estado_crm,
      n.ultimo_entrante_at, n.asignado_a, u.nombre AS asignado_nombre, n.distrito, n.email
    FROM negocios n LEFT JOIN usuarios u ON u.id = n.asignado_a WHERE n.id = ?`, [id]);
  const [msgs] = await db.query(`
    SELECT * FROM (
      SELECT m.*, us.nombre AS usuario_nombre FROM chat_mensajes m LEFT JOIN usuarios us ON us.id = m.usuario_id
      WHERE m.negocio_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 300
    ) x ORDER BY created_at ASC, id ASC`, [id]);

  const [[ultimoNoLeido]] = await db.query(
    "SELECT wa_id FROM chat_mensajes WHERE negocio_id = ? AND direccion = 'entrante' AND leido = 0 ORDER BY created_at DESC LIMIT 1", [id]);
  if (ultimoNoLeido) {
    await db.query("UPDATE chat_mensajes SET leido = 1 WHERE negocio_id = ? AND direccion = 'entrante' AND leido = 0", [id]);
    if (ultimoNoLeido.wa_id && req.user.can('chat.enviar')) meta.marcarLeido(ultimoNoLeido.wa_id);
  }
  n.ventana_abierta = ventanaAbierta(n);
  res.json({ ok: true, contacto: n, msgs });
}));

async function contactoParaEnviar(req) {
  const id = parseInt(req.params.negocioId, 10);
  await asegurarAcceso(req, id);
  const [[n]] = await db.query('SELECT * FROM negocios WHERE id = ?', [id]);
  return n;
}

router.post('/:negocioId/texto', requirePerm('chat.enviar'), ah(async (req, res) => {
  const t = texto(req.body.texto, 4096);
  if (!t) throw new HttpError(400, 'El mensaje está vacío.');
  const n = await contactoParaEnviar(req);
  const msg = await enviarAContacto(n, { texto: t }, { usuarioId: req.user.id });
  res.json({ ok: true, msg });
}));

router.post('/:negocioId/imagen', requirePerm('chat.enviar'), upload.single('imagen'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Adjunta una imagen.');
  const n = await contactoParaEnviar(req);
  const msg = await enviarAContacto(n, { imagenUrl: `/uploads/${req.file.filename}`, texto: texto(req.body.texto, 1024) || '' }, { usuarioId: req.user.id });
  res.json({ ok: true, msg });
}));

router.post('/:negocioId/plantilla', requirePerm('chat.enviar'), ah(async (req, res) => {
  const n = await contactoParaEnviar(req);
  const nombre = texto(req.body.nombre, 200);
  if (!nombre) throw new HttpError(400, 'Selecciona una plantilla.');
  const lista = await meta.listarPlantillas();
  const t = lista.find(x => x.nombre === nombre && x.idioma === req.body.idioma) || lista.find(x => x.nombre === nombre);
  if (!t) throw new HttpError(400, 'La plantilla no existe en tu cuenta de WhatsApp.');
  if (t.estado !== 'APPROVED') throw new HttpError(400, 'La plantilla aún no está aprobada por Meta.');
  const params = (req.body.params || []).map(p => texto(p, 1000) || '-').slice(0, t.variables);
  if (params.length < t.variables) throw new HttpError(400, `La plantilla necesita ${t.variables} variable(s).`);
  const msg = await enviarAContacto(n, { plantilla: {
    nombre: t.nombre, idioma: t.idioma, params, cuerpo: t.cuerpo, header: t.header, headerUrl: req.body.header_url || null,
  } }, { usuarioId: req.user.id });
  res.json({ ok: true, msg });
}));

module.exports = router;
