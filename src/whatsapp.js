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
let sock      = null;
let io        = null;
let waStatus  = 'desconectado';
let reconnectAttempts = 0;
let lastQR    = null; // guardar ultimo QR para endpoint HTTP

function setIO(socketIO) { io = socketIO; }
function getStatus() { return waStatus; }
function emit(event, data) { if (io) io.emit(event, data); }

function normalizarNumero(tel) {
  if (!tel) return '';
  let n = tel.replace(/[^0-9]/g, '');
  if (n.startsWith('51') && n.length === 11) n = n.slice(2);
  return n;
}

async function buscarNegocioPorNumero(numero) {
  const normalizado = normalizarNumero(numero); // sin 51, solo 9 digitos
  const con51 = '51' + normalizado;
  const ultimos9 = normalizado.slice(-9);

  try {
    // Buscar con múltiples variantes del número
    const [rows] = await db.execute(`
      SELECT id, nombre FROM negocios
      WHERE REPLACE(REPLACE(REPLACE(COALESCE(whatsapp,''),'+',''),' ',''),'-','') IN (?,?,?)
         OR REPLACE(REPLACE(REPLACE(COALESCE(telefono_int,''),'+',''),' ',''),'-','') IN (?,?,?)
         OR REPLACE(REPLACE(REPLACE(COALESCE(telefono,''),'+',''),' ',''),'-','') IN (?,?,?)
      LIMIT 1
    `, [con51, normalizado, ultimos9,
        con51, normalizado, ultimos9,
        con51, normalizado, ultimos9]);

    if (rows[0]) {
      console.log('  → Negocio encontrado:', rows[0].nombre);
    } else {
      console.log('  → Sin negocio asociado para número:', numero, '/ normalizado:', normalizado);
    }
    return rows[0] || null;
  } catch(e) {
    console.error('  → Error buscando negocio:', e.message);
    return null;
  }
}

async function connect() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waStatus = 'conectando';
  emit('wa:status', { status: waStatus });

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Places CRM', 'Chrome', '1.0'],
    connectTimeoutMs: 60000,
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
      const code    = lastDisconnect?.error?.output?.statusCode;
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

  // ── Mensajes entrantes ───────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Ignorar propios, grupos y broadcast
        if (msg.key.fromMe) continue;
        if (!msg.key.remoteJid) continue;
        if (msg.key.remoteJid.endsWith('@g.us')) continue;
        if (isJidBroadcast(msg.key.remoteJid)) continue;
        if (!msg.message) continue;

        const numero = msg.key.remoteJid.replace('@s.whatsapp.net', '');

        // Extraer contenido
        const texto =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption ||
          msg.message.stickerMessage ? '🎉 [sticker]' :
          msg.message.audioMessage  ? '🎵 [audio]'   :
          msg.message.imageMessage  ? '📷 [imagen]'   :
          msg.message.videoMessage  ? '🎥 [video]'    :
          msg.message.documentMessage ? '📄 [documento]' :
          '[mensaje]';

        console.log(`📩 Entrante de ${numero}: ${texto?.substring(0,50)}`);

        // Buscar negocio
        const negocio = await buscarNegocioPorNumero(numero);
        const negocioId = negocio?.id || null;

        // Verificar duplicado por wa_id
        if (msg.key.id) {
          const [[existe]] = await db.execute(
            'SELECT id FROM chat_mensajes WHERE wa_id=? LIMIT 1',
            [msg.key.id]
          );
          if (existe) {
            console.log(`  ↩ Duplicado ignorado (wa_id: ${msg.key.id})`);
            continue;
          }
        }

        // Guardar siempre, con o sin negocio
        console.log(`  → Intentando guardar en BD: negocio_id=${negocioId}, numero=${numero}`);
        await db.execute(
          'INSERT INTO chat_mensajes (negocio_id, numero, direccion, contenido, wa_id) VALUES (?,?,?,?,?)',
          [negocioId, numero, 'entrante', texto, msg.key.id || null]
        );
        console.log(`  ✓ Guardado OK — negocio: ${negocio?.nombre || 'sin asociar (número '+numero+')'}`);

        // Emitir en tiempo real
        emit('wa:mensaje_entrante', {
          numero,
          texto,
          negocioId,
          negocioNombre: negocio?.nombre || numero,
          ts: new Date()
        });

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
  sock = null;
  emit('wa:status', { status: 'desconectado' });
}

module.exports = { connect, enviarMensaje, desconectar, setIO, getStatus, getQR: () => lastQR };