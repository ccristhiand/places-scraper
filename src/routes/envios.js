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

let enviandoAhora = false;

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
    // Stats reales: para cada negocio+campaña contar solo el registro más reciente
    const [[stats]] = await db.execute(`
      SELECT
        SUM(estado='pendiente') as pendientes,
        SUM(estado='enviado')   as enviados,
        SUM(estado='fallido')   as fallidos,
        SUM(estado='leido')     as leidos,
        COUNT(*) as total
      FROM envios
      WHERE id IN (
        SELECT MAX(id) FROM envios GROUP BY negocio_id, campana_id
      )`);
    res.json({ ok: true, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/envios/iniciar
router.post('/iniciar', async (req, res) => {
  if (enviandoAhora) return res.status(400).json({ error: 'Ya hay un envío en curso' });
  const { campana_id, negocio_ids } = req.body;
  if (!campana_id || !negocio_ids?.length) return res.status(400).json({ error: 'Faltan datos' });

  try {
    const [[campana]] = await db.execute('SELECT * FROM campanas WHERE id=?', [campana_id]);
    if (!campana) return res.status(404).json({ error: 'Campaña no encontrada' });

    const aEnviar = [];
    for (const nid of negocio_ids) {
      // Verificar que no se haya enviado ya esta campaña a este negocio
      const [[yaEnviado]] = await db.execute(
        'SELECT id FROM envios WHERE negocio_id=? AND campana_id=? AND estado="enviado" LIMIT 1',
        [nid, campana_id]
      );
      if (yaEnviado) continue; // saltar si ya fue enviado

      const [[n]] = await db.execute('SELECT * FROM negocios WHERE id=?', [nid]);
      if (!n) continue;
      const numero = limpiarNumero(n.whatsapp || n.telefono_int || n.telefono);
      const msg    = procesarVariables(campana.mensaje, n);
      await db.execute(
        'INSERT INTO envios (campana_id,negocio_id,numero,mensaje_final,estado) VALUES (?,?,?,?,?)',
        [campana_id, nid, numero, msg, 'pendiente']
      );
      aEnviar.push(nid);
    }

    if (!aEnviar.length) return res.json({ ok: true, total: 0, msg: 'Todos ya fueron enviados' });
    enviarEnBackground(campana, aEnviar);
    res.json({ ok: true, total: aEnviar.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/envios/reintentar-pendientes
router.post('/reintentar-pendientes', async (req, res) => {
  if (enviandoAhora) return res.status(400).json({ error: 'Ya hay un envío en curso' });

  try {
    // 1. Primero limpiar: marcar como fallido cualquier pendiente duplicado
    //    donde ya existe un enviado para el mismo negocio+campaña
    await db.execute(`
      UPDATE envios SET estado='fallido', error_msg='Duplicado — ya enviado en otro intento'
      WHERE estado='pendiente'
        AND EXISTS (
          SELECT 1 FROM (SELECT id FROM envios e2
            WHERE e2.negocio_id = envios.negocio_id
              AND e2.campana_id = envios.campana_id
              AND e2.estado = 'enviado') tmp
        )
    `);

    // 2. Tomar solo el registro pendiente más reciente por negocio+campaña
    const [pendientes] = await db.execute(`
      SELECT e.*, c.mensaje, c.imagen_url,
             n.nombre, n.whatsapp, n.telefono_int, n.telefono,
             n.distrito, n.provincia, n.departamento
      FROM envios e
      JOIN negocios n  ON n.id = e.negocio_id
      LEFT JOIN campanas c ON c.id = e.campana_id
      WHERE e.estado = 'pendiente'
        AND e.id = (
          SELECT MAX(e3.id) FROM envios e3
          WHERE e3.negocio_id = e.negocio_id
            AND e3.campana_id = e.campana_id
            AND e3.estado = 'pendiente'
        )
      ORDER BY e.id ASC
    `);

    if (!pendientes.length) return res.json({ ok: true, total: 0, msg: 'Sin pendientes reales' });

    reintentarEnBackground(pendientes);
    res.json({ ok: true, total: pendientes.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/envios/limpiar-duplicados — limpieza manual desde el panel
router.post('/limpiar-duplicados', async (req, res) => {
  try {
    // Marcar como fallido los pendientes de negocios que ya fueron enviados
    const [r1] = await db.execute(`
      UPDATE envios SET estado='fallido', error_msg='Duplicado limpiado'
      WHERE estado='pendiente'
        AND EXISTS (
          SELECT 1 FROM (
            SELECT id FROM envios e2
            WHERE e2.negocio_id = envios.negocio_id
              AND e2.campana_id = envios.campana_id
              AND e2.estado = 'enviado'
          ) tmp
        )
    `);
    // Marcar como fallido los pendientes duplicados (dejar solo el más reciente)
    const [r2] = await db.execute(`
      UPDATE envios SET estado='fallido', error_msg='Duplicado limpiado'
      WHERE estado='pendiente'
        AND id NOT IN (
          SELECT MAX(id) FROM envios
          WHERE estado='pendiente'
          GROUP BY negocio_id, campana_id
        )
    `);
    res.json({ ok: true, limpiados: (r1.affectedRows || 0) + (r2.affectedRows || 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      await db.execute('INSERT INTO chat_mensajes (negocio_id,numero,direccion,contenido) VALUES (?,?,?,?)',
        [envio.negocio_id, numero, 'saliente', texto]);
      await db.execute('INSERT INTO crm_historial (negocio_id,tipo,contenido) VALUES (?,?,?)',
        [envio.negocio_id, 'mensaje', `Reenvío: ${envio.nombre || ''}`]);

      if (io) io.emit('envio:progreso', { id: envio.id, estado: 'enviado', nombre: envio.nombre });
      await sleep(DELAY);

    } catch (e) {
      await db.execute('UPDATE envios SET estado="fallido",error_msg=? WHERE id=?', [e.message, envio.id]);
      if (io) io.emit('envio:progreso', { id: envio.id, estado: 'fallido', nombre: envio.nombre, error: e.message });
      await sleep(2000);
    }
  }

  enviandoAhora = false;
  if (io) io.emit('envio:completado', { total: pendientes.length });
}

async function enviarEnBackground(campana, negocio_ids) {
  enviandoAhora = true;
  const io = global.io;
  const imagenPath = campana.imagen_url ? path.join(__dirname, '../../', campana.imagen_url) : null;

  for (const nid of negocio_ids) {
    try {
      const [[envio]] = await db.execute(
        'SELECT e.*,n.nombre FROM envios e JOIN negocios n ON n.id=e.negocio_id WHERE e.negocio_id=? AND e.campana_id=? AND e.estado="pendiente" ORDER BY e.id DESC LIMIT 1',
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
      await db.execute('INSERT INTO chat_mensajes (negocio_id,numero,direccion,contenido) VALUES (?,?,?,?)',
        [nid, envio.numero, 'saliente', envio.mensaje_final]);
      await db.execute('INSERT INTO crm_historial (negocio_id,tipo,contenido) VALUES (?,?,?)',
        [nid, 'mensaje', `Mensaje enviado: ${campana.nombre}`]);

      if (io) io.emit('envio:progreso', { id: envio.id, estado: 'enviado', nombre: envio.nombre });
      await sleep(DELAY);

    } catch (e) {
      const [[envio]] = await db.execute(
        'SELECT id FROM envios WHERE negocio_id=? AND campana_id=? AND estado="pendiente" LIMIT 1',
        [nid, campana.id]
      ).catch(() => [[null]]);
      if (envio) {
        await db.execute('UPDATE envios SET estado="fallido",error_msg=? WHERE id=?', [e.message, envio.id]);
        if (io) io.emit('envio:progreso', { id: envio.id, estado: 'fallido', error: e.message });
      }
      await sleep(2000);
    }
  }

  enviandoAhora = false;
  if (io) io.emit('envio:completado', { total: negocio_ids.length });
}

module.exports = router;