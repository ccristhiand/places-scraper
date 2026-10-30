const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const db      = require('../db');
const config  = require('../lib/config');
const meta    = require('../meta');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { tokenAleatorio } = require('../lib/crypto');
const { ah, HttpError, entero } = require('../lib/utils');

router.get('/', requirePerm('config.ver'), ah(async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    valores: await config.vistaPublica(),
    definiciones: Object.fromEntries(Object.entries(config.DEFS).map(([k, d]) => [k, { grupo: d.grupo, label: d.label, tipo: d.tipo || 'text', min: d.min, max: d.max }])),
    webhook_url: `${base}/api/webhook/meta`,
    leads_url: `${base}/api/leads`,
  });
}));

router.put('/', requirePerm('config.editar'), ah(async (req, res) => {
  const cambiadas = await config.set(req.body.valores || {});
  await audit(req, 'config_editada', { detalle: cambiadas });
  res.json({ ok: true, cambiadas });
}));

router.post('/meta/verify-token', requirePerm('config.editar'), ah(async (req, res) => {
  const token = tokenAleatorio(18);
  await config.set({ meta_verify_token: token });
  await audit(req, 'verify_token_regenerado');
  res.json({ ok: true, token });
}));

router.post('/google/probar', requirePerm('config.editar'), ah(async (req, res) => {
  const key = await config.get('google_api_key');
  if (!key) throw new HttpError(400, 'No hay API key de Google configurada.');
  const r = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
    params: { query: 'restaurante en Miraflores, Lima, Peru', key, language: 'es' }, timeout: 15000 });
  if (!['OK', 'ZERO_RESULTS'].includes(r.data.status))
    throw new HttpError(400, `Google respondió ${r.data.status}${r.data.error_message ? ': ' + r.data.error_message : ''}`);
  res.json({ ok: true, resultados: r.data.results?.length || 0 });
}));

router.get('/auditoria', requirePerm('auditoria.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  if (req.query.usuario_id) { w.push('usuario_id = ?'); v.push(parseInt(req.query.usuario_id, 10)); }
  if (req.query.accion)     { w.push('accion LIKE ?');  v.push(`%${req.query.accion}%`); }
  const lim = entero(req.query.limit, 50, 1, 200), off = entero(req.query.offset, 0, 0);
  const [rows] = await db.query(`SELECT * FROM auditoria WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...v, lim, off]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM auditoria WHERE ${w.join(' AND ')}`, v);
  res.json({ ok: true, rows, total });
}));

module.exports = router;
