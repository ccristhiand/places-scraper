const express = require('express');
const router  = express.Router();
const path    = require('path');
const db      = require('../db');
const wa      = require('../whatsapp');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DELAY = 10000;

function limpiarNumero(tel) {
  if (!tel) return null;
  const n = tel.replace(/[^0-9]/g, '');
  if (n.length < 8) return null;
  if (n.startsWith('51')) return n;
  if (n.startsWith('9') && n.length === 9) return '51' + n;
  return n;
}

function procesarVariables(texto, negocio) {
  return texto
    .replace(/{{nombre}}/gi,       negocio.nombre       || '')
    .replace(/{{telefono}}/gi,     negocio.telefono      || '')
    .replace(/{{distrito}}/gi,     negocio.distrito      || '')
    .replace(/{{provincia}}/gi,    negocio.provincia     || '')
    .replace(/{{departamento}}/gi, negocio.departamento  || '');
}

// Al iniciar el servidor limpiar cualquier pendiente trabado
// (si el proceso anterior se cayó, los pendientes quedan huérfanos)
let enviandoAhora = false;

async function resetPendientesTrabados() {
  try {
    // Pendientes de más de 2 horas se consideran trabados
    await db.execute(`
      UPDATE envios SET estado='fallido', error_msg='Proceso interrumpido — reintenta'
      WHERE estado='pendiente'
        AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)
    `);
  } catch(e) { /* ignorar */ }
}
setTimeout(resetPendientesTrabados, 3000);

// GET /api/envios
router.get('/', async (req, res) => {
  try {
    const { campana_id, estado, limit = 200 } = req.query;
    const where = ['1=1'], vals = [];
    if (campana_id) { where.push('e.campana_id=?'); vals.push(campana_id); }
    if (estado)     { where.push('e.estado=?');     vals.push(estado); }
    const [rows] = await db.execute(`
      SELECT e.*, n.nombre, n.telefono, n.distrito, c.nombre as campana_nombre
      FROM envios e
      JOIN negocios n ON n.id=e.negocio_id
      LEFT JOIN campanas c ON c.id=e.campana_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC LIMIT ${+limit}`, vals);
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/envios/stats
router.get('/stats', async (req, res) => {
  try {
    const [[stats]] = await db.execute(`
      SELECT
        SUM(estado='pendiente') as pendientes,
        SUM(estado='enviado')   as enviados,
        SUM(estado='fallido')   as fallidos,
        COUNT(*)                as total
      FROM envios
    `);
    res.json({ ok: true, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/envios/iniciar
router.post('/iniciar', async (req, res) => {
  if (enviandoAhora) {
    // Forzar reset si llevan más de 30 min
    enviandoAhora = false;
  }

  const { campana_id, negocio_ids } = req.body;
  if (!campana_id || !negocio_ids?.length) return res.status(400).json({ error: 'Faltan datos' });

  try {
    const [[campana]] = await db.execute('SELECT * FROM campanas WHERE id=?', [campana_id]);
    if (!campana) return res.status(404).json({ error: 'Campaña no encontrada' });

    const aEnviar = [];
    for (const nid of negocio_ids) {
      // Saltar si ya fue enviado exitosamente
      const [[yaEnviado]] = await db.execute(
        'SELECT id FROM envios WHERE negocio_id=? AND campana_id=? AND estado="enviado" LIMIT 1',
        [nid, campana_id]
      );
      if (yaEnviado) continue;

      const [[n]] = await db.execute('SELECT * FROM negocios WHERE id=?', [nid]);
      if (!n) continue;

      const numero = limpiarNumero(n.whatsapp || n.telefono_int || n.telefono);
      const msg    = procesarVariables(campana.mensaje, n);

      // Evitar duplicados pendientes
      const [[pendExiste]] = await db.execute(
        'SELECT id FROM envios WHERE negocio_id=? AND campana_id=? AND estado="pendiente" LIMIT 1',
        [nid, campana_id]
      );

      if (!pendExiste) {
        await db.execute(
          'INSERT INTO envios (campana_id,negocio_id,numero,mensaje_final,estado) VALUES (?,?,?,?,?)',
          [campana_id, nid, numero, msg, 'pendiente']
        );
      }
      aEnviar.push(nid);
    }

    if (!aEnviar.length) return res.json({ ok: true, total: 0, msg: 'Todos ya fueron enviados' });

    enviarEnBackground(campana, aEnviar);
    res.json({ ok: true, total: aEnviar.length });
  } catch (e) {
    console.error('Error iniciar envio:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/envios/reintentar-pendientes
router.post('/reintentar-pendientes', async (req, res) => {
  enviandoAhora = false; // reset forzado

  try {
    // Limpiar duplicados: si hay enviado Y pendiente para mismo negocio+campaña, marcar pendiente como fallido
    await db.execute(`
      UPDATE envios e1
      SET e1.estado='fallido', e1.error_msg='Ya enviado en intento anterior'
      WHERE e1.estado='pendiente'
        AND EXISTS (
          SELECT 1 FROM (
            SELECT id FROM envios
            WHERE negocio_id=e1.negocio_id
              AND campana_id=e1.campana_id
              AND estado='enviado'
          ) tmp
        )
    `);

    // Tomar pendientes reales (uno por negocio+campaña, el más reciente)
    const [pendientes] = await db.execute(`
      SELECT e.id, e.numero, e.mensaje_final, e.campana_id, e.negocio_id,
             c.mensaje, c.imagen_url,
             n.nombre, n.whatsapp, n.telefono_int, n.telefono,
             n.distrito, n.provincia, n.departamento
      FROM envios e
      JOIN negocios n ON n.id = e.negocio_id
      LEFT JOIN campanas c ON c.id = e.campana_id
      WHERE e.estado = 'pendiente'
        AND e.id = (
          SELECT MAX(e2.id) FROM envios e2
          WHERE e2.negocio_id = e.negocio_id
            AND e2.campana_id = e.campana_id
            AND e2.estado = 'pendiente'
        )
      ORDER BY e.id ASC
    `);

    if (!pendientes.length) return res.json({ ok: true, total: 0, msg: 'Sin pendientes' });

    reintentarEnBackground(pendientes);
    res.json({ ok: true, total: pendientes.length });
  } catch (e) {
    console.error('Error reintentar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/envios/limpiar-duplicados
router.post('/limpiar-duplicados', async (req, res) => {
  try {
    const [r] = await db.execute(`
      UPDATE envios e1
      SET e1.estado='fallido', e1.error_msg='Duplicado limpiado'
      WHERE e1.estado='pendiente'
        AND EXISTS (
          SELECT 1 FROM (
            SELECT id FROM envios
            WHERE negocio_id=e1.negocio_id
              AND campana_id=e1.campana_id
              AND estado='enviado'
          ) tmp
        )
    `);
    res.json({ ok: true, limpiados: r.affectedRows || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Background workers ────────────────────────────────────────────────────────

async function enviarEnBackground(campana, negocio_ids) {
  enviandoAhora = true;
  const io = global.io;
  const imagenPath = campana.imagen_url ? path.join(__dirname, '../../', campana.imagen_url) : null;

  for (const nid of negocio_ids) {
    try {
      const [[envio]] = await db.execute(
        `SELECT e.*, n.nombre FROM envios e
         JOIN negocios n ON n.id=e.negocio_id
         WHERE e.negocio_id=? AND e.campana_id=? AND e.estado='pendiente'
         ORDER BY e.id DESC LIMIT 1`,
        [nid, campana.id]
      );
      if (!envio) continue;

      if (!envio.numero) {
        await db.execute('UPDATE envios SET estado="fallido",error_msg="Sin número" WHERE id=?', [envio.id]);
        if (io) io.emit('envio:progreso', { id: envio.id, estado: 'fallido', nombre: envio.nombre, error: 'Sin número' });
        continue;
      }

      await wa.enviarMensaje({ numero: envio.numero, texto: envio.mensaje_final, imagenPath });
      await db.execute('UPDATE envios SET estado="enviado",enviado_at=NOW() WHERE id=?', [envio.id]);
      await db.execute(
        'INSERT INTO chat_mensajes (negocio_id,numero,direccion,contenido) VALUES (?,?,?,?)',
        [nid, envio.numero, 'saliente', envio.mensaje_final]
      );
      await db.execute(
        'INSERT INTO crm_historial (negocio_id,tipo,contenido) VALUES (?,?,?)',
        [nid, 'mensaje', `Enviado: ${campana.nombre}`]
      );

      if (io) io.emit('envio:progreso', { id: envio.id, estado: 'enviado', nombre: envio.nombre });
      console.log(`✓ Enviado a ${envio.nombre} (${envio.numero})`);
      await sleep(DELAY);

    } catch (e) {
      console.error(`✗ Error enviando a negocio ${nid}:`, e.message);
      try {
        const [[envio]] = await db.execute(
          'SELECT id FROM envios WHERE negocio_id=? AND campana_id=? AND estado="pendiente" LIMIT 1',
          [nid, campana.id]
        );
        if (envio) {
          await db.execute('UPDATE envios SET estado="fallido",error_msg=? WHERE id=?', [e.message, envio.id]);
          if (io) io.emit('envio:progreso', { id: envio.id, estado: 'fallido', error: e.message });
        }
      } catch(_) {}
      await sleep(2000);
    }
  }

  enviandoAhora = false;
  if (io) io.emit('envio:completado', { total: negocio_ids.length });
  console.log(`✅ Envío completado — ${negocio_ids.length} procesados`);
}

async function reintentarEnBackground(pendientes) {
  enviandoAhora = true;
  const io = global.io;

  for (const envio of pendientes) {
    try {
      const numero = envio.numero || limpiarNumero(envio.whatsapp || envio.telefono_int || envio.telefono);
      if (!numero) {
        await db.execute('UPDATE envios SET estado="fallido",error_msg="Sin número" WHERE id=?', [envio.id]);
        if (io) io.emit('envio:progreso', { id: envio.id, estado: 'fallido', nombre: envio.nombre, error: 'Sin número' });
        continue;
      }

      const imagenPath = envio.imagen_url ? path.join(__dirname, '../../', envio.imagen_url) : null;
      const texto = envio.mensaje_final || procesarVariables(envio.mensaje || '', envio);

      await wa.enviarMensaje({ numero, texto, imagenPath });
      await db.execute('UPDATE envios SET estado="enviado",enviado_at=NOW() WHERE id=?', [envio.id]);
      await db.execute(
        'INSERT INTO chat_mensajes (negocio_id,numero,direccion,contenido) VALUES (?,?,?,?)',
        [envio.negocio_id, numero, 'saliente', texto]
      );

      if (io) io.emit('envio:progreso', { id: envio.id, estado: 'enviado', nombre: envio.nombre });
      console.log(`✓ Reintento enviado a ${envio.nombre}`);
      await sleep(DELAY);

    } catch (e) {
      console.error(`✗ Error reintentando ${envio.nombre}:`, e.message);
      await db.execute('UPDATE envios SET estado="fallido",error_msg=? WHERE id=?', [e.message, envio.id]);
      if (io) io.emit('envio:progreso', { id: envio.id, estado: 'fallido', nombre: envio.nombre, error: e.message });
      await sleep(2000);
    }
  }

  enviandoAhora = false;
  if (io) io.emit('envio:completado', { total: pendientes.length });
}

module.exports = router;