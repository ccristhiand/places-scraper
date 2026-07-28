const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/config
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM configuracion');
    const config = {};
    rows.forEach(r => config[r.clave] = r.valor);
    
    // Agregar stats del día
    const [[hoy]] = await db.execute(`
      SELECT COUNT(*) as enviados_hoy FROM envios 
      WHERE estado='enviado' AND DATE(enviado_at) = CURDATE()
    `);
    const [[pend]] = await db.execute(`
      SELECT COUNT(*) as pendientes FROM envios WHERE estado='pendiente'
    `);
    
    res.json({ ok: true, config, stats: { enviados_hoy: hoy.enviados_hoy, pendientes: pend.pendientes } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/config
router.put('/', async (req, res) => {
  try {
    const campos = ['delay_entre_mensajes','limite_diario','hora_inicio','hora_fin','envios_activo'];
    for (const clave of campos) {
      if (req.body[clave] !== undefined) {
        await db.execute(
          'INSERT INTO configuracion (clave,valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=?',
          [clave, req.body[clave], req.body[clave]]
        );
      }
    }
    // Notificar al proceso de envíos para que recargue la config
    if (global.io) global.io.emit('config:actualizada', req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;