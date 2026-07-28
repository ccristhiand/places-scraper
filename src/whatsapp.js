const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeInMemoryStore
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const QRCode = require('qrcode');
const path   = require('path');
const fs     = require('fs');
const db     = require('./db');

const AUTH_DIR  = path.join(__dirname, '../.wa_auth');
const STORE_FILE = path.join(__dirname, '../.wa_auth/store.json');

// Store en memoria — mapea LIDs a números reales
const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
try {
  if (fs.existsSync(STORE_FILE)) store.fromJSON(JSON.parse(fs.readFileSync(STORE_FILE)));
} catch(e) {}

// Guardar store cada 30 segundos
setInterval(() => {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store.toJSON())); } catch(e) {}
}, 30000);

let sock              = null;
let io                = null;
let waStatus          = 'desconectado';
let reconnectAttempts = 0;
let lastQR            = null;

// Cache wa_id → negocioId para mensajes enviados desde el panel
const mensajesEnviados = new Map();

function setIO(socketIO) { io = socketIO; }
function getStatus()     { return waStatus; }
function getQR()         { return lastQR; }
function emit(event, data) { if (io) io.emit(event, data); }

function extraerJID(jid) {
  if (!jid) return null;
  return jid.replace('@s.whatsapp.net','').replace('@c.us','').replace('@lid','');
}

// Resolver número real desde LID usando el store
async function resolverNumeroDesdeStore(jid) {
  try {
    // El store guarda contactos con su JID real
    const contacts = store.contacts;
    if (!contacts) return null;

    const jidLimpio = extraerJID(jid);

    // Buscar en contactos del store
    for (const [contactJid, contact] of Object.entries(contacts)) {
      if (contact.lid && extraerJID(contact.lid) === jidLimpio) {
        const num = contactJid.replace('@s.whatsapp.net','').replace('@c.us','');
        console.log('  ✓ Store resolvió LID', jidLimpio, '→', num);
        return num;
      }
    }

    // También intentar con chats del store
    const chats = store.chats;
    if (chats) {
      const chat = chats.get(jid);
      if (chat?.id && !chat.id.endsWith('@lid')) {
        const num = extraerJID(chat.id);
        console.log('  ✓ Store (chats) resolvió LID', jidLimpio, '→', num);
        return num;
      }
    }

    return null;
  } catch(e) {
    return null;
  }
}

async function buscarNegocio(jid, numero) {
  try {
    const jidLimpio = extraerJID(jid);

    // 1. Buscar por wa_jid exacto
    if (jidLimpio) {
      const [r1] = await db.execute(
        'SELECT id, nombre, wa_jid FROM negocios WHERE wa_jid=? LIMIT 1', [jidLimpio]
      );
      if (r1[0]) { console.log('  → Por wa_jid:', r1[0].nombre); return r1[0]; }
    }

    // 2. Buscar por número real
    if (numero && /^[0-9]+$/.test(numero) && numero.length >= 8) {
      const numCorto = numero.startsWith('51') ? numero.slice(2) : numero;
      const numLargo = numero.startsWith('51') ? numero : '51' + numero;
      const [r2] = await db.execute(`
        SELECT id, nombre, wa_jid FROM negocios
        WHERE REPLACE(REPLACE(COALESCE(whatsapp,''),'+',''),' ','')     IN (?,?,?)
           OR REPLACE(REPLACE(COALESCE(telefono_int,''),'+',''),' ','') IN (?,?,?)
           OR REPLACE(REPLACE(COALESCE(telefono,''),'+',''),' ','')     IN (?,?,?)
        LIMIT 1
      `, [numLargo,numCorto,numero, numLargo,numCorto,numero, numLargo,numCorto,numero]);
      if (r2[0]) { console.log('  → Por número:', r2[0].nombre); return r2[0]; }
    }

    console.log('  → Sin negocio para jid:', jid, 'numero:', numero);
    return null;
  } catch(e) {
    console.error('  → Error buscando negocio:', e.message);
    return null;
  }
}

function extraerTexto(msg) {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation)              return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption)     return m.imageMessage.caption || '📷 [imagen]';
  if (m.videoMessage?.caption)     return m.videoMessage.caption || '🎥 [video]';
  if (m.documentMessage?.caption)  return m.documentMessage.caption || '📄 [documento]';
  if (m.documentMessage)           return '📄 [documento]';
  if (m.imageMessage)              return '📷 [imagen]';
  if (m.videoMessage)              return '🎥 [video]';
  if (m.audioMessage)              return '🎵 [audio]';
  if (m.stickerMessage)            return '🎉 [sticker]';
  if (m.reactionMessage)           return (m.reactionMessage.text||'👍') + ' [reacción]';
  if (m.locationMessage)           return '📍 [ubicación]';
  if (m.contactMessage)            return '👤 [contacto]';
  return '[mensaje]';
}

async function connect() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  waStatus = 'conectando';
  emit('wa:status', { status: waStatus });

  sock = makeWASocket({
    version,
    auth:                state,
    logger:              pino({ level: 'silent' }),
    printQRInTerminal:   false,
    browser:             ['Places CRM', 'Chrome', '1.0'],
    connectTimeoutMs:    60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
  });

  // Conectar store al socket — esto hace el mapeo LID → número automáticamente
  store.bind(sock.ev);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      waStatus = 'qr';
      try {
        const qrImg = await QRCode.toDataURL(qr);
        lastQR = qrImg;
        emit('wa:qr', { qr: qrImg });
      } catch(e) {}
      emit('wa:status', { status: 'qr' });
      console.log('📱 QR generado');
    }
    if (connection === 'open') {
      waStatus = 'conectado';
      reconnectAttempts = 0;
      emit('wa:status', { status: 'conectado', numero: sock.user?.id });
      console.log('✅ WhatsApp conectado:', sock.user?.id);
    }
    if (connection === 'close') {
      const code      = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('⚠️ Conexión cerrada. Código:', code);
      if (loggedOut) {
        waStatus = 'desconectado';
        emit('wa:status', { status: 'desconectado' });
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        reconnectAttempts++;
        const delay = Math.min(3000 * reconnectAttempts, 30000);
        console.log('🔄 Reconectando en', delay/1000, 's...');
        waStatus = 'conectando';
        emit('wa:status', { status: 'conectando' });
        setTimeout(connect, delay);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (jid.endsWith('@g.us')) continue;
        if (isJidBroadcast(jid))  continue;
        if (!msg.message)         continue;

        const esMio     = !!msg.key.fromMe;
        const jidLimpio = extraerJID(jid);

        // Obtener número real
        let numero = null;
        if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
          numero = jidLimpio;
        } else if (jid.endsWith('@lid')) {
          if (!esMio && msg.key.senderPn) {
            // Entrante: senderPn tiene el número real
            numero = msg.key.senderPn.replace('@s.whatsapp.net','').replace(/[^0-9]/g,'');
            console.log('  ✓ senderPn:', numero);
          } else {
            // Saliente o sin senderPn: intentar resolver via store
            const resuelto = await resolverNumeroDesdeStore(jid);
            if (resuelto) numero = resuelto;
          }
        }

        const texto = extraerTexto(msg);
        if (!texto) continue;

        console.log((esMio ? '📤 Enviado a' : '📩 Recibido de'), jidLimpio, '('+numero+')', ':', texto.substring(0,50));

        // Deduplicar
        if (msg.key.id) {
          const [[existe]] = await db.execute(
            'SELECT id FROM chat_mensajes WHERE wa_id=? LIMIT 1', [msg.key.id]
          );
          if (existe) { console.log('  ↩ Duplicado'); continue; }
        }

        // Verificar cache wa_id (mensajes enviados desde el panel)
        let negocioIdCache = null;
        if (esMio && msg.key.id && mensajesEnviados.has(msg.key.id)) {
          const cached = mensajesEnviados.get(msg.key.id);
          negocioIdCache = cached.negocioId;
          if (!numero) numero = cached.numero;
          mensajesEnviados.delete(msg.key.id);
          console.log('  ✓ Cache wa_id → negocio', negocioIdCache);
        }

        // Buscar negocio
        let negocio   = null;
        let negocioId = negocioIdCache;

        if (!negocioId) {
          negocio   = await buscarNegocio(jid, numero);
          negocioId = negocio?.id || null;
        } else {
          const [[n]] = await db.execute('SELECT id, nombre, wa_jid FROM negocios WHERE id=?', [negocioId]);
          negocio = n || null;
        }

        const direccion     = esMio ? 'saliente' : 'entrante';
        const identificador = numero || jidLimpio;

        // Guardar wa_jid siempre que sea un LID válido
        // Esto permite que el saliente posterior lo encuentre por wa_jid
        if (negocio && jidLimpio && jid.endsWith('@lid')) {
          if (negocio.wa_jid !== jidLimpio) {
            await db.execute('UPDATE negocios SET wa_jid=? WHERE id=?', [jidLimpio, negocio.id]);
            console.log('  ✓ wa_jid actualizado:', negocio.nombre, '->', jidLimpio);
          }
        } else if (negocio && !negocio.wa_jid && jidLimpio) {
          await db.execute('UPDATE negocios SET wa_jid=? WHERE id=?', [jidLimpio, negocio.id]);
          console.log('  ✓ wa_jid guardado:', negocio.nombre, '->', jidLimpio);
        }

        await db.execute(
          'INSERT INTO chat_mensajes (negocio_id, numero, direccion, contenido, wa_id) VALUES (?,?,?,?,?)',
          [negocioId, identificador, direccion, texto, msg.key.id || null]
        );
        console.log('  ✓ Guardado — negocio:', negocio?.nombre || 'sin asociar ('+identificador+')');

        emit(esMio ? 'wa:mensaje_saliente' : 'wa:mensaje_entrante', {
          jid: jidLimpio, numero: identificador, texto,
          negocioId, negocioNombre: negocio?.nombre || identificador, ts: new Date()
        });

      } catch(e) {
        console.error('  ✗ Error:', e.message);
      }
    }
  });
}

async function enviarMensaje({ numero, texto, imagenPath, negocioId }) {
  if (!sock || waStatus !== 'conectado') throw new Error('WhatsApp no conectado');

  const jid = numero.includes('@') ? numero : numero.replace(/[^0-9]/g,'') + '@s.whatsapp.net';

  let result;
  if (imagenPath && fs.existsSync(imagenPath)) {
    result = await sock.sendMessage(jid, { image: { url: imagenPath }, caption: texto || '' });
  } else {
    result = await sock.sendMessage(jid, { text: texto });
  }

  // Cachear wa_id → negocioId para cuando llegue el evento saliente
  if (result?.key?.id && negocioId) {
    mensajesEnviados.set(result.key.id, {
      negocioId,
      numero: numero.replace(/[^0-9]/g,'')
    });
    if (mensajesEnviados.size > 500) {
      mensajesEnviados.delete(mensajesEnviados.keys().next().value);
    }
  }

  return result;
}

async function desconectar() {
  try { if (sock) await sock.logout(); } catch(_) {}
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  waStatus = 'desconectado';
  sock = null; lastQR = null;
  emit('wa:status', { status: 'desconectado' });
}

module.exports = { connect, enviarMensaje, desconectar, setIO, getStatus, getQR };