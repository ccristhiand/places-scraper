const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/crm/:negocioId — historial completo
router.get('/:negocioId', async (req, res) => {
  try {
    const [historial] = await db.execute(
      'SELECT * FROM crm_historial WHERE negocio_id=? ORDER BY created_at DESC',
      [req.params.negocioId]
    );
    const [[negocio]] = await db.execute('SELECT * FROM negocios WHERE id=?', [req.params.negocioId]);
    res.json({ ok: true, negocio, historial });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/crm/:negocioId/comentario
router.post('/:negocioId/comentario', async (req, res) => {
  const { contenido, usuario, tipo = 'comentario' } = req.body;
  if (!contenido) return res.status(400).json({ error: 'Contenido requerido' });
  try {
    await db.execute(
      'INSERT INTO crm_historial (negocio_id,tipo,contenido,usuario) VALUES (?,?,?,?)',
      [req.params.negocioId, tipo, contenido, usuario || 'Usuario']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
