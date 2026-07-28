const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../db');

const BASE  = 'https://maps.googleapis.com/maps/api/place';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmt(lugar, det = {}) {
  return {
    place_id:     lugar.place_id || '',
    nombre:       det.name || lugar.name || '',
    direccion:    det.formatted_address || lugar.formatted_address || '',
    telefono:     det.formatted_phone_number || '',
    telefono_int: det.international_phone_number || '',
    website:      det.website || '',
    rating:       det.rating || lugar.rating || null,
    resenas:      det.user_ratings_total || lugar.user_ratings_total || 0,
    estado:       ({ OPERATIONAL:'Activo', CLOSED_TEMPORARILY:'Cerrado temporalmente', CLOSED_PERMANENTLY:'Cerrado permanentemente' })[det.business_status || lugar.business_status] || '',
    horarios:     det.opening_hours?.weekday_text?.join(' | ') || '',
    categorias:   (det.types || lugar.types || []).filter(t => !['point_of_interest','establishment','food','store'].includes(t)).join(', '),
    descripcion:  det.editorial_summary?.overview || '',
    maps_url:     det.url || `https://www.google.com/maps/place/?q=place_id:${lugar.place_id}`,
    lat:          lugar.geometry?.location?.lat || null,
    lng:          lugar.geometry?.location?.lng || null,
  };
}

// GET /api/negocios/stats  ← ANTES del /:id
router.get('/stats', async (req, res) => {
  try {
    const [[stats]] = await db.execute(`
      SELECT COUNT(*) as total,
        SUM(telefono!='' AND telefono IS NOT NULL) as con_telefono,
        SUM(website!=''  AND website  IS NOT NULL) as con_website,
        ROUND(AVG(rating),1) as rating_prom
      FROM negocios`);
    const [por_estado] = await db.execute(`SELECT estado_crm as estado, COUNT(*) as total FROM negocios GROUP BY estado_crm`);
    res.json({ ok: true, stats, por_estado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/negocios/buscar  ← ANTES del /:id
router.post('/buscar', async (req, res) => {
  const { busqueda, departamento, provincia, distrito } = req.body;
  const KEY = process.env.GOOGLE_API_KEY;
  if (!KEY || KEY === 'TU_API_KEY_AQUI') return res.status(500).json({ error: 'API Key no configurada' });
  if (!busqueda) return res.status(400).json({ error: 'Falta busqueda' });

  const ubicacion = [distrito, provincia, departamento, 'Peru'].filter(Boolean).join(', ');
  const query = `${busqueda} en ${ubicacion}`;

  try {
    let lugares = [], pageToken = null;
    do {
      const params = { query, key: KEY, language: 'es' };
      if (pageToken) { params.pagetoken = pageToken; await sleep(2000); }
      const r = await axios.get(`${BASE}/textsearch/json`, { params });
      if (!['OK','ZERO_RESULTS'].includes(r.data.status))
        return res.status(400).json({ error: `Google: ${r.data.status}`, detalle: r.data.error_message });
      lugares = lugares.concat(r.data.results || []);
      pageToken = r.data.next_page_token || null;
    } while (pageToken);

    const resultados = [];
    for (const lugar of lugares) {
      try {
        const d = await axios.get(`${BASE}/details/json`, {
          params: { place_id: lugar.place_id, key: KEY, language: 'es',
            fields: 'name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,opening_hours,business_status,types,url,editorial_summary' }
        });
        resultados.push({ ...fmt(lugar, d.data.result || {}), departamento, provincia, distrito });
      } catch { resultados.push({ ...fmt(lugar), departamento, provincia, distrito }); }
      await sleep(120);
    }
    res.json({ ok: true, total: resultados.length, query, resultados });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/negocios/guardar  ← ANTES del /:id
router.post('/guardar', async (req, res) => {
  const { registros, rubro } = req.body;
  if (!registros?.length) return res.status(400).json({ error: 'Sin registros' });
  let insertados = 0, duplicados = 0, errores = 0;
  for (const r of registros) {
    try {
      const [result] = await db.execute(`
        INSERT INTO negocios (place_id,nombre,telefono,telefono_int,website,direccion,rating,resenas,estado,horarios,categorias,descripcion,maps_url,lat,lng,departamento,provincia,distrito,rubro_busqueda)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE nombre=VALUES(nombre),telefono=VALUES(telefono),website=VALUES(website),rating=VALUES(rating),resenas=VALUES(resenas),updated_at=NOW()`,
        [r.place_id,r.nombre,r.telefono,r.telefono_int,r.website,r.direccion,r.rating,r.resenas,r.estado,r.horarios,r.categorias,r.descripcion,r.maps_url,r.lat,r.lng,r.departamento,r.provincia,r.distrito,rubro||'']);
      result.affectedRows === 1 ? insertados++ : duplicados++;
    } catch (e) { e.code === 'ER_DUP_ENTRY' ? duplicados++ : errores++; }
  }
  res.json({ ok: true, insertados, duplicados, errores });
});

// GET /api/negocios
router.get('/', async (req, res) => {
  try {
    const { dep, prov, dist, rubro, estado_crm, q, sin_numero, limit = 20, offset = 0 } = req.query;
    const where = ['1=1'], vals = [];
    if (dep)        { where.push('departamento=?');        vals.push(dep); }
    if (prov)       { where.push('provincia=?');           vals.push(prov); }
    if (dist)       { where.push('distrito=?');            vals.push(dist); }
    if (rubro)      { where.push('rubro_busqueda LIKE ?'); vals.push(`%${rubro}%`); }
    if (estado_crm) { where.push('estado_crm=?');          vals.push(estado_crm); }
    if (q)          { where.push('(nombre LIKE ? OR telefono LIKE ? OR direccion LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (sin_numero === '1') {
      where.push('(telefono IS NULL OR telefono = "") AND (telefono_int IS NULL OR telefono_int = "") AND (whatsapp IS NULL OR whatsapp = "")');
    }
    const lim = Math.min(parseInt(limit) || 20, 500);
    const off = parseInt(offset) || 0;
    const [rows] = await db.execute(
      `SELECT * FROM negocios WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`, vals);
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) as total FROM negocios WHERE ${where.join(' AND ')}`, vals);
    res.json({ ok: true, total, rows, limit: lim, offset: off });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/negocios/:id
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    await db.execute('DELETE FROM negocios WHERE id=?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/negocios/bulk — eliminar múltiples
router.post('/eliminar-bulk', async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'Sin IDs' });
  try {
    const placeholders = ids.map(() => '?').join(',');
    await db.execute(`DELETE FROM negocios WHERE id IN (${placeholders})`, ids);
    res.json({ ok: true, eliminados: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/negocios/:id  ← AL FINAL
router.put('/:id', async (req, res) => {
  const { whatsapp, responsable, estado_crm } = req.body;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[old]] = await db.execute('SELECT estado_crm FROM negocios WHERE id=?', [id]);
    if (!old) return res.status(404).json({ error: 'No encontrado' });
    await db.execute(
      'UPDATE negocios SET whatsapp=COALESCE(?,whatsapp), responsable=COALESCE(?,responsable), estado_crm=COALESCE(?,estado_crm), updated_at=NOW() WHERE id=?',
      [whatsapp || null, responsable || null, estado_crm || null, id]
    );
    if (estado_crm && old.estado_crm !== estado_crm) {
      await db.execute(
        'INSERT INTO crm_historial (negocio_id,tipo,estado_anterior,estado_nuevo,contenido,usuario) VALUES (?,?,?,?,?,?)',
        [id, 'estado', old.estado_crm, estado_crm, `Estado cambiado a ${estado_crm}`, responsable || 'Sistema']
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;