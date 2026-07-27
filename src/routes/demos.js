const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/demos
router.get('/', async (req, res) => {
  try {
    const { estado, negocio_id, desde, hasta } = req.query;
    const where = ['1=1'], vals = [];
    if (estado)     { where.push('d.estado=?');      vals.push(estado); }
    if (negocio_id) { where.push('d.negocio_id=?');  vals.push(negocio_id); }
    if (desde)      { where.push('d.fecha_hora>=?');  vals.push(desde); }
    if (hasta)      { where.push('d.fecha_hora<=?');  vals.push(hasta); }
    const [rows] = await db.execute(`
      SELECT d.*, n.nombre, n.telefono, n.whatsapp, n.distrito, n.provincia
      FROM demos d JOIN negocios n ON n.id=d.negocio_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.fecha_hora ASC`, vals);
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/demos
router.post('/', async (req, res) => {
  const { negocio_id, titulo, fecha_hora, duracion_min, tipo, enlace, notas, responsable } = req.body;
  if (!negocio_id || !fecha_hora) return res.status(400).json({ error: 'negocio_id y fecha_hora requeridos' });
  try {
    const [r] = await db.execute(
      'INSERT INTO demos (negocio_id,titulo,fecha_hora,duracion_min,tipo,enlace,notas,responsable) VALUES (?,?,?,?,?,?,?,?)',
      [negocio_id, titulo||'Demo', fecha_hora, duracion_min||60, tipo||'virtual', enlace||null, notas||null, responsable||null]
    );
    await db.execute('INSERT INTO crm_historial (negocio_id,tipo,contenido,usuario) VALUES (?,?,?,?)',
      [negocio_id,'demo',`Demo agendada: ${titulo||'Demo'} — ${fecha_hora}`, responsable||'Sistema']);
    // Cambiar estado CRM a interesado si era nuevo/contactado
    await db.execute(`UPDATE negocios SET estado_crm='interesado' WHERE id=? AND estado_crm IN ('nuevo','contactado')`, [negocio_id]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/demos/:id
router.put('/:id', async (req, res) => {
  const { titulo, fecha_hora, duracion_min, tipo, enlace, notas, estado, responsable } = req.body;
  try {
    await db.execute(
      'UPDATE demos SET titulo=COALESCE(?,titulo),fecha_hora=COALESCE(?,fecha_hora),duracion_min=COALESCE(?,duracion_min),tipo=COALESCE(?,tipo),enlace=COALESCE(?,enlace),notas=COALESCE(?,notas),estado=COALESCE(?,estado),responsable=COALESCE(?,responsable) WHERE id=?',
      [titulo,fecha_hora,duracion_min,tipo,enlace,notas,estado,responsable,req.params.id]
    );
    if (estado) {
      const [[demo]] = await db.execute('SELECT negocio_id FROM demos WHERE id=?', [req.params.id]);
      if (demo) await db.execute('INSERT INTO crm_historial (negocio_id,tipo,contenido) VALUES (?,?,?)',
        [demo.negocio_id,'demo',`Demo ${estado}`]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/demos/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM demos WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
