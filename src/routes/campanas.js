const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const db      = require('../db');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/campanas
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM campanas ORDER BY created_at DESC');
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/campanas — crear con imagen opcional
router.post('/', upload.single('imagen'), async (req, res) => {
  const { nombre, mensaje } = req.body;
  if (!nombre || !mensaje) return res.status(400).json({ error: 'Nombre y mensaje requeridos' });
  const imagen_url = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    const [r] = await db.execute(
      'INSERT INTO campanas (nombre,mensaje,imagen_url) VALUES (?,?,?)',
      [nombre, mensaje, imagen_url]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/campanas/:id
router.put('/:id', upload.single('imagen'), async (req, res) => {
  const { nombre, mensaje } = req.body;
  try {
    const updates = ['nombre=?','mensaje=?'];
    const vals = [nombre, mensaje];
    if (req.file) { updates.push('imagen_url=?'); vals.push(`/uploads/${req.file.filename}`); }
    vals.push(req.params.id);
    await db.execute(`UPDATE campanas SET ${updates.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/campanas/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM campanas WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
