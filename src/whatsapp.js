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
let sock             = null;
let io               = null;
let waStatus         = 'desconectado';
let reconnectAttempts = 0;
let lastQR           = null;

function setIO(socketIO) { io = socketIO; }
function getStatus()     { return waStatus; }
function getQR()         { return lastQR; }
function emit(event, data) { if (io) io.emit(event, data); }

function normalizarNumero(tel) {
  if (!tel) return '';
  let n = tel.replace(/[^0-9]/g, '');
  if (n.startsWith('51') && n.length === 11) n = n.slice(2);
  return n;
}

async function buscarNegocioPorNumero(numero) {
  const normalizado = normalizarNumero(numero);
  const con51       = '51' + normalizado;
  const ultimos9    = normalizado.slice(-9);
  try {
    const [rows] = await db.execute(`
      SELECT id, nombre FROM negocios
      WHERE REPLACE(REPLACE(REPLACE(COALESCE(whatsapp,''),'+',''),' ',''),'-','')     IN (?,?,?)
         OR REPLACE(REPLACE(REPLACE(COALESCE(telefono_int,''),'+',''),' ',''),'-','') IN (?,?,?)
         OR REPLACE(REPLACE(REPLACE(COALESCE(telefono,''),'+',''),' ',''),'-','')     IN (?,?,?)
      LIMIT 1
    `, [con51,normalizado,ultimos9, con51,normalizado,ultimos9, con51,normalizado,ultimos9]);
    if (rows[0]) console.log('  → Negocio encontrado:', rows[0].nombre);
    else         console.log('  → Sin negocio para número:', numero, '/ norm:', normalizado);
    return rows[0] || null;
  } catch(e) {
    console.error('  → Error buscando negocio:', e.message);
    return null;
  }
}

// Extraer texto de cualquier tipo de mensaje
function extraerTexto(msg) {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation)                      return m.conversation;
  if (m.extendedTextMessage?.text)         return m.extendedTextMessage.text;
  if (m.imageMessage?.caption)             return m.imageMessage.caption || '📷 [imagen]';
  if (m.videoMessage?.caption)             return m.videoMessage.caption || '🎥 [video]';
  if (m.documentMessage?.caption)          return m.documentMessage.caption || '📄 [documento]';
  if (m.documentMessage)                   return '📄 [documento]';
  if (m.imageMessage)                      return '📷 [imagen]';
  if (m.videoMessage)                      return '🎥 [video]';
  if (m.audioMessage)                      return '🎵 [audio]';
  if (m.stickerMessage)                    return '🎉 [sticker]';
  if (m.reactionMessage)                   return `${m.reactionMessage.text||'👍'} [reacción]`;
  if (m.locationMessage)                   return '📍 [ubicación]';
  if (m.contactMessage)                    return '👤 [contacto]';
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title)        return m.listResponseMessage.title;
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
    auth:                  state,
    logger:                pino({ level: 'silent' }),
    printQRInTerminal:     true,
    browser:               ['Places CRM', 'Chrome', '1.0'],
    connectTimeoutMs:      60000,
    keepAliveIntervalMs:   25000,
    retryRequestDelayMs:   2000,
    // Importante: recibir mensajes propios (enviados desde el celular)
    shouldIgnoreJid:       jid => isJidBroadcast(jid),
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
      console.log(`⚠️ Conexión cerrada. Código: ${code}`);
      if (loggedOut) {
        console.log('❌ Sesión cerrada — escanea QR nuevamente');
        waStatus = 'desconectado';
        emit('wa:status', { status: 'desconectado' });
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        reconnectAttempts++;
        const delay = Math.min(3000 * reconnectAttempts, 30000);
        console.log(`🔄 Reconectando en ${delay/1000}s (intento ${reconnectAttempts})...`);
        waStatus = 'conectando';
        emit('wa:status', { status: 'conectando' });
        setTimeout(connect, delay);
      }
    }
  });

  // ── Todos los mensajes: entrantes Y enviados desde el celular ────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.key.remoteJid) continue;
        if (msg.key.remoteJid.endsWith('@g.us')) continue; // ignorar grupos
        if (isJidBroadcast(msg.key.remoteJid))  continue; // ignorar broadcast
        if (!msg.message)                        continue;

        const esMio = !!msg.key.fromMe;
        const jid   = msg.key.remoteJid;

        // Resolver número real desde el mensaje
        // WA multi-dispositivo puede entregar @lid en vez de @s.whatsapp.net
        let numero = null;

        if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
          // Formato normal — extraer número directo
          numero = jid.replace('@s.whatsapp.net','').replace('@c.us','');
        } else if (jid.endsWith('@lid')) {
          // LID — intentar obtener número real desde los metadatos del mensaje
          numero = msg.verifiedBizAccount ||
                   msg.message?.extendedTextMessage?.contextInfo?.participant?.replace('@s.whatsapp.net','') ||
                   null;

          // Si no hay metadata, buscar en el pushName o notifyName
          if (!numero && msg.pushName) {
            console.log(`  ↩ @lid sin número real, pushName: ${msg.pushName} — guardando con JID`);
            numero = jid; // guardar como fallback para no perder el mensaje
          }

          if (!numero) {
            console.log(`  ↩ @lid sin número resoluble, ignorando: ${jid}`);
            continue;
          }
        } else {
          console.log(`  ↩ JID desconocido ignorado: ${jid}`);
          continue;
        }

        // Limpiar número
        numero = String(numero).replace(/[^0-9]/g, '');
        if (numero.length < 7) { console.log(`  ↩ Número muy corto: ${numero}`); continue; }

        const texto = extraerTexto(msg);

        if (!texto) continue;

        console.log(`${esMio ? '📤 Enviado' : '📩 Recibido'} ${esMio ? 'a' : 'de'} ${numero}: ${texto.substring(0,60)}`);

        // Verificar duplicado por wa_id
        if (msg.key.id) {
          const [[existe]] = await db.execute(
            'SELECT id FROM chat_mensajes WHERE wa_id=? LIMIT 1',
            [msg.key.id]
          );
          if (existe) {
            console.log(`  ↩ Duplicado ignorado`);
            continue;
          }
        }

        // Buscar negocio por número
        const negocio   = await buscarNegocioPorNumero(numero);
        const negocioId = negocio?.id || null;

        const direccion = esMio ? 'saliente' : 'entrante';

        // Guardar en BD
        console.log(`  → Guardando ${direccion} — negocio_id=${negocioId}, numero=${numero}`);
        await db.execute(
          'INSERT INTO chat_mensajes (negocio_id, numero, direccion, contenido, wa_id) VALUES (?,?,?,?,?)',
          [negocioId, numero, direccion, texto, msg.key.id || null]
        );
        console.log(`  ✓ Guardado OK`);

        // Emitir en tiempo real al panel
        if (!esMio) {
          emit('wa:mensaje_entrante', {
            numero,
            texto,
            negocioId,
            negocioNombre: negocio?.nombre || numero,
            ts: new Date()
          });
        } else {
          emit('wa:mensaje_saliente', {
            numero,
            texto,
            negocioId,
            ts: new Date()
          });
        }

      } catch(e) {
        console.error('  ✗ Error procesando mensaje:', e.message);
      }
    }
  });
}

async function enviarMensaje({ numero, texto, imagenPath }) {
  if (!sock || waStatus !== 'conectado') throw new Error('WhatsApp no conectado');
  const jid = numero.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
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
  sock     = null;
  lastQR   = null;
  emit('wa:status', { status: 'desconectado' });
}

module.exports = { connect, enviarMensaje, desconectar, setIO, getStatus, getQR };