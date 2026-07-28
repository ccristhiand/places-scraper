const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  isJidBroadcast
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const QRCode = require('qrcode');
const path   = require('path');
const fs     = require('fs');
const db     = require('./db');

const AUTH_DIR = path.join(__dirname, '../.wa_auth');
let sock              = null;
let io                = null;
let waStatus          = 'desconectado';
let reconnectAttempts = 0;
let lastQR            = null;

function setIO(socketIO) { io = socketIO; }
function getStatus()     { return waStatus; }
function getQR()         { return lastQR; }
function emit(event, data) { if (io) io.emit(event, data); }

// Extraer JID limpio (número o lid sin sufijo)
function extraerJID(jid) {
  if (!jid) return null;
  return jid.replace('@s.whatsapp.net','').replace('@c.us','').replace('@lid','');
}

// Buscar negocio por número real O por wa_jid (LID guardado)
async function buscarNegocio(jid, numero) {
  try {
    const jidLimpio = extraerJID(jid);

    // 1. Buscar por wa_jid (LID ya conocido)
    if (jidLimpio) {
      const [r1] = await db.execute(
        'SELECT id, nombre, wa_jid FROM negocios WHERE wa_jid=? LIMIT 1',
        [jidLimpio]
      );
      if (r1[0]) { console.log('  → Por wa_jid:', r1[0].nombre); return r1[0]; }
    }

    // 2. Buscar por número real si lo tenemos
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
      if (r2[0]) {
        console.log('  → Por número:', r2[0].nombre);
        return r2[0]; // wa_jid se guarda en el bloque principal
      }
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
  if (m.conversation)                return m.conversation;
  if (m.extendedTextMessage?.text)   return m.extendedTextMessage.text;
  if (m.imageMessage?.caption)       return m.imageMessage.caption || '📷 [imagen]';
  if (m.videoMessage?.caption)       return m.videoMessage.caption || '🎥 [video]';
  if (m.documentMessage?.caption)    return m.documentMessage.caption || '📄 [documento]';
  if (m.documentMessage)             return '📄 [documento]';
  if (m.imageMessage)                return '📷 [imagen]';
  if (m.videoMessage)                return '🎥 [video]';
  if (m.audioMessage)                return '🎵 [audio]';
  if (m.stickerMessage)              return '🎉 [sticker]';
  if (m.reactionMessage)             return (m.reactionMessage.text || '👍') + ' [reacción]';
  if (m.locationMessage)             return '📍 [ubicación]';
  if (m.contactMessage)              return '👤 [contacto]';
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

        // Número real solo si viene en formato estándar
        let numero = null;
        if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
          numero = jidLimpio;
        }

        const texto = extraerTexto(msg);
        if (!texto) continue;

        // ── LOG COMPLETO para debug ──────────────────────────────
        console.log('═══════════════════════════════════════');
        console.log((esMio ? '📤 SALIENTE' : '📩 ENTRANTE'));
        console.log('  jid:          ', jid);
        console.log('  jidLimpio:    ', jidLimpio);
        console.log('  numero:       ', numero);
        console.log('  fromMe:       ', esMio);
        console.log('  pushName:     ', msg.pushName);
        console.log('  notifyName:   ', msg.verifiedBizName);
        console.log('  wa_id:        ', msg.key.id);
        console.log('  participant:  ', msg.key.participant);
        console.log('  texto:        ', texto.substring(0, 60));
        console.log('  msg.key:      ', JSON.stringify(msg.key));
        if (msg.message?.extendedTextMessage?.contextInfo) {
          console.log('  contextInfo:  ', JSON.stringify(msg.message.extendedTextMessage.contextInfo));
        }
        console.log('═══════════════════════════════════════');

        // Deduplicar por wa_id
        if (msg.key.id) {
          const [[existe]] = await db.execute(
            'SELECT id FROM chat_mensajes WHERE wa_id=? LIMIT 1', [msg.key.id]
          );
          if (existe) { console.log('  ↩ Duplicado'); continue; }
        }

        // Buscar negocio — primero por wa_jid, luego por número
        const negocio   = await buscarNegocio(jid, numero);
        const negocioId = negocio?.id || null;
        const direccion = esMio ? 'saliente' : 'entrante';

        // El identificador que guardamos: número real si lo hay, si no el JID limpio
        const identificador = numero || jidLimpio;

        // Guardar wa_jid en el negocio si aún no lo tiene
        // Para mensajes SALIENTES: jidLimpio es el número del DESTINATARIO
        // Para mensajes ENTRANTES: jidLimpio es el número del REMITENTE
        // En ambos casos es el JID del contacto → guardarlo en el negocio
        if (negocio && !negocio.wa_jid && jidLimpio) {
          await db.execute('UPDATE negocios SET wa_jid=? WHERE id=?', [jidLimpio, negocio.id]);
          console.log('  ✓ wa_jid guardado en negocio', negocio.nombre, '→', jidLimpio);
        }

        await db.execute(
          'INSERT INTO chat_mensajes (negocio_id, numero, direccion, contenido, wa_id) VALUES (?,?,?,?,?)',
          [negocioId, identificador, direccion, texto, msg.key.id || null]
        );
        console.log('  ✓ Guardado — negocio:', negocio?.nombre || 'sin asociar ('+identificador+')');

        // Emitir en tiempo real
        emit(esMio ? 'wa:mensaje_saliente' : 'wa:mensaje_entrante', {
          jid: jidLimpio,
          numero: identificador,
          texto,
          negocioId,
          negocioNombre: negocio?.nombre || identificador,
          ts: new Date()
        });

      } catch(e) {
        console.error('  ✗ Error:', e.message);
      }
    }
  });
}

// Enviar mensaje — acepta número real O jid/lid
async function enviarMensaje({ numero, texto, imagenPath }) {
  if (!sock || waStatus !== 'conectado') throw new Error('WhatsApp no conectado');

  let jid;
  // Si tiene @, es un JID completo o lid
  if (numero.includes('@')) {
    jid = numero;
  } else {
    // Número normal → convertir a JID
    jid = numero.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
  }

  if (imagenPath && fs.existsSync(imagenPath)) {
    await sock.sendMessage(jid, { image: { url: imagenPath }, caption: texto || '' });
  } else {
    await sock.sendMessage(jid, { text: texto });
  }
}

async function desconectar() {
  try { if (sock) await sock.logout(); } catch(_) {}
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  waStatus = 'desconectado';
  sock = null; lastQR = null;
  emit('wa:status', { status: 'desconectado' });
}

module.exports = { connect, enviarMensaje, desconectar, setIO, getStatus, getQR };