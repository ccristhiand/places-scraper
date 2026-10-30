const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const router  = express.Router();
const db      = require('../db');
const config  = require('../lib/config');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { filtroContactos, asegurarAcceso } = require('../lib/filtros');
const { ventanaAbierta } = require('../lib/mensajeria');
const { ah, HttpError, texto, entero, normalizarEtiquetas } = require('../lib/utils');

const PLACES = 'https://maps.googleapis.com/maps/api/place';
const sleep  = ms => new Promise(r => setTimeout(r, ms));

const ORDEN = { nombre: 'n.nombre', rating: 'n.rating', created_at: 'n.created_at', estado_crm: 'n.estado_crm',
                distrito: 'n.distrito', valor: 'n.valor_estimado', actividad: 'n.ultima_actividad_at' };

const SELECT = `SELECT n.id, n.nombre, n.contacto_nombre, n.telefono, n.telefono_int, n.whatsapp, n.email, n.website,
  n.direccion, n.rating, n.resenas, n.departamento, n.provincia, n.distrito, n.rubro_busqueda, n.estado_crm,
  n.valor_estimado, n.asignado_a, u.nombre AS asignado_nombre, n.etiquetas, n.origen, n.wa_verificado,
  n.ultimo_entrante_at, n.ultima_actividad_at, n.created_at
  FROM negocios n LEFT JOIN usuarios u ON u.id = n.asignado_a`;

// ── Listado ───────────────────────────────────────────────────────────────
router.get('/', requirePerm('contactos.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos(req.query, req);
  const sort = ORDEN[req.query.sort] || 'n.created_at';
  const dir  = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const lim  = entero(req.query.limit, 25, 1, 500);
  const off  = entero(req.query.offset, 0, 0);
  const [rows] = await db.query(`${SELECT} WHERE ${where} ORDER BY ${sort} ${dir}, n.id DESC LIMIT ? OFFSET ?`, [...vals, lim, off]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM negocios n WHERE ${where}`, vals);
  res.json({ ok: true, total, rows, limit: lim, offset: off });
}));

// Solo IDs (para "seleccionar todos los filtrados")
router.get('/ids', requirePerm('contactos.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos(req.query, req);
  const [rows] = await db.query(`SELECT n.id FROM negocios n WHERE ${where} LIMIT 20000`, vals);
  res.json({ ok: true, ids: rows.map(r => r.id) });
}));

router.get('/facetas', requirePerm('contactos.ver'), ah(async (req, res) => {
  const { where, vals } = filtroContactos({}, req);
  const [rubros] = await db.query(`SELECT rubro_busqueda AS v, COUNT(*) AS n FROM negocios n WHERE ${where} AND COALESCE(rubro_busqueda,'') <> '' GROUP BY rubro_busqueda ORDER BY n DESC LIMIT 50`, vals);
  const [etiq]   = await db.query(`SELECT etiquetas FROM negocios n WHERE ${where} AND COALESCE(etiquetas,'') <> '' LIMIT 5000`, vals);
  const set = new Map();
  etiq.forEach(r => r.etiquetas.split(',').forEach(t => set.set(t, (set.get(t) || 0) + 1)));
  res.json({ ok: true, rubros, etiquetas: [...set.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n })) });
}));

router.get('/export.csv', requirePerm('contactos.exportar'), ah(async (req, res) => {
  const { where, vals } = filtroContactos(req.query, req);
  const [rows] = await db.query(`${SELECT} WHERE ${where} ORDER BY n.id LIMIT 50000`, vals);
  const cols = ['id', 'nombre', 'contacto_nombre', 'telefono', 'whatsapp', 'email', 'website', 'direccion', 'distrito', 'provincia',
                'departamento', 'rubro_busqueda', 'estado_crm', 'valor_estimado', 'asignado_nombre', 'etiquetas', 'rating', 'origen', 'created_at'];
  // Prefijo ' en celdas que empiezan con = + - @ para evitar inyección de fórmulas en Excel
  const cel = v => {
    let s = v instanceof Date ? v.toISOString() : String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = '﻿' + cols.join(',') + '\n' + rows.map(r => cols.map(c => cel(r[c])).join(',')).join('\n');
  await audit(req, 'contactos_exportados', { detalle: { total: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ── Prospección: Google Places ────────────────────────────────────────────
function fmtLugar(l, d = {}) {
  return {
    place_id:     l.place_id,
    nombre:       d.name || l.name || '',
    direccion:    d.formatted_address || l.formatted_address || '',
    telefono:     d.formatted_phone_number || '',
    telefono_int: d.international_phone_number || '',
    website:      d.website || '',
    rating:       d.rating || l.rating || null,
    resenas:      d.user_ratings_total || l.user_ratings_total || 0,
    estado:       ({ OPERATIONAL: 'Activo', CLOSED_TEMPORARILY: 'Cerrado temporalmente', CLOSED_PERMANENTLY: 'Cerrado permanentemente' })[d.business_status || l.business_status] || '',
    horarios:     d.opening_hours?.weekday_text?.join(' | ') || '',
    categorias:   (d.types || l.types || []).filter(t => !['point_of_interest', 'establishment'].includes(t)).join(', '),
    descripcion:  d.editorial_summary?.overview || '',
    maps_url:     d.url || `https://www.google.com/maps/place/?q=place_id:${l.place_id}`,
    lat:          l.geometry?.location?.lat || null,
    lng:          l.geometry?.location?.lng || null,
  };
}

router.post('/buscar', requirePerm('prospeccion.buscar'), ah(async (req, res) => {
  const KEY = await config.get('google_api_key');
  if (!KEY) throw new HttpError(400, 'Configura la API key de Google Places en Configuración → Integraciones.');
  const busqueda = texto(req.body.busqueda, 120);
  if (!busqueda) throw new HttpError(400, 'Escribe qué tipo de negocio buscas.');
  const { departamento, provincia, distrito } = req.body;
  const query = `${busqueda} en ${[distrito, provincia, departamento, 'Peru'].filter(Boolean).join(', ')}`;

  let lugares = [], token = null;
  do {
    const params = { query, key: KEY, language: 'es' };
    if (token) { params.pagetoken = token; await sleep(2000); }
    const r = await axios.get(`${PLACES}/textsearch/json`, { params, timeout: 20000 });
    if (!['OK', 'ZERO_RESULTS'].includes(r.data.status))
      throw new HttpError(400, `Google respondió: ${r.data.status}${r.data.error_message ? ' — ' + r.data.error_message : ''}`);
    lugares = lugares.concat(r.data.results || []);
    token = r.data.next_page_token || null;
  } while (token && lugares.length < 60);

  const ids = lugares.map(l => l.place_id);
  const existentes = new Set();
  if (ids.length) {
    const [ex] = await db.query('SELECT place_id FROM negocios WHERE place_id IN (?)', [ids]);
    ex.forEach(e => existentes.add(e.place_id));
  }

  const resultados = [];
  for (const l of lugares) {
    try {
      const d = await axios.get(`${PLACES}/details/json`, { timeout: 15000, params: {
        place_id: l.place_id, key: KEY, language: 'es',
        fields: 'name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,opening_hours,business_status,types,url,editorial_summary',
      } });
      resultados.push({ ...fmtLugar(l, d.data.result || {}), departamento, provincia, distrito, existe: existentes.has(l.place_id) });
    } catch { resultados.push({ ...fmtLugar(l), departamento, provincia, distrito, existe: existentes.has(l.place_id) }); }
    await sleep(100);
  }
  res.json({ ok: true, total: resultados.length, query, resultados });
}));

router.post('/importar', requirePerm('prospeccion.buscar'), ah(async (req, res) => {
  const { registros, rubro } = req.body;
  if (!Array.isArray(registros) || !registros.length) throw new HttpError(400, 'No hay registros para importar.');
  const asignado = req.user.can('contactos.asignar') && req.body.asignado_a ? parseInt(req.body.asignado_a, 10) : req.user.id;
  const etiquetas = normalizarEtiquetas(req.body.etiquetas);
  const [[primera]] = await db.query('SELECT clave FROM etapas ORDER BY orden LIMIT 1');
  let insertados = 0, actualizados = 0, errores = 0;
  for (const r of registros.slice(0, 500)) {
    if (!r.place_id) { errores++; continue; }
    try {
      const [x] = await db.query(`
        INSERT INTO negocios (place_id, nombre, telefono, telefono_int, website, direccion, rating, resenas, estado, horarios,
          categorias, descripcion, maps_url, lat, lng, departamento, provincia, distrito, rubro_busqueda, origen, asignado_a, etiquetas, estado_crm)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'google',?,?,?)
        ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), telefono=VALUES(telefono), telefono_int=VALUES(telefono_int),
          website=VALUES(website), rating=VALUES(rating), resenas=VALUES(resenas), updated_at=NOW()`,
        [r.place_id, texto(r.nombre, 500), texto(r.telefono, 100), texto(r.telefono_int, 100), texto(r.website, 500), texto(r.direccion, 2000),
         r.rating || null, entero(r.resenas, 0), texto(r.estado, 100), texto(r.horarios, 2000), texto(r.categorias, 500), texto(r.descripcion, 2000),
         texto(r.maps_url, 2000), r.lat || null, r.lng || null, texto(r.departamento, 100), texto(r.provincia, 100), texto(r.distrito, 100),
         texto(rubro, 200) || '', asignado, etiquetas || null, primera?.clave || 'nuevo']);
      x.affectedRows === 1 ? insertados++ : actualizados++;
    } catch (e) { errores++; }
  }
  await audit(req, 'contactos_importados', { detalle: { insertados, actualizados, errores, rubro } });
  res.json({ ok: true, insertados, actualizados, errores });
}));

// ── Acciones masivas ──────────────────────────────────────────────────────
router.post('/masivo', ah(async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean).slice(0, 20000);
  const { accion, valor } = req.body;
  if (!ids.length) throw new HttpError(400, 'No seleccionaste contactos.');

  // Solo contactos visibles para el usuario
  const { where, vals } = filtroContactos({}, req);
  const [vis] = await db.query(`SELECT n.id, n.estado_crm FROM negocios n WHERE ${where} AND n.id IN (?)`, [...vals, ids]);
  const visibles = vis.map(v => v.id);
  if (!visibles.length) throw new HttpError(403, 'No tienes acceso a esos contactos.');

  let afectados = 0;
  if (accion === 'etapa') {
    if (!req.user.can('pipeline.mover')) throw new HttpError(403, 'No tienes permiso para mover etapas.');
    const [[et]] = await db.query('SELECT clave, nombre FROM etapas WHERE clave = ?', [valor]);
    if (!et) throw new HttpError(400, 'Etapa inválida.');
    const [r] = await db.query('UPDATE negocios SET estado_crm=? WHERE id IN (?) AND estado_crm <> ?', [et.clave, visibles, et.clave]);
    afectados = r.affectedRows;
    for (const v of vis.filter(v => v.estado_crm !== et.clave))
      await db.query('INSERT INTO crm_historial (negocio_id, tipo, estado_anterior, estado_nuevo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?,?,?)',
        [v.id, 'estado', v.estado_crm, et.clave, `Movido a ${et.nombre} (acción masiva)`, req.user.nombre, req.user.id]);
  } else if (accion === 'asignar') {
    if (!req.user.can('contactos.asignar')) throw new HttpError(403, 'No tienes permiso para asignar contactos.');
    const uid = valor ? parseInt(valor, 10) : null;
    const [r] = await db.query('UPDATE negocios SET asignado_a=? WHERE id IN (?)', [uid, visibles]);
    afectados = r.affectedRows;
  } else if (accion === 'etiqueta') {
    if (!req.user.can('contactos.editar')) throw new HttpError(403, 'No tienes permiso para editar contactos.');
    const tag = normalizarEtiquetas(valor);
    if (!tag) throw new HttpError(400, 'Escribe una etiqueta.');
    const [r] = await db.query(`UPDATE negocios SET etiquetas = IF(COALESCE(etiquetas,'')='', ?, CONCAT(etiquetas, ',', ?))
      WHERE id IN (?) AND NOT FIND_IN_SET(?, COALESCE(etiquetas,''))`, [tag, tag, visibles, tag]);
    afectados = r.affectedRows;
  } else if (accion === 'eliminar') {
    if (!req.user.can('contactos.eliminar')) throw new HttpError(403, 'No tienes permiso para eliminar contactos.');
    const [r] = await db.query('DELETE FROM negocios WHERE id IN (?)', [visibles]);
    afectados = r.affectedRows;
  } else throw new HttpError(400, 'Acción desconocida.');

  await audit(req, `masivo_${accion}`, { entidad: 'contacto', detalle: { total: visibles.length, valor } });
  res.json({ ok: true, afectados });
}));

// ── CRUD ──────────────────────────────────────────────────────────────────
const EDITABLES = {
  nombre: 500, contacto_nombre: 200, telefono: 100, whatsapp: 50, email: 190, website: 500, direccion: 2000,
  departamento: 100, provincia: 100, distrito: 100, rubro_busqueda: 200, descripcion: 2000,
};

function leerCampos(body) {
  const out = {};
  for (const [k, max] of Object.entries(EDITABLES)) if (body[k] !== undefined) out[k] = texto(body[k], max);
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new HttpError(400, 'Correo inválido.');
  if (body.valor_estimado !== undefined) out.valor_estimado = body.valor_estimado === '' || body.valor_estimado === null ? null : Math.max(0, parseFloat(body.valor_estimado) || 0);
  if (body.etiquetas !== undefined) out.etiquetas = normalizarEtiquetas(body.etiquetas) || null;
  return out;
}

router.post('/', requirePerm('contactos.crear'), ah(async (req, res) => {
  const c = leerCampos(req.body);
  if (!c.nombre) throw new HttpError(400, 'El nombre es obligatorio.');
  const [[primera]] = await db.query('SELECT clave FROM etapas ORDER BY orden LIMIT 1');
  c.estado_crm = req.body.estado_crm || primera?.clave || 'nuevo';
  c.asignado_a = req.user.can('contactos.asignar') && req.body.asignado_a !== undefined
    ? (req.body.asignado_a ? parseInt(req.body.asignado_a, 10) : null) : req.user.id;
  c.place_id = 'manual:' + crypto.randomUUID();
  c.origen = 'manual';
  const [r] = await db.query('INSERT INTO negocios SET ?', [c]);
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?)',
    [r.insertId, 'sistema', 'Contacto creado manualmente', req.user.nombre, req.user.id]);
  res.json({ ok: true, id: r.insertId });
}));

router.get('/:id', requirePerm('contactos.ver'), ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await asegurarAcceso(req, id);
  const [[n]] = await db.query(`SELECT n.*, u.nombre AS asignado_nombre FROM negocios n LEFT JOIN usuarios u ON u.id = n.asignado_a WHERE n.id = ?`, [id]);
  const [[cuentas]] = await db.query(`SELECT
      (SELECT COUNT(*) FROM chat_mensajes WHERE negocio_id = ?) AS mensajes,
      (SELECT COUNT(*) FROM tareas WHERE negocio_id = ? AND estado = 'pendiente') AS tareas,
      (SELECT COUNT(*) FROM demos WHERE negocio_id = ? AND estado = 'agendada' AND fecha_hora > NOW()) AS reuniones`, [id, id, id]);
  n.ventana_abierta = ventanaAbierta(n);
  res.json({ ok: true, contacto: n, cuentas });
}));

router.put('/:id', requirePerm('contactos.editar'), ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await asegurarAcceso(req, id);
  const c = leerCampos(req.body);
  if (c.nombre === null) throw new HttpError(400, 'El nombre es obligatorio.');
  if (req.body.asignado_a !== undefined) {
    if (!req.user.can('contactos.asignar')) throw new HttpError(403, 'No tienes permiso para reasignar contactos.');
    c.asignado_a = req.body.asignado_a ? parseInt(req.body.asignado_a, 10) : null;
  }
  if (!Object.keys(c).length) return res.json({ ok: true });
  await db.query('UPDATE negocios SET ? WHERE id = ?', [c, id]);
  res.json({ ok: true });
}));

router.patch('/:id/etapa', requirePerm('pipeline.mover'), ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await asegurarAcceso(req, id);
  const [[et]] = await db.query('SELECT clave, nombre FROM etapas WHERE clave = ?', [req.body.etapa]);
  if (!et) throw new HttpError(400, 'Etapa inválida.');
  const [[n]] = await db.query('SELECT estado_crm FROM negocios WHERE id = ?', [id]);
  if (n.estado_crm === et.clave) return res.json({ ok: true });
  await db.query('UPDATE negocios SET estado_crm = ?, ultima_actividad_at = NOW() WHERE id = ?', [et.clave, id]);
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, estado_anterior, estado_nuevo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?,?,?)',
    [id, 'estado', n.estado_crm, et.clave, `Movido a ${et.nombre}${req.body.motivo ? ': ' + texto(req.body.motivo, 300) : ''}`, req.user.nombre, req.user.id]);
  res.json({ ok: true });
}));

router.delete('/:id', requirePerm('contactos.eliminar'), ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await asegurarAcceso(req, id);
  const [[n]] = await db.query('SELECT nombre FROM negocios WHERE id = ?', [id]);
  await db.query('DELETE FROM negocios WHERE id = ?', [id]);
  await audit(req, 'contacto_eliminado', { entidad: 'contacto', entidadId: id, detalle: n?.nombre });
  res.json({ ok: true });
}));

module.exports = router;
