const express = require('express');
const router  = express.Router();
const db      = require('../db');
const wa      = require('../whatsapp');

function limpiarNum(tel) {
  if (!tel) return null;
  const n = tel.replace(/[^0-9]/g, '');
  if (n.length < 8) return null;
  if (n.startsWith('51')) return n;
  if (n.startsWith('9') && n.length === 9) return '51' + n;
  return n;
}

// POST /api/leads — desde la landing (público)
router.post('/', async (req, res) => {
  const { nombre, whatsapp, clinica, pais, email, plan, ciclo, mensaje } = req.body;
  if (!nombre || !whatsapp || !clinica || !plan)
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  try {
    const [r] = await db.execute(
      `INSERT INTO leads_vetclinic (nombre, whatsapp, clinica, pais, email, plan, ciclo, mensaje)
       VALUES (?,?,?,?,?,?,?,?)`,
      [nombre, whatsapp, clinica, pais||null, email||null, plan, ciclo||'Mensual', mensaje||null]
    );
    // Notificar en tiempo real al panel
    if (global.io) global.io.emit('lead:nuevo', { id: r.insertId, nombre, clinica, plan });

    // Enviar WA al número de alerta
    const ALERTA_NUM = '51927064045';
    try {
      const wa = require('../whatsapp');
      const paises = {PE:'🇵🇪 Perú',CO:'🇨🇴 Colombia',MX:'🇲🇽 México',AR:'🇦🇷 Argentina',CL:'🇨🇱 Chile',EC:'🇪🇨 Ecuador',BO:'🇧🇴 Bolivia'};
      const msg =
        '🔔 *Nuevo lead recibido en VetNetcodip*\n\n' +
        '👤 *Nombre:* ' + nombre + '\n' +
        '🏥 *Clínica:* ' + clinica + '\n' +
        '📱 *WhatsApp:* ' + whatsapp + '\n' +
        (email ? '✉️ *Email:* ' + email + '\n' : '') +
        '🌎 *País:* ' + (paises[pais] || pais || '—') + '\n' +
        '📦 *Plan:* ' + plan + ' · ' + (ciclo||'Mensual') + '\n' +
        (mensaje ? '💬 *Mensaje:* ' + mensaje + '\n' : '') +
        '\n🕐 ' + new Date().toLocaleString('es-PE', {timeZone:'America/Lima'}) +
        '\n\n_Responde desde el panel: places-scraper.netcodip.com_';
      await wa.enviarMensaje({ numero: ALERTA_NUM, texto: msg });
    } catch(waErr) {
      console.error('Error enviando alerta WA:', waErr.message);
    }
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    console.error('Error guardando lead:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/leads — listar con filtros
router.get('/', async (req, res) => {
  try {
    const { estado, plan, q, limit = 50, offset = 0 } = req.query;
    const where = ['1=1'], vals = [];
    if (estado) { where.push('estado=?');          vals.push(estado); }
    if (plan)   { where.push('plan=?');             vals.push(plan); }
    if (q)      { where.push('(nombre LIKE ? OR clinica LIKE ? OR whatsapp LIKE ?)'); vals.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    const [rows] = await db.execute(
      `SELECT * FROM leads_vetclinic WHERE ${where.join(' AND ')} ORDER BY fecha_registro DESC LIMIT ${+limit} OFFSET ${+offset}`, vals);
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) as total FROM leads_vetclinic WHERE ${where.join(' AND ')}`, vals);
    res.json({ ok: true, total, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leads/stats
router.get('/stats', async (req, res) => {
  try {
    const [[stats]] = await db.execute(`
      SELECT
        COUNT(*) as total,
        SUM(estado='nuevo') as nuevos,
        SUM(estado='contactado') as contactados,
        SUM(estado='interesado') as interesados,
        SUM(estado='cerrado') as cerrados,
        SUM(estado='descartado') as descartados
      FROM leads_vetclinic`);
    const [por_plan] = await db.execute(`SELECT plan, COUNT(*) as total FROM leads_vetclinic GROUP BY plan`);
    res.json({ ok: true, stats, por_plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leads/:id
router.get('/:id', async (req, res) => {
  try {
    const [[lead]] = await db.execute('SELECT * FROM leads_vetclinic WHERE id=?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, lead });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leads/:id — actualizar estado, notas, responsable
router.put('/:id', async (req, res) => {
  const { estado, notas, fecha_contacto } = req.body;
  try {
    const sets = [], vals = [];
    if (estado !== undefined)        { sets.push('estado=?');         vals.push(estado); }
    if (notas !== undefined)         { sets.push('notas=?');          vals.push(notas); }
    if (fecha_contacto !== undefined){ sets.push('fecha_contacto=?'); vals.push(fecha_contacto||null); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await db.execute(`UPDATE leads_vetclinic SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leads/:id/mensaje — enviar WA personalizado
router.post('/:id/mensaje', async (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  try {
    const [[lead]] = await db.execute('SELECT * FROM leads_vetclinic WHERE id=?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
    const numero = limpiarNum(lead.whatsapp);
    if (!numero) return res.status(400).json({ error: 'Número inválido' });
    await wa.enviarMensaje({ numero, texto });
    // Marcar como contactado si era nuevo
    if (lead.estado === 'nuevo') {
      await db.execute('UPDATE leads_vetclinic SET estado="contactado", fecha_contacto=NOW() WHERE id=?', [lead.id]);
    }
    // Guardar en notas
    const nota = `[${new Date().toLocaleString('es-PE')}] WA enviado: ${texto.substring(0,80)}...`;
    await db.execute('UPDATE leads_vetclinic SET notas=CONCAT(COALESCE(notas,""),"\\n",?) WHERE id=?', [nota, lead.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/leads/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM leads_vetclinic WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;