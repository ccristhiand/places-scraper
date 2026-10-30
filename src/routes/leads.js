const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const config    = require('../lib/config');
const meta      = require('../meta');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { emitir, notificarPermiso } = require('../lib/notificar');
const { ah, HttpError, texto, entero, limpiarNumero } = require('../lib/utils');

// ── Endpoint público (formulario de la landing) ───────────────────────────
const publico = express.Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: 'Demasiados envíos. Intenta más tarde.' },
});

// CORS restringido a los orígenes configurados
publico.use(async (req, res, next) => {
  const permitidos = String(await config.get('leads_origenes') || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.get('Origin');
  if (origin && (permitidos.includes('*') || permitidos.includes(origin))) {
    res.header('Access-Control-Allow-Origin', permitidos.includes('*') ? '*' : origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (origin && !(permitidos.includes('*') || permitidos.includes(origin))) return res.status(403).json({ ok: false, error: 'Origen no permitido' });
  next();
});

publico.post('/', limiter, express.json({ limit: '20kb' }), ah(async (req, res) => {
  const b = req.body || {};
  if (b.website_url || b._gotcha) return res.json({ ok: true }); // honeypot: bot
  const lead = {
    nombre:   texto(b.nombre, 120),
    whatsapp: texto(b.whatsapp, 30),
    clinica:  texto(b.clinica || b.empresa, 150),
    pais:     texto(b.pais, 10),
    email:    texto(b.email, 120),
    plan:     texto(b.plan, 40),
    ciclo:    texto(b.ciclo, 20) || 'Mensual',
    mensaje:  texto(b.mensaje, 2000),
  };
  if (!lead.nombre || !lead.whatsapp || !lead.clinica || !lead.plan)
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  if (!/^[\d\s+()-]{7,30}$/.test(lead.whatsapp)) return res.status(400).json({ ok: false, error: 'WhatsApp inválido' });
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return res.status(400).json({ ok: false, error: 'Email inválido' });

  const [r] = await db.query('INSERT INTO leads_vetclinic SET ?', [lead]);
  emitir('lead:nuevo', { id: r.insertId, nombre: lead.nombre, clinica: lead.clinica, plan: lead.plan });
  await notificarPermiso('leads.ver', { tipo: 'lead', titulo: `Nuevo lead: ${lead.clinica}`, cuerpo: `${lead.nombre} · ${lead.plan}`, enlace: '#/leads' });

  // Alerta por WhatsApp con la plantilla del sistema "crm_alerta_lead" (si Meta la aprobó)
  const num = limpiarNumero(await config.get('leads_alerta_numero'), await config.get('empresa_codigo_pais'));
  if (num) {
    const p = await require('../lib/plantillas').aprobadaPara('alerta_lead').catch(() => null);
    if (p) {
      const valores = { lead: lead.nombre, empresa_lead: lead.clinica, whatsapp: lead.whatsapp, plan: lead.plan };
      meta.enviarPlantilla(num, p.nombre_meta, p.idioma, p.variables.map(k => valores[k] || '-'))
        .catch(e => console.error('Alerta lead WA:', e.message));
    }
  }
  res.json({ ok: true, id: r.insertId });
}));

// ── Gestión interna ───────────────────────────────────────────────────────
const router = express.Router();
const ESTADOS = ['nuevo', 'contactado', 'interesado', 'cerrado', 'descartado'];

router.get('/', requirePerm('leads.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  if (req.query.estado) { w.push('estado = ?'); v.push(req.query.estado); }
  if (req.query.plan)   { w.push('plan = ?');   v.push(req.query.plan); }
  if (req.query.q) { const s = `%${req.query.q}%`; w.push('(nombre LIKE ? OR clinica LIKE ? OR whatsapp LIKE ? OR email LIKE ?)'); v.push(s, s, s, s); }
  const lim = entero(req.query.limit, 50, 1, 500), off = entero(req.query.offset, 0, 0);
  const [rows] = await db.query(`SELECT * FROM leads_vetclinic WHERE ${w.join(' AND ')} ORDER BY fecha_registro DESC LIMIT ? OFFSET ?`, [...v, lim, off]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM leads_vetclinic WHERE ${w.join(' AND ')}`, v);
  const [porEstado] = await db.query('SELECT estado, COUNT(*) AS n FROM leads_vetclinic GROUP BY estado');
  const [planes] = await db.query('SELECT plan, COUNT(*) AS n FROM leads_vetclinic GROUP BY plan ORDER BY n DESC');
  res.json({ ok: true, total, rows, por_estado: porEstado, planes });
}));

router.put('/:id', requirePerm('leads.gestionar'), ah(async (req, res) => {
  const sets = {};
  if (req.body.estado !== undefined) {
    if (!ESTADOS.includes(req.body.estado)) throw new HttpError(400, 'Estado inválido.');
    sets.estado = req.body.estado;
    if (req.body.estado !== 'nuevo') sets.fecha_contacto = new Date();
  }
  if (req.body.notas !== undefined) sets.notas = texto(req.body.notas, 5000);
  if (!Object.keys(sets).length) return res.json({ ok: true });
  await db.query('UPDATE leads_vetclinic SET ? WHERE id = ?', [sets, req.params.id]);
  res.json({ ok: true });
}));

// Convierte el lead en contacto del CRM (para gestionarlo en pipeline y bandeja)
router.post('/:id/convertir', requirePerm('leads.gestionar'), requirePerm('contactos.crear'), ah(async (req, res) => {
  const [[l]] = await db.query('SELECT * FROM leads_vetclinic WHERE id = ?', [req.params.id]);
  if (!l) throw new HttpError(404, 'Lead no encontrado');
  if (l.negocio_id) {
    const [[existe]] = await db.query('SELECT id FROM negocios WHERE id = ?', [l.negocio_id]);
    if (existe) return res.json({ ok: true, negocio_id: l.negocio_id });
  }
  const [[primera]] = await db.query("SELECT clave FROM etapas WHERE tipo = 'abierta' ORDER BY orden LIMIT 1");
  const [r] = await db.query('INSERT INTO negocios SET ?', [{
    place_id: 'lead:' + crypto.randomUUID(), nombre: l.clinica, contacto_nombre: l.nombre,
    whatsapp: limpiarNumero(l.whatsapp, await config.get('empresa_codigo_pais')) || l.whatsapp,
    email: l.email, origen: 'lead', estado_crm: primera?.clave || 'nuevo', asignado_a: req.user.id,
    etiquetas: l.plan ? l.plan.toLowerCase() : null,
  }]);
  const nota = [`Lead del formulario web — plan ${l.plan} (${l.ciclo})`, l.mensaje && `Mensaje: ${l.mensaje}`].filter(Boolean).join('\n');
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?)',
    [r.insertId, 'sistema', nota, req.user.nombre, req.user.id]);
  await db.query("UPDATE leads_vetclinic SET negocio_id = ?, estado = IF(estado = 'nuevo', 'contactado', estado), fecha_contacto = COALESCE(fecha_contacto, NOW()) WHERE id = ?",
    [r.insertId, l.id]);
  await audit(req, 'lead_convertido', { entidad: 'lead', entidadId: l.id, detalle: { negocio_id: r.insertId } });
  res.json({ ok: true, negocio_id: r.insertId });
}));

router.delete('/:id', requirePerm('leads.gestionar'), ah(async (req, res) => {
  await db.query('DELETE FROM leads_vetclinic WHERE id = ?', [req.params.id]);
  await audit(req, 'lead_eliminado', { entidad: 'lead', entidadId: req.params.id });
  res.json({ ok: true });
}));

module.exports = { publico, router };
