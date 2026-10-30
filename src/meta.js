// Cliente de WhatsApp Cloud API (Meta Graph API)
// La app de Meta (App ID, secret, Configuration ID) está en configuracion;
// el número conectado de la empresa (token, WABA, phone id) en wa_cuenta.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const db     = require('./db');
const config = require('./lib/config');
const { decrypt } = require('./lib/crypto');
const { HttpError } = require('./lib/utils');

const GRAPH_BASE = (process.env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');

// Errores de cuenta/credenciales: pausan los envíos
const CODIGOS_FATALES    = new Set([0, 10, 190, 200, 368, 131031, 131042, 133010]);
// Errores temporales: se reintenta más tarde
const CODIGOS_TEMPORALES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

// Mensajes claros para los errores más frecuentes
const AYUDA = {
  131047: 'Este contacto no te escribió en las últimas 24 horas: solo puedes enviarle una plantilla aprobada.',
  131030: 'Con el número de prueba de Meta solo puedes enviar a los destinatarios autorizados en Meta (WhatsApp → Configuración de la API → "Para").',
  133010: 'Tu número no está activo en la API de Meta ("Account not registered"). Ve a WhatsApp → Conexión y pulsa "Registrar número".',
  132012: 'A la plantilla le falta un dato: si tiene imagen de encabezado, elígela antes de enviar.',
  132001: 'La plantilla no existe en ese idioma o todavía no está aprobada por Meta.',
  131026: 'El número no tiene WhatsApp o no puede recibir mensajes.',
  190:    'El token de acceso venció o fue revocado. Vuelve a conectar tu número de WhatsApp.',
};

class MetaError extends Error {
  constructor(msg, code, detalle) {
    super(msg);
    this.code = code;
    this.detalle = detalle;
    this.fatal       = CODIGOS_FATALES.has(code);
    this.temporal    = CODIGOS_TEMPORALES.has(code) || code === undefined;
    this.sinWhatsapp = code === 131026;
    this.ventana     = code === 131047;
  }
}

function errorMeta(d, status) {
  const er = d?.error || {};
  const code = er.code;
  const base = er.error_data?.details || er.error_user_msg || er.message || `Meta respondió ${status}`;
  return new MetaError(AYUDA[code] ? `${AYUDA[code]} (código ${code})` : `${base}${code ? ` (código ${code})` : ''}`, code, er);
}

async function version() {
  const v = await config.get('meta_api_version');
  return /^v\d{2}\.\d$/.test(v || '') ? v : 'v25.0';
}

// Llamada genérica a Graph API
async function graph(method, ruta, { token, query, body, timeout = 15000 } = {}) {
  const url = new URL(`${GRAPH_BASE}/${await version()}/${String(ruta).replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const opts = { method, headers: {}, signal: AbortSignal.timeout(timeout) };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r, d;
  try {
    r = await fetch(url, opts);
    d = await r.json().catch(() => ({}));
  } catch (e) {
    throw new MetaError('No se pudo conectar con Meta: ' + (e.name === 'TimeoutError' ? 'tiempo de espera agotado' : e.message));
  }
  if (!r.ok || d.error) throw errorMeta(d, r.status);
  return d;
}

// ── App de Meta (plataforma) ──────────────────────────────────────────────
async function app() {
  const c = await config.getAll();
  return {
    appId: c.meta_app_id || '',
    secret: c.meta_app_secret || '',
    configId: c.meta_config_id || '',
    verifyToken: c.meta_verify_token || '',
    lista: !!(c.meta_app_id && c.meta_app_secret && c.meta_config_id),
  };
}

// ── Cuenta conectada ──────────────────────────────────────────────────────
async function cuenta() {
  const [[c]] = await db.query('SELECT * FROM wa_cuenta WHERE id = 1');
  return c || { estado: 'desconectado' };
}

async function credenciales() {
  const c = await cuenta();
  if (c.estado !== 'conectado' || !c.access_token || !c.phone_number_id)
    throw new HttpError(409, 'Primero conecta tu número de WhatsApp en WhatsApp → Conexión.', 'META_NO_CONFIG');
  const token = decrypt(c.access_token);
  if (!token) throw new HttpError(409, 'No se pudo leer el token guardado. Vuelve a conectar tu número.', 'META_NO_CONFIG');
  return { token, phoneId: c.phone_number_id, wabaId: c.waba_id };
}

// ── Mensajes ──────────────────────────────────────────────────────────────
async function enviar(to, payload) {
  const c = await credenciales();
  const d = await graph('POST', `${c.phoneId}/messages`, {
    token: c.token, body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
  });
  return { id: d.messages?.[0]?.id || null, waId: d.contacts?.[0]?.wa_id || null };
}

const enviarTexto = (to, body) =>
  enviar(to, { type: 'text', text: { body: String(body).slice(0, 4096), preview_url: /https?:\/\//.test(body) } });

const enviarImagen = (to, mediaId, caption) =>
  enviar(to, { type: 'image', image: { id: mediaId, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) } });

// Meta no acepta saltos de línea, tabulaciones ni más de 4 espacios seguidos en las variables
const limpiarVariable = v => String(v ?? '').replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000);

function enviarPlantilla(to, nombre, idioma, params = [], { headerMediaId, headerTipo } = {}) {
  const components = [];
  if (headerMediaId) {
    const t = (headerTipo || 'IMAGE').toLowerCase();
    components.push({ type: 'header', parameters: [{ type: t, [t]: { id: headerMediaId } }] });
  }
  if (params.length) components.push({ type: 'body', parameters: params.map(p => ({ type: 'text', text: limpiarVariable(p) || '-' })) });
  return enviar(to, { type: 'template', template: { name: nombre, language: { code: idioma || 'es' }, ...(components.length ? { components } : {}) } });
}

async function marcarLeido(messageId) {
  try {
    const c = await credenciales();
    await graph('POST', `${c.phoneId}/messages`, { token: c.token, body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId } });
  } catch (_) { /* no crítico */ }
}

// ── Media ─────────────────────────────────────────────────────────────────
// Imagen para enviar en un mensaje (Meta la conserva 30 días) → media id, cacheado 7 días
const mediaCache = new Map();
async function subirMedia(rutaArchivo, mime) {
  const stat = fs.statSync(rutaArchivo);
  const k = `${rutaArchivo}:${stat.mtimeMs}`;
  const hit = mediaCache.get(k);
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit.id;

  const c = await credenciales();
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  fd.append('file', new Blob([fs.readFileSync(rutaArchivo)], { type: mime }), path.basename(rutaArchivo));
  const r = await fetch(`${GRAPH_BASE}/${await version()}/${c.phoneId}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.token}` }, body: fd, signal: AbortSignal.timeout(60000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw errorMeta(d, r.status);
  mediaCache.set(k, { id: d.id, at: Date.now() });
  return d.id;
}

// Imagen de ejemplo para crear una plantilla (Resumable Upload → "header_handle")
async function subirImagenEjemplo(rutaArchivo, mime) {
  const { appId } = await app();
  if (!appId) throw new HttpError(400, 'Falta el App ID de Meta en Configuración → WhatsApp.');
  const { token } = await credenciales();
  const buf = fs.readFileSync(rutaArchivo);
  const base = `${GRAPH_BASE}/${await version()}`;
  const q = new URLSearchParams({ file_name: path.basename(rutaArchivo), file_length: String(buf.length), file_type: mime, access_token: token });
  let r = await fetch(`${base}/${appId}/uploads?${q}`, { method: 'POST', signal: AbortSignal.timeout(20000) });
  let d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw errorMeta(d, r.status);
  r = await fetch(`${base}/${d.id}`, {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': mime }, body: buf,
  });
  d = await r.json().catch(() => ({}));
  if (!r.ok || !d.h) throw errorMeta(d, r.status);
  return d.h;
}

// Descarga un media entrante (imagen/audio/documento) a uploads/entrantes
async function descargarMedia(mediaId, destinoDir) {
  const c = await credenciales();
  const info = await graph('GET', mediaId, { token: c.token });
  const r = await fetch(info.url, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new MetaError(`No se pudo descargar el archivo (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 16 * 1024 * 1024) throw new MetaError('Archivo demasiado grande');
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf', 'video/mp4': '.mp4' })[String(info.mime_type).split(';')[0]] || '';
  fs.mkdirSync(destinoDir, { recursive: true });
  const nombre = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(destinoDir, nombre), buf);
  return nombre;
}

// ── Plantillas en Meta ────────────────────────────────────────────────────
const variablesDe = texto => [...String(texto || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => parseInt(m[1], 10));

function vistaPlantilla(t) {
  const comp = t.components || [];
  const body   = comp.find(c => c.type === 'BODY');
  const header = comp.find(c => c.type === 'HEADER');
  const footer = comp.find(c => c.type === 'FOOTER');
  return {
    id: t.id, nombre: t.name, idioma: t.language, estado: t.status, categoria: t.category,
    cuerpo: body?.text || '', encabezado: header?.format === 'TEXT' ? header.text : '', pie: footer?.text || '',
    header: header?.format || null,
    variables: [...new Set(variablesDe(body?.text))].length,
    botones: comp.find(c => c.type === 'BUTTONS')?.buttons?.map(b => b.text) || [],
    motivo_rechazo: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
  };
}

// Recorre todas las páginas (si faltara alguna, la sincronización daría por borradas plantillas vigentes)
async function plantillasMeta(nombre) {
  const c = await credenciales();
  if (!c.wabaId) throw new HttpError(409, 'La cuenta conectada no tiene WhatsApp Business Account ID.');
  const query = { fields: 'id,name,language,status,category,components,rejected_reason', limit: '200' };
  if (nombre) query.name = nombre;
  const todas = [];
  for (let pagina = 0; pagina < 25; pagina++) {
    const d = await graph('GET', `${c.wabaId}/message_templates`, { token: c.token, query });
    todas.push(...(d.data || []));
    const after = d.paging?.cursors?.after;
    if (!d.paging?.next || !after) break;
    query.after = after;
  }
  return todas;
}

let cache = null, cacheAt = 0;
async function listarPlantillas({ forzar = false } = {}) {
  if (!forzar && cache && Date.now() - cacheAt < 5 * 60000) return cache;
  cache = (await plantillasMeta()).map(vistaPlantilla);
  cacheAt = Date.now();
  return cache;
}
function invalidarPlantillas() { cache = null; }

function renderPlantilla(cuerpo, params) {
  return String(cuerpo || '').replace(/{{(\d+)}}/g, (m, i) => params[parseInt(i, 10) - 1] ?? m);
}

function verificarFirma(rawBody, firma, appSecret) {
  if (!appSecret || !firma || !rawBody) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(String(firma));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  GRAPH_BASE, MetaError, graph, app, cuenta, credenciales, version,
  enviarTexto, enviarImagen, enviarPlantilla, marcarLeido, limpiarVariable,
  subirMedia, subirImagenEjemplo, descargarMedia,
  variablesDe, vistaPlantilla, plantillasMeta, listarPlantillas, invalidarPlantillas, renderPlantilla, verificarFirma,
};
