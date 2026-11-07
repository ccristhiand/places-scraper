// WhatsApp Web (Baileys): conexión por QR o código, mensajes entrantes, estados y envío humanizado.
// La sesión vive en .wa_auth/ (excluida de git). Solo se usa cuando wa_proveedor = 'baileys'.
const fs     = require('fs');
const path   = require('path');
const pino   = require('pino');
const QRCode = require('qrcode');
const B      = require('@whiskeysockets/baileys');
const db     = require('../db');
const config = require('../lib/config');
const { emitir, notificarPermiso } = require('../lib/notificar');
const { HttpError } = require('../lib/utils');

const makeWASocket = B.default;
const AUTH_DIR = path.join(__dirname, '../../.wa_auth');
const UPLOADS  = path.join(__dirname, '../../uploads/entrantes');
const logger   = pino({ level: 'silent' });
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const azar     = (a, b) => a + Math.random() * (b - a);
const log      = (...a) => console.log(new Date().toISOString(), '[whatsapp-qr]', ...a);

// estado: desconectado | conectando | qr | codigo | conectado | bloqueado
const st = { estado: 'desconectado', qr: null, codigo: null, numero: null, nombre: null, conectadoAt: null, ultimoError: null };
let sock = null, intentos = 0, detenido = true, temporizador = null;

class BaileysError extends Error {
  constructor(msg, { temporal = false, fatal = false, sinWhatsapp = false } = {}) {
    super(msg); this.temporal = temporal; this.fatal = fatal; this.sinWhatsapp = sinWhatsapp;
  }
}

function vista() { return { ...st }; }
function publicar() { emitir('baileys:estado', vista()); }
const haySesion = () => fs.existsSync(path.join(AUTH_DIR, 'creds.json'));

function borrarSesion() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) { /* ya no estaba */ }
}

// Un evento grave del número (bloqueo, sesión cerrada) pausa las campañas en curso y avisa al equipo
async function alertaGrave(titulo, motivo) {
  try {
    const [r] = await db.query("UPDATE campanas SET estado = 'pausada', pausada_at = NOW(), ultimo_error = ? WHERE estado = 'enviando'", [motivo.slice(0, 500)]);
    if (r.affectedRows) emitir('campana:estado', { estado: 'pausada', motivo });
    await notificarPermiso('envios.ejecutar', { tipo: 'alerta', titulo, cuerpo: motivo, enlace: '#/whatsapp/conexion' });
  } catch (e) { log('No se pudo pausar campañas:', e.message); }
}

// Fecha de inicio del número actual (para el calentamiento progresivo)
async function registrarNumero(numero) {
  const [[r]] = await db.query("SELECT valor FROM configuracion WHERE clave = 'baileys_numero'");
  if (r?.valor === numero) return;
  for (const [clave, valor] of [['baileys_numero', numero], ['baileys_desde', new Date().toISOString().slice(0, 10)]])
    await db.query('INSERT INTO configuracion (clave, valor, descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, valor, 'Interno: número de WhatsApp QR']);
  log(`Número nuevo ${numero}: comienza el calentamiento`);
}

function programarReconexion() {
  if (detenido) return;
  intentos++;
  const espera = Math.min(5000 * 2 ** (intentos - 1), 5 * 60000);
  log(`Reconectando en ${Math.round(espera / 1000)} s (intento ${intentos})`);
  clearTimeout(temporizador);
  temporizador = setTimeout(() => conectar().catch(e => log('Error al reconectar:', e.message)), espera);
}

async function conectar({ telefono } = {}) {
  if (sock && ['conectado', 'conectando', 'qr', 'codigo'].includes(st.estado)) return vista();
  detenido = false;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await B.fetchLatestBaileysVersion()); } catch (_) { /* usa la versión incluida */ }
  const c = await config.getAll();

  Object.assign(st, { estado: 'conectando', qr: null, codigo: null, ultimoError: null });
  publicar();

  sock = makeWASocket({
    version, logger, printQRInTerminal: false,
    auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger) },
    browser: [String(c.ab_nombre_dispositivo || 'CRM Comercial').slice(0, 40), 'Chrome', '124.0.0'],
    markOnlineOnConnect: c.ab_en_linea === '1',
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000, keepAliveIntervalMs: 25000, retryRequestDelayMs: 2500,
    getMessage: async () => undefined,
  });
  const actual = sock;

  actual.ev.on('creds.update', saveCreds);

  actual.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (actual !== sock) return;
    if (qr && !st.codigo) {
      try { st.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); st.estado = 'qr'; publicar(); } catch (_) { /* QR inválido */ }
    }
    if (connection === 'open') {
      intentos = 0;
      const numero = B.jidNormalizedUser(actual.user?.id || '').split('@')[0];
      Object.assign(st, { estado: 'conectado', qr: null, codigo: null, numero, nombre: actual.user?.name || null, conectadoAt: new Date(), ultimoError: null });
      await registrarNumero(numero).catch(() => {});
      log(`Conectado como ${numero}`);
      publicar();
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      sock = null;
      const R = B.DisconnectReason;
      if (codigo === R.loggedOut) {
        borrarSesion();
        Object.assign(st, { estado: 'desconectado', qr: null, codigo: null, ultimoError: 'La sesión se cerró desde el teléfono. Vuelve a vincular el número.' });
        await alertaGrave('WhatsApp desvinculado', st.ultimoError);
      } else if (codigo === R.forbidden) {
        Object.assign(st, { estado: 'bloqueado', qr: null, ultimoError: 'WhatsApp rechazó la conexión (posible bloqueo del número). Se pausaron las campañas.' });
        detenido = true;
        await alertaGrave('Posible bloqueo de WhatsApp', st.ultimoError);
      } else if (codigo === R.connectionReplaced) {
        Object.assign(st, { estado: 'desconectado', ultimoError: 'Se abrió otra sesión de WhatsApp Web con este número. Vuelve a conectar si quieres usarla aquí.' });
        detenido = true;
      } else if (codigo === R.badSession) {
        borrarSesion();
        Object.assign(st, { estado: 'desconectado', ultimoError: 'La sesión guardada se dañó. Vuelve a vincular el número.' });
        detenido = true;
      } else if (codigo === R.restartRequired) {
        intentos = 0;
        setTimeout(() => conectar().catch(e => log(e.message)), 1000);
      } else if (!state.creds.registered && intentos >= 4) {
        Object.assign(st, { estado: 'desconectado', qr: null, codigo: null, ultimoError: 'El código QR expiró sin escanearse. Pulsa Conectar para generar otro.' });
        detenido = true;
      } else {
        st.estado = 'conectando';
        programarReconexion();
      }
      log(`Conexión cerrada (código ${codigo}) → ${st.estado}`);
      publicar();
    }
  });

  actual.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) procesarEntrante(m).catch(e => log('Mensaje entrante:', e.message));
  });

  actual.ev.on('messages.update', updates => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || update?.status === undefined) continue;
      const estado = { 0: 'fallido', 2: 'enviado', 3: 'entregado', 4: 'leido', 5: 'leido' }[update.status];
      if (estado) require('../lib/entrantes').registrarEstado({ waId: key.id, estado }).catch(e => log('Estado:', e.message));
    }
  });

  // Vinculación con código de 8 caracteres (alternativa al QR)
  if (telefono && !state.creds.registered) {
    await sleep(2500);
    const numero = String(telefono).replace(/\D/g, '');
    try {
      const cod = await actual.requestPairingCode(numero);
      Object.assign(st, { estado: 'codigo', codigo: cod?.match(/.{1,4}/g)?.join('-') || cod, qr: null });
      publicar();
    } catch (e) {
      st.ultimoError = 'No se pudo generar el código de vinculación: ' + e.message;
      publicar();
    }
  }
  return vista();
}

// ── Entrantes ─────────────────────────────────────────────────────────────
function contenido(m) {
  const msg = B.normalizeMessageContent(m.message);
  if (!msg) return null;
  const t = B.getContentType(msg);
  const x = msg[t] || {};
  switch (t) {
    case 'conversation':        return { tipo: 'texto', texto: msg.conversation };
    case 'extendedTextMessage': return { tipo: 'texto', texto: x.text };
    case 'imageMessage':        return { tipo: 'imagen', texto: x.caption || '', media: true };
    case 'videoMessage':        return { tipo: 'video', texto: x.caption || '🎥 Video' };
    case 'audioMessage':        return { tipo: 'audio', texto: '🎵 Audio', media: true };
    case 'documentMessage':     return { tipo: 'documento', texto: `📄 ${x.fileName || 'Documento'}`, media: true };
    case 'stickerMessage':      return { tipo: 'sticker', texto: '🎉 Sticker' };
    case 'locationMessage':     return { tipo: 'ubicacion', texto: `📍 https://maps.google.com/?q=${x.degreesLatitude},${x.degreesLongitude}` };
    case 'contactMessage':      return { tipo: 'contacto', texto: `👤 ${x.displayName || 'Contacto'}` };
    case 'reactionMessage':     return { tipo: 'reaccion', texto: `${x.text || '👍'} (reacción)` };
    case 'buttonsResponseMessage':  return { tipo: 'texto', texto: x.selectedDisplayText };
    case 'listResponseMessage':     return { tipo: 'texto', texto: x.title };
    case 'protocolMessage': case 'senderKeyDistributionMessage': return null;
    default: return { tipo: 'otro', texto: `[${t || 'mensaje'} no soportado]` };
  }
}

async function procesarEntrante(m) {
  const jid = m.key?.remoteJid || '';
  if (!m.message || !jid || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || B.isJidBroadcast(jid) || jid === 'status@broadcast') return;
  const c = contenido(m);
  if (!c) return;
  const id = jid.split('@')[0].split(':')[0];
  // Con identificadores @lid el número real viene en senderPn (si WhatsApp lo comparte)
  const numero = jid.endsWith('@s.whatsapp.net') ? id : (m.key.senderPn ? m.key.senderPn.split('@')[0].split(':')[0] : null);

  if (m.key.fromMe) {
    // Enviado desde el celular (no desde el CRM): se guarda para que la conversación esté completa
    const [[ya]] = await db.query('SELECT id FROM chat_mensajes WHERE wa_id = ? LIMIT 1', [m.key.id]);
    if (ya) return;
    const n = await require('../lib/entrantes').buscarContacto(numero, id);
    if (!n) return;
    await require('../lib/mensajeria').registrarSaliente({ negocioId: n.id, numero: numero || id, tipo: c.tipo, contenido: c.texto || '', waId: m.key.id, origen: 'telefono' });
    return;
  }

  let mediaUrl = null;
  if (c.media) {
    try {
      const buf = await B.downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock?.updateMediaMessage });
      if (buf.length <= 16 * 1024 * 1024) {
        const ext = { imagen: '.jpg', audio: '.ogg', documento: path.extname(m.message?.documentMessage?.fileName || '') || '.bin' }[c.tipo];
        fs.mkdirSync(UPLOADS, { recursive: true });
        const nombre = `${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(UPLOADS, nombre), buf);
        mediaUrl = `/uploads/entrantes/${nombre}`;
      }
    } catch (e) { log('Descarga de archivo:', e.message); }
  }
  await require('../lib/entrantes').registrarEntrante({
    numero, jid: id, perfil: m.pushName || null, waId: m.key.id, tipo: c.tipo, texto: c.texto, mediaUrl,
    ts: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date(),
  });
}

// ── Envío ─────────────────────────────────────────────────────────────────
function exigirConexion() {
  if (!sock || st.estado !== 'conectado')
    throw new HttpError(409, 'WhatsApp (QR) no está conectado. Ve a WhatsApp → Conexión.', 'WA_NO_CONECTADO');
}

// destino: número (51987…) o "lid:XXXX" para contactos que solo tienen identificador @lid
const jidDe = destino => (String(destino).startsWith('lid:') ? `${String(destino).slice(4)}@lid` : `${String(destino).replace(/\D/g, '')}@s.whatsapp.net`);

const cacheExiste = new Map();
async function existe(numero) {
  exigirConexion();
  const n = String(numero).replace(/\D/g, '');
  const hit = cacheExiste.get(n);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.existe;
  const [r] = await sock.onWhatsApp(`${n}@s.whatsapp.net`).catch(() => []);
  const ok = !!r?.exists;
  cacheExiste.set(n, { existe: ok, at: Date.now() });
  return ok;
}

// "escribiendo…" proporcional al largo del texto (entre 1.5 y 15 s, con variación)
async function simularEscritura(jid, texto) {
  const c = await config.getAll();
  if (c.ab_simular_escritura !== '1') return;
  const cps = Math.max(3, parseInt(c.ab_escritura_cps, 10) || 14);
  const ms = Math.min(15000, Math.max(1500, (String(texto || '').length / cps) * 1000)) * azar(0.8, 1.25);
  try {
    await sock.presenceSubscribe(jid);
    await sleep(azar(400, 1200));
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(ms);
    await sock.sendPresenceUpdate('paused', jid);
    await sleep(azar(200, 700));
  } catch (_) { /* la presencia no es crítica */ }
}

function traducir(e) {
  if (e instanceof HttpError || e instanceof BaileysError) return e;
  const msg = String(e?.message || e);
  if (/rate-overlimit|429/i.test(msg)) return new BaileysError('WhatsApp limitó la velocidad de envío. Se reintentará más tarde.', { temporal: true });
  if (/timed out|Connection Closed|connection closed|Socket/i.test(msg)) return new BaileysError(`Conexión inestable con WhatsApp: ${msg}`, { temporal: true });
  return new BaileysError(msg);
}

async function enviarTexto(destino, texto, { escritura = true } = {}) {
  exigirConexion();
  const jid = jidDe(destino);
  try {
    if (escritura) await simularEscritura(jid, texto);
    const r = await sock.sendMessage(jid, { text: String(texto) });
    return { id: r?.key?.id || null };
  } catch (e) { throw traducir(e); }
}

async function enviarImagen(destino, ruta, caption, { escritura = true } = {}) {
  exigirConexion();
  const jid = jidDe(destino);
  try {
    if (escritura) await simularEscritura(jid, caption);
    const r = await sock.sendMessage(jid, { image: fs.readFileSync(ruta), caption: caption || undefined });
    return { id: r?.key?.id || null };
  } catch (e) { throw traducir(e); }
}

async function marcarLeido({ waId, destino }) {
  if (!sock || st.estado !== 'conectado' || !waId) return;
  try { await sock.readMessages([{ remoteJid: jidDe(destino), id: waId, fromMe: false }]); } catch (_) { /* no crítico */ }
}

async function desconectar({ cerrarSesion = true } = {}) {
  detenido = true;
  clearTimeout(temporizador);
  const s = sock;
  sock = null;
  try { if (s && cerrarSesion) await s.logout(); else s?.end(undefined); } catch (_) { /* ya estaba cerrada */ }
  if (cerrarSesion) borrarSesion();
  Object.assign(st, { estado: 'desconectado', qr: null, codigo: null, ultimoError: null });
  publicar();
}

// Al arrancar el servidor: reconecta solo si este proveedor está activo y hay sesión guardada
async function iniciarSiCorresponde() {
  if ((await config.get('wa_proveedor')) !== 'baileys' || !haySesion()) return;
  log('Sesión guardada encontrada: conectando…');
  conectar().catch(e => log('No se pudo conectar:', e.message));
}

module.exports = {
  BaileysError, vista, haySesion, conectar, desconectar, iniciarSiCorresponde, existe, enviarTexto, enviarImagen, marcarLeido,
  conectado: () => !!sock && st.estado === 'conectado',
};
