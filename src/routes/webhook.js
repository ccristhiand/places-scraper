// Webhook de WhatsApp Cloud API
//   GET  → verificación de Meta (hub.challenge)
//   POST → avisos con firma X-Hub-Signature-256 comprobada; cada aviso se guarda en wa_webhook_log
//          y se procesa: mensajes entrantes (bandeja), estados de entrega, estado y categoría de plantillas.
//          Los que fallan se reintentan cada 5 minutos (barrerPendientes).
const express = require('express');
const path    = require('path');
const router  = express.Router();
const db      = require('../db');
const meta    = require('../meta');
const config  = require('../lib/config');
const { ESTADO_DESDE_META } = require('../lib/plantillas');
const { emitir, notificarPermiso } = require('../lib/notificar');
const { UPLOADS } = require('../lib/mensajeria');
const { registrarEntrante, registrarEstado } = require('../lib/entrantes');

const log = (...a) => console.log(new Date().toISOString(), '[webhook]', ...a);

router.get('/', async (req, res) => {
  try {
    const token = await config.get('meta_verify_token');
    if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
      log('Webhook verificado por Meta');
      await db.query(`INSERT INTO configuracion (clave, valor, descripcion) VALUES ('meta_webhook_ok_at', ?, 'Última verificación del webhook')
        ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [new Date().toISOString()]).catch(() => {});
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    log('Verificación rechazada (token incorrecto o sin configurar)');
    res.sendStatus(403);
  } catch (e) { log('Error en verificación:', e.message); res.sendStatus(500); }
});

router.post('/', async (req, res) => {
  const secret = await config.get('meta_app_secret').catch(() => null);
  if (!secret) { log('Aviso recibido pero falta la clave secreta de la app'); return res.sendStatus(503); }
  if (!meta.verificarFirma(req.body, req.get('X-Hub-Signature-256'), secret)) { log('Firma inválida — aviso descartado'); return res.sendStatus(401); }
  res.sendStatus(200); // Meta exige respuesta rápida; se guarda y procesa después

  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      try {
        const [ins] = await db.query(
          'INSERT INTO wa_webhook_log (waba_id, phone_number_id, campo, payload) VALUES (?,?,?,?)',
          [entry.id || null, ch.value?.metadata?.phone_number_id || null, ch.field || null, JSON.stringify({ object: body.object, entry_id: entry.id, change: ch })]);
        await procesarFila(ins.insertId, ch.field, ch.value || {});
      } catch (e) { log('Error guardando aviso:', e.message); }
    }
  }
});

async function procesarFila(id, campo, valor) {
  try {
    await procesarCambio(campo, valor);
    await db.query('UPDATE wa_webhook_log SET procesado = 1, error = NULL WHERE id = ?', [id]);
  } catch (e) {
    await db.query('UPDATE wa_webhook_log SET error = ? WHERE id = ?', [String(e.message).slice(0, 1000), id]).catch(() => {});
    log(`Error procesando aviso #${id}: ${e.message}`);
  }
}

async function procesarCambio(campo, v) {
  if (campo === 'messages') {
    for (const m of v.messages || []) await procesarMensaje(m, v.contacts || []);
    for (const s of v.statuses || []) await procesarEstado(s);
    return;
  }
  if (campo === 'message_template_status_update') {
    const evento = String(v.event || '').toUpperCase();
    const estado = ESTADO_DESDE_META[evento];
    if (!estado) return;
    const motivo = ['rechazada', 'pausada', 'deshabilitada'].includes(estado)
      ? (v.reason && v.reason !== 'NONE' ? String(v.reason) : (v.other_info?.title || null)) : null;
    await db.query(`UPDATE wa_plantillas SET estado = ?, motivo_rechazo = ?, activo = IF(? = 'DELETED', 0, activo)
      WHERE meta_template_id = ? OR (nombre_meta = ? AND idioma = ?)`,
      [estado, motivo ? motivo.slice(0, 255) : null, evento, String(v.message_template_id || ''),
       String(v.message_template_name || ''), String(v.message_template_language || 'es')]);
    meta.invalidarPlantillas();
    log(`Plantilla ${v.message_template_name} → ${estado}`);
    emitir('plantilla:estado', { nombre: v.message_template_name, estado, motivo });
    if (estado !== 'aprobada') {
      // Las campañas que la usan se pausan solas en el procesador; avisar al equipo
      await notificarPermiso('campanas.gestionar', { tipo: 'alerta', titulo: `Plantilla ${v.message_template_name}: ${estado}`, cuerpo: motivo, enlace: '#/whatsapp/plantillas' });
    }
    return;
  }
  if (campo === 'template_category_update') {
    const cat = String(v.new_category || '').toUpperCase();
    if (['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(cat))
      await db.query('UPDATE wa_plantillas SET categoria = ? WHERE meta_template_id = ?', [cat, String(v.message_template_id || '')]);
    return;
  }
  if (campo === 'phone_number_quality_update') {
    await db.query('UPDATE wa_cuenta SET calidad = ? WHERE id = 1', [String(v.current_limit || v.event || '').slice(0, 20) || null]);
    return;
  }
  // account_update, history, smb_* … quedan guardados en el log
}

// Reintento de avisos que fallaron (p. ej. la BD no respondió en ese momento)
async function barrerPendientes() {
  try {
    const [filas] = await db.query(`SELECT id, campo, payload FROM wa_webhook_log
      WHERE procesado = 0 AND recibido_at < NOW() - INTERVAL 1 MINUTE AND recibido_at > NOW() - INTERVAL 3 DAY
      ORDER BY id LIMIT 100`);
    for (const f of filas) {
      let ch = {};
      try { ch = JSON.parse(f.payload).change || {}; } catch { /* payload dañado */ }
      await procesarFila(f.id, f.campo, ch.value || {});
    }
    // El log se conserva 90 días
    await db.query('DELETE FROM wa_webhook_log WHERE recibido_at < NOW() - INTERVAL 90 DAY');
  } catch (e) { log('Error barriendo avisos:', e.message); }
}

function contenidoDe(m) {
  switch (m.type) {
    case 'text':        return { tipo: 'texto', texto: m.text?.body };
    case 'image':       return { tipo: 'imagen', texto: m.image?.caption || '', media: m.image?.id };
    case 'video':       return { tipo: 'video', texto: m.video?.caption || '🎥 Video' };
    case 'audio':       return { tipo: 'audio', texto: '🎵 Audio', media: m.audio?.id };
    case 'document':    return { tipo: 'documento', texto: `📄 ${m.document?.filename || 'Documento'}`, media: m.document?.id };
    case 'sticker':     return { tipo: 'sticker', texto: '🎉 Sticker' };
    case 'location':    return { tipo: 'ubicacion', texto: `📍 ${m.location?.name || ''} https://maps.google.com/?q=${m.location?.latitude},${m.location?.longitude}`.trim() };
    case 'contacts':    return { tipo: 'contacto', texto: `👤 ${m.contacts?.[0]?.name?.formatted_name || 'Contacto'}` };
    case 'button':      return { tipo: 'texto', texto: m.button?.text };
    case 'interactive': return { tipo: 'texto', texto: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title };
    case 'reaction':    return { tipo: 'reaccion', texto: `${m.reaction?.emoji || '👍'} (reacción)` };
    default:            return { tipo: 'otro', texto: `[${m.type || 'mensaje'} no soportado]` };
  }
}

// Mensaje entrante de Meta → registro común (entrantes.js)
async function procesarMensaje(m, contactos) {
  const numero = String(m.from || '').replace(/\D/g, '');
  if (!numero || !m.id) return;
  const { tipo, texto, media } = contenidoDe(m);
  let mediaUrl = null;
  if (media && (tipo === 'imagen' || tipo === 'audio' || tipo === 'documento')) {
    try { mediaUrl = '/uploads/entrantes/' + await meta.descargarMedia(media, path.join(UPLOADS, 'entrantes')); }
    catch (e) { console.error('Descarga media:', e.message); }
  }
  await registrarEntrante({
    numero, jid: numero, perfil: contactos.find(c => c.wa_id === m.from)?.profile?.name, waId: m.id, tipo, texto, mediaUrl,
    ts: m.timestamp ? new Date(parseInt(m.timestamp, 10) * 1000) : new Date(),
  });
}

const MAPA_ESTADO = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };

async function procesarEstado(s) {
  const err = s.errors?.[0];
  await registrarEstado({
    waId: s.id, estado: MAPA_ESTADO[s.status],
    errorMsg: err ? `${err.error_data?.details || err.title || err.message} (código ${err.code})`.slice(0, 500) : null,
    sinWhatsapp: err?.code === 131026,
  });
}

module.exports = router;
module.exports.barrerPendientes = barrerPendientes;
