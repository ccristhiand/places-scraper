const db = require('../db');
const { HttpError } = require('./utils');

const lista = v => [].concat(v ?? []).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean);

// Construye el WHERE de contactos a partir de filtros + alcance del usuario
function filtroContactos(q = {}, req, a = 'n') {
  const w = [], v = [];
  const c = col => `${a}.${col}`;

  if (q.q) {
    const s = `%${String(q.q).slice(0, 100)}%`;
    w.push(`(${c('nombre')} LIKE ? OR ${c('telefono')} LIKE ? OR ${c('whatsapp')} LIKE ? OR ${c('direccion')} LIKE ? OR ${c('email')} LIKE ? OR ${c('contacto_nombre')} LIKE ?)`);
    v.push(s, s, s, s, s, s);
  }
  const etapas = lista(q.etapa);
  if (etapas.length) { w.push(`${c('estado_crm')} IN (?)`); v.push(etapas); }
  if (q.dep)   { w.push(`${c('departamento')} = ?`); v.push(q.dep); }
  if (q.prov)  { w.push(`${c('provincia')} = ?`);    v.push(q.prov); }
  if (q.dist)  { w.push(`${c('distrito')} = ?`);     v.push(q.dist); }
  if (q.rubro) { w.push(`${c('rubro_busqueda')} LIKE ?`); v.push(`%${q.rubro}%`); }
  if (q.origen){ w.push(`${c('origen')} = ?`); v.push(q.origen); }
  if (q.etiqueta) { w.push(`FIND_IN_SET(?, ${c('etiquetas')})`); v.push(String(q.etiqueta).toLowerCase()); }
  if (q.rating_min) { w.push(`${c('rating')} >= ?`); v.push(parseFloat(q.rating_min) || 0); }
  if (q.desde) { w.push(`${c('created_at')} >= ?`); v.push(q.desde); }
  if (q.hasta) { w.push(`${c('created_at')} < DATE_ADD(?, INTERVAL 1 DAY)`); v.push(q.hasta); }

  if (q.asignado === 'yo')       { w.push(`${c('asignado_a')} = ?`); v.push(req.user.id); }
  else if (q.asignado === 'sin') { w.push(`${c('asignado_a')} IS NULL`); }
  else if (q.asignado)           { w.push(`${c('asignado_a')} = ?`); v.push(parseInt(q.asignado, 10) || 0); }

  const conNumero = `(COALESCE(${c('whatsapp')},'') <> '' OR COALESCE(${c('telefono_int')},'') <> '' OR COALESCE(${c('telefono')},'') <> '')`;
  switch (q.wa) {
    case 'con_numero': w.push(conNumero); break;
    case 'sin_numero': w.push(`NOT ${conNumero}`); break;
    case 'wa_ok':      w.push(`${c('wa_verificado')} = 1`); break;
    case 'no_wa':      w.push(`${c('wa_verificado')} = 0`); break;
    case 'aptos':      w.push(`${conNumero} AND (${c('wa_verificado')} IS NULL OR ${c('wa_verificado')} = 1)`); break;
    case 'ventana':    w.push(`${c('ultimo_entrante_at')} > NOW() - INTERVAL 24 HOUR`); break;
  }

  // Alcance: sin "ver_todos" solo se ven los contactos propios
  if (!req.user.can('contactos.ver_todos')) { w.push(`${c('asignado_a')} = ?`); v.push(req.user.id); }

  return { where: w.length ? w.join(' AND ') : '1=1', vals: v };
}

async function asegurarAcceso(req, negocioId) {
  const [[r]] = await db.query('SELECT id, asignado_a FROM negocios WHERE id = ?', [negocioId]);
  if (!r) throw new HttpError(404, 'Contacto no encontrado');
  if (!req.user.can('contactos.ver_todos') && r.asignado_a !== req.user.id)
    throw new HttpError(403, 'No tienes acceso a este contacto');
  return r;
}

module.exports = { filtroContactos, asegurarAcceso, lista };
