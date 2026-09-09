const express = require('express');
const router  = express.Router();
const UBIGEO  = require('../../data/ubigeo');

router.get('/departamentos', (req, res) => res.json(Object.keys(UBIGEO).sort()));

router.get('/provincias/:dep', (req, res) => {
  const dep = UBIGEO[req.params.dep];
  if (!dep) return res.status(404).json({ error: 'No encontrado' });
  res.json(Object.keys(dep).sort());
});

router.get('/distritos/:dep/:prov', (req, res) => {
  const dep = UBIGEO[req.params.dep];
  if (!dep) return res.status(404).json({ error: 'No encontrado' });
  const dist = dep[req.params.prov];
  if (!dist) return res.status(404).json({ error: 'No encontrado' });
  res.json([...dist].sort());
});

// GET /api/ubigeo?dep=X&prov=Y — endpoint unificado para los filtros del frontend
router.get('/', (req, res) => {
  const { dep, prov } = req.query;
  if (!dep) return res.json({ departamentos: Object.keys(UBIGEO).sort() });
  const depData = UBIGEO[dep];
  if (!depData) return res.json({ provincias: [] });
  if (!prov) return res.json({ provincias: Object.keys(depData).sort() });
  const provData = depData[prov];
  if (!provData) return res.json({ distritos: [] });
  res.json({ distritos: [...provData].sort() });
});

module.exports = router;