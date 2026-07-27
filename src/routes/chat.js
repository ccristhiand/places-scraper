const express = require('express');
const router  = express.Router();
const db      = require('../db');
const wa      = require('../whatsapp');
const path    = require('path');

function limpiarNumero(tel) {
  if (!tel) return null;
  const n = tel.replace(/[^0-9]/g, '');
  if (n.length < 8) return null;
  if (n.startsWith('51')) return n;
  if (n.startsWith('9') && n.length === 9) return '51' + n;
  return n;
}

// GET /api/chat — lista de conversaciones (SIEMPRE PRIMERO)
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        n.id,
        n.nombre,
        n.telefono,
        n.distrito,
        MAX(m.created_at) as ultimo_msg,
        SUM(CASE WHEN m.direccion='entrante' AND m.leido=0 THEN 1 ELSE 0 END) as no_leidos,
        (
          SELECT contenido FROM chat_mensajes
          WHERE negocio_id = n.id
          ORDER BY created_at DESC LIMIT 1
        ) as ultimo_texto
      FROM negocios n
      INNER JOIN chat_mensajes m ON m.negocio_id = n.id
      GROUP BY n.id, n.nombre, n.telefono, n.distrito
      ORDER BY ultimo_msg DESC
      LIMIT 100
    `);
    res.json({ ok: true, rows });
  } catch (e) {
    console.error('Error GET /api/chat:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chat/:negocioId — mensajes de un contacto
router.get('/:negocioId', async (req, res) => {
  try {
    const nid = parseInt(req.params.negocioId);
    if (isNaN(nid)) return res.json({ ok: true, msgs: [] });

    // Obtener negocio para saber su número
    const [[negocio]] = await db.execute('SELECT * FROM negocios WHERE id=?', [nid]);
    if (!negocio) return res.json({ ok: true, msgs: [] });

    // Traer mensajes directamente por negocio_id
    const [msgs] = await db.execute(
      'SELECT * FROM chat_mensajes WHERE negocio_id=? ORDER BY created_at ASC',
      [nid]
    );

    // Si tiene número, buscar también mensajes huérfanos y asociarlos
    const numero = limpiarNumero(negocio.whatsapp || negocio.telefono_int || negocio.telefono);
    if (numero) {
      const numCorto = numero.startsWith('51') ? numero.slice(2) : numero;

      // Asociar huérfanos
      await db.execute(`
        UPDATE chat_mensajes SET negocio_id=?
        WHERE negocio_id IS NULL
          AND (
            REPLACE(REPLACE(numero,'+',''),' ','') = ?
            OR REPLACE(REPLACE(numero,'+',''),' ','') = ?
          )
      `, [nid, numero, numCorto]);

      // Si había huérfanos, recargar
      const [msgsActualizados] = await db.execute(
        'SELECT * FROM chat_mensajes WHERE negocio_id=? ORDER BY created_at ASC',
        [nid]
      );

      // Marcar como leídos
      await db.execute(
        'UPDATE chat_mensajes SET leido=1 WHERE negocio_id=? AND direccion="entrante"',
        [nid]
      );

      return res.json({ ok: true, msgs: msgsActualizados });
    }

    // Marcar como leídos
    await db.execute(
      'UPDATE chat_mensajes SET leido=1 WHERE negocio_id=? AND direccion="entrante"',
      [nid]
    );

    res.json({ ok: true, msgs });
  } catch (e) {
    console.error('Error GET /api/chat/:id:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/:negocioId/enviar
router.post('/:negocioId/enviar', async (req, res) => {
  const { texto } = req.body;
  const nid = req.params.negocioId;
  try {
    const [[n]] = await db.execute('SELECT * FROM negocios WHERE id=?', [nid]);
    if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
    const numero = limpiarNumero(n.whatsapp || n.telefono_int || n.telefono);
    if (!numero) return res.status(400).json({ error: 'Sin número de WhatsApp registrado. Agrégalo en Contactos.' });

    await wa.enviarMensaje({ numero, texto });
    await db.execute(
      'INSERT INTO chat_mensajes (negocio_id,numero,direccion,contenido) VALUES (?,?,?,?)',
      [nid, numero, 'saliente', texto]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Error POST /api/chat/enviar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;