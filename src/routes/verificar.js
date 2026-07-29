const express = require('express');
const router  = express.Router();
const db      = require('../db');
const wa      = require('../whatsapp');

let verificandoAhora = false;

// GET /api/verificar/stats
router.get('/stats', async (req, res) => {
  try {
    const [[stats]] = await db.execute(`
      SELECT
        COUNT(*) as total,
        SUM(wa_verificado = 1)     as con_wa,
        SUM(wa_verificado = 0)     as sin_wa,
        SUM(wa_verificado IS NULL) as sin_verificar
      FROM negocios
      WHERE (telefono IS NOT NULL AND telefono != '')
         OR (whatsapp IS NOT NULL AND whatsapp != '')
    `);
    res.json({ ok: true, stats, activo: verificandoAhora });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/verificar/masivo — verificar TODOS los NULL
router.post('/masivo', async (req, res) => {
  if (verificandoAhora) {
    return res.json({ ok: false, msg: 'Ya hay una verificación en curso' });
  }

  try {
    const [negocios] = await db.execute(`
      SELECT id, nombre, telefono, telefono_int, whatsapp
      FROM negocios
      WHERE wa_verificado IS NULL
        AND (
          (telefono IS NOT NULL AND telefono != '')
          OR (whatsapp IS NOT NULL AND whatsapp != '')
        )
      ORDER BY id ASC
    `);

    if (!negocios.length) {
      return res.json({ ok: true, total: 0, msg: 'Todos los contactos ya fueron verificados' });
    }

    res.json({ ok: true, total: negocios.length });
    verificarMasivo(negocios);

  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/verificar/cancelar
router.post('/cancelar', (req, res) => {
  verificandoAhora = false;
  res.json({ ok: true });
});

// POST /api/verificar/lote — verificar IDs específicos
router.post('/lote', async (req, res) => {
  if (verificandoAhora) return res.json({ ok: false, msg: 'Verificación en curso' });

  const { negocio_ids } = req.body;
  if (!negocio_ids?.length) return res.status(400).json({ error: 'Sin IDs' });

  try {
    const placeholders = negocio_ids.map(() => '?').join(',');
    const [negocios] = await db.execute(
      `SELECT id, nombre, telefono, telefono_int, whatsapp FROM negocios WHERE id IN (${placeholders})`,
      negocio_ids
    );

    if (!negocios.length) return res.json({ ok: true, total: 0 });

    res.json({ ok: true, total: negocios.length });
    verificarMasivo(negocios);

  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function verificarMasivo(negocios) {
  verificandoAhora = true;
  const io      = global.io;
  const total   = negocios.length;
  let verificados = 0, con_wa = 0, sin_wa = 0;

  // Emitir inicio
  if (io) io.emit('verificar:inicio', { total });

  for (const n of negocios) {
    if (!verificandoAhora) {
      // Cancelado
      if (io) io.emit('verificar:cancelado', { verificados, con_wa, sin_wa });
      return;
    }

    try {
      const numero   = n.whatsapp || n.telefono_int || n.telefono;
      let tieneWA    = false;

      if (numero) {
        tieneWA = await wa.verificarNumero(numero);
      }

      await db.execute('UPDATE negocios SET wa_verificado=? WHERE id=?', [tieneWA ? 1 : 0, n.id]);

      if (tieneWA) con_wa++; else sin_wa++;
      verificados++;

      console.log(`${tieneWA ? '✅' : '❌'} ${n.nombre}: ${numero}`);

      // Emitir progreso por WebSocket
      if (io) io.emit('verificar:progreso', {
        negocio_id:  n.id,
        nombre:      n.nombre,
        tiene_wa:    tieneWA,
        verificados,
        total,
        con_wa,
        sin_wa,
        porcentaje:  Math.round(verificados / total * 100)
      });

      await new Promise(r => setTimeout(r, 1500)); // 1.5s entre cada verificación

    } catch(e) {
      console.error('Error verificando', n.nombre, ':', e.message);
      verificados++;
      if (io) io.emit('verificar:progreso', {
        negocio_id:  n.id,
        nombre:      n.nombre,
        tiene_wa:    null,
        error:       e.message,
        verificados,
        total,
        con_wa,
        sin_wa,
        porcentaje:  Math.round(verificados / total * 100)
      });
    }
  }

  verificandoAhora = false;
  console.log(`✅ Verificación completa: ${con_wa} con WA, ${sin_wa} sin WA`);
  if (io) io.emit('verificar:completado', { total, con_wa, sin_wa });
}

module.exports = router;