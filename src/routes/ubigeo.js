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

module.exports = router;
