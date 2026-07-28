const express = require('express');
const router  = express.Router();
const db      = require('../db');
const wa      = require('../whatsapp');

function limpiarNumero(tel) {
  if (!tel) return null;
  const n = tel.replace(/[^0-9]/g, '');
  if (n.length < 8) return null;
  if (n.startsWith('51')) return n;
  if (n.startsWith('9') && n.length === 9) return '51' + n;
  return n;
}

// GET /api/chat — lista de conversaciones
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        n.id, n.nombre, n.telefono, n.distrito, n.wa_jid,
        MAX(m.created_at) AS ultimo_msg,
        SUM(CASE WHEN m.direccion='entrante' AND m.leido=0 THEN 1 ELSE 0 END) AS no_leidos,
        SUBSTRING((
          SELECT contenido FROM chat_mensajes
          WHERE negocio_id = n.id
          ORDER BY created_at DESC LIMIT 1
        ), 1, 60) AS ultimo_texto
      FROM chat_mensajes m
      JOIN negocios n ON n.id = m.negocio_id
      WHERE m.negocio_id IS NOT NULL
      GROUP BY n.id, n.nombre, n.telefono, n.distrito, n.wa_jid
      ORDER BY ultimo_msg DESC
      LIMIT 100
    `);

    // Huérfanos — mensajes sin negocio asociado
    const [huerfanos] = await db.execute(`
      SELECT
        NULL AS id,
        m.numero AS nombre,
        m.numero AS telefono,
        NULL AS distrito,
        NULL AS wa_jid,
        MAX(m.created_at) AS ultimo_msg,
        SUM(CASE WHEN m.direccion='entrante' AND m.leido=0 THEN 1 ELSE 0 END) AS no_leidos,
        SUBSTRING((
          SELECT contenido FROM chat_mensajes cm2
          WHERE cm2.numero = m.numero AND cm2.negocio_id IS NULL
          ORDER BY cm2.created_at DESC LIMIT 1
        ), 1, 60) AS ultimo_texto
      FROM chat_mensajes m
      WHERE m.negocio_id IS NULL
      GROUP BY m.numero
      ORDER BY ultimo_msg DESC
      LIMIT 20
    `);

    const todos = [...rows, ...huerfanos]
      .sort((a,b) => new Date(b.ultimo_msg) - new Date(a.ultimo_msg));
    res.json({ ok: true, rows: todos });
  } catch(e) {
    console.error('GET /api/chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chat/:negocioId
router.get('/:negocioId', async (req, res) => {
  try {
    const nid = parseInt(req.params.negocioId);
    if (isNaN(nid)) return res.json({ ok: true, msgs: [] });

    const [[negocio]] = await db.execute('SELECT * FROM negocios WHERE id=?', [nid]);
    if (!negocio) return res.json({ ok: true, msgs: [] });

    // Variantes del número para asociar huérfanos
    const numero   = limpiarNumero(negocio.whatsapp || negocio.telefono_int || negocio.telefono);
    const waJid    = negocio.wa_jid;

    if (numero || waJid) {
      const numCorto = numero && numero.startsWith('51') ? numero.slice(2) : numero;
      const numLargo = numero && !numero.startsWith('51') ? '51' + numero : numero;

      // Asociar por número
      if (numero) {
        await db.execute(`
          UPDATE chat_mensajes SET negocio_id=?
          WHERE negocio_id IS NULL
            AND REPLACE(REPLACE(numero,'+',''),' ','') IN (?,?,?)
        `, [nid, numLargo || numero, numCorto || numero, numero]);
      }

      // Asociar por wa_jid (LID)
      if (waJid) {
        await db.execute(`
          UPDATE chat_mensajes SET negocio_id=?
          WHERE negocio_id IS NULL AND numero=?
        `, [nid, waJid]);
      }
    }

    const [msgs] = await db.execute(
      'SELECT * FROM chat_mensajes WHERE negocio_id=? ORDER BY created_at ASC',
      [nid]
    );

    await db.execute(
      'UPDATE chat_mensajes SET leido=1 WHERE negocio_id=? AND direccion="entrante" AND leido=0',
      [nid]
    );

    res.json({ ok: true, msgs });
  } catch(e) {
    console.error('GET /api/chat/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/:negocioId/enviar
router.post('/:negocioId/enviar', async (req, res) => {
  const { texto } = req.body;
  const nid = req.params.negocioId;
  if (!texto?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  try {
    const [[n]] = await db.execute('SELECT * FROM negocios WHERE id=?', [nid]);
    if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Preferir número real sobre wa_jid para envío
    // (enviar al número siempre que sea posible — WA lo resuelve)
    const numero = limpiarNumero(n.whatsapp || n.telefono_int || n.telefono);
    if (!numero) return res.status(400).json({ error: 'Sin número de WhatsApp. Agrégalo en Contactos primero.' });

    await wa.enviarMensaje({ numero, texto, negocioId: +nid });

    // Guardar mensaje — cuando WA entrega el evento "enviado",
    // el whatsapp.js lo captará y guardará con wa_jid automáticamente.
    // Guardamos aquí también para respaldo inmediato en la UI.
    await db.execute(
      'INSERT INTO chat_mensajes (negocio_id, numero, direccion, contenido) VALUES (?,?,?,?)',
      [nid, numero, 'saliente', texto]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('POST /api/chat/enviar error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chat/huerfano/:numero — mensajes de un contacto huérfano
router.get('/huerfano/:numero', async (req, res) => {
  try {
    const numero = decodeURIComponent(req.params.numero);
    const [msgs] = await db.execute(
      'SELECT * FROM chat_mensajes WHERE numero=? ORDER BY created_at ASC',
      [numero]
    );
    await db.execute(
      'UPDATE chat_mensajes SET leido=1 WHERE numero=? AND direccion="entrante" AND leido=0',
      [numero]
    );
    res.json({ ok: true, msgs });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/asociar — asociar número huérfano a negocio manualmente
router.post('/asociar', async (req, res) => {
  const { numero, negocio_id } = req.body;
  if (!numero || !negocio_id) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const [r] = await db.execute(
      'UPDATE chat_mensajes SET negocio_id=? WHERE numero=? AND negocio_id IS NULL',
      [negocio_id, numero]
    );
    // Guardar wa_jid en el negocio
    await db.execute('UPDATE negocios SET wa_jid=? WHERE id=?', [numero, negocio_id]);
    res.json({ ok: true, actualizados: r.affectedRows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;