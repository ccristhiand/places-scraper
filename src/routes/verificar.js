const express = require('express');
const router  = express.Router();
const db      = require('../db');
const wa      = require('../whatsapp');

// GET /api/verificar/stats — cuántos verificados/sin verificar
router.get('/stats', async (req, res) => {
  try {
    const [[stats]] = await db.execute(`
      SELECT
        COUNT(*) as total,
        SUM(wa_verificado = 1)   as con_wa,
        SUM(wa_verificado = 0)   as sin_wa,
        SUM(wa_verificado IS NULL) as sin_verificar
      FROM negocios
      WHERE telefono IS NOT NULL AND telefono != ''
         OR whatsapp IS NOT NULL AND whatsapp != ''
    `);
    res.json({ ok: true, stats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/verificar/lote — verificar un lote de negocios
router.post('/lote', async (req, res) => {
  const { negocio_ids, solo_sin_verificar = true } = req.body;

  try {
    let query = `
      SELECT id, nombre, telefono, telefono_int, whatsapp
      FROM negocios
      WHERE (telefono IS NOT NULL OR whatsapp IS NOT NULL)
    `;
    const vals = [];

    if (negocio_ids?.length) {
      query += ` AND id IN (${negocio_ids.map(() => '?').join(',')})`;
      vals.push(...negocio_ids);
    } else if (solo_sin_verificar) {
      query += ' AND wa_verificado IS NULL';
    }

    query += ' LIMIT 50'; // máximo 50 por lote para no saturar

    const [negocios] = await db.execute(query, vals);
    if (!negocios.length) return res.json({ ok: true, total: 0, msg: 'Sin negocios para verificar' });

    // Responder inmediatamente y verificar en background
    res.json({ ok: true, total: negocios.length, msg: `Verificando ${negocios.length} números...` });

    // Verificar en background
    verificarEnBackground(negocios);

  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/verificar/uno — verificar un solo negocio
router.post('/uno/:id', async (req, res) => {
  try {
    const [[n]] = await db.execute('SELECT * FROM negocios WHERE id=?', [req.params.id]);
    if (!n) return res.status(404).json({ error: 'No encontrado' });

    const numero = n.whatsapp || n.telefono_int || n.telefono;
    if (!numero) return res.json({ ok: true, tiene_wa: null, msg: 'Sin número registrado' });

    const tieneWA = await wa.verificarNumero(numero);
    await db.execute('UPDATE negocios SET wa_verificado=? WHERE id=?', [tieneWA ? 1 : 0, n.id]);

    res.json({ ok: true, tiene_wa: tieneWA, nombre: n.nombre });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function verificarEnBackground(negocios) {
  const io = global.io;
  let verificados = 0, con_wa = 0, sin_wa = 0;

  for (const n of negocios) {
    try {
      const numero   = n.whatsapp || n.telefono_int || n.telefono;
      if (!numero) {
        await db.execute('UPDATE negocios SET wa_verificado=0 WHERE id=?', [n.id]);
        sin_wa++;
        continue;
      }

      const tieneWA = await wa.verificarNumero(numero);
      await db.execute('UPDATE negocios SET wa_verificado=? WHERE id=?', [tieneWA ? 1 : 0, n.id]);

      if (tieneWA) con_wa++; else sin_wa++;
      verificados++;

      console.log(`  ${tieneWA ? '✅' : '❌'} ${n.nombre}: ${numero}`);

      if (io) io.emit('verificar:progreso', {
        negocio_id: n.id,
        nombre:     n.nombre,
        tiene_wa:   tieneWA,
        verificados,
        total:      negocios.length
      });

      await new Promise(r => setTimeout(r, 1500));

    } catch(e) {
      console.error('Error verificando', n.nombre, ':', e.message);
    }
  }

  console.log(`✅ Verificación completa: ${con_wa} con WA, ${sin_wa} sin WA`);
  if (io) io.emit('verificar:completado', { con_wa, sin_wa, total: verificados });
}

module.exports = router;