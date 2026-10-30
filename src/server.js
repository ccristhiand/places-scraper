require('dotenv').config();
require('./lib/env').ensureSecrets();
const express      = require('express');
const http         = require('http');
const path         = require('path');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const { Server }   = require('socket.io');

const { requireAuth, csrfGuard, usuarioDesdeToken, COOKIE } = require('./lib/auth');
const { HttpError } = require('./lib/utils');
const { MetaError } = require('./meta');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

app.set('trust proxy', parseInt(process.env.TRUST_PROXY ?? '1', 10)); // detrás de nginx/PM2
app.disable('x-powered-by');

// SDK de Facebook para Embedded Signup (conectar el número de WhatsApp con Meta)
const FB = ['https://connect.facebook.net', 'https://www.facebook.com', 'https://web.facebook.com', 'https://*.facebook.com'];

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", 'https://connect.facebook.net'],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:', 'https://*.facebook.com', 'https://*.fbcdn.net'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://graph.facebook.com', ...FB],
      frameSrc:   FB,
      fontSrc:    ["'self'", 'data:'],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'", 'https://www.facebook.com'],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === '1' ? [] : null,
    },
  },
  // La ventana de Meta devuelve el resultado con postMessage: necesita conservar el vínculo con esta página
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: process.env.COOKIE_SECURE === '1',
}));

// ── Endpoints públicos (antes de los parsers globales) ────────────────────
// Webhook de Meta: necesita el cuerpo crudo para validar la firma HMAC
app.use('/api/webhook/meta', express.raw({ type: '*/*', limit: '2mb' }), require('./routes/webhook'));

const leads = require('./routes/leads');
// Ruta usada por la landing: POST /api/leads (el resto de /api/leads es privado)
app.use('/api/leads', (req, res, next) => {
  const raiz = req.path === '/' || req.path === '';
  if (raiz && (req.method === 'POST' || req.method === 'OPTIONS')) return leads.publico(req, res, next);
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', apiLimiter);

app.use('/api/auth', require('./routes/auth'));

// ── API privada: sesión + CSRF ────────────────────────────────────────────
app.use('/api', csrfGuard, requireAuth);
app.use('/api/usuarios',  require('./routes/usuarios'));
app.use('/api/roles',     require('./routes/roles'));
app.use('/api/contactos', require('./routes/contactos'));
app.use('/api/crm',       require('./routes/crm'));
app.use('/api/tareas',    require('./routes/tareas'));
app.use('/api/agenda',    require('./routes/agenda'));
app.use('/api/chat',      require('./routes/chat'));
app.use('/api/campanas',  require('./routes/campanas'));
app.use('/api/envios',    require('./routes/envios'));
app.use('/api/whatsapp',  require('./routes/whatsapp'));
app.use('/api/leads',     leads.router);
app.use('/api/config',    require('./routes/config'));
app.use('/api/ubigeo',    require('./routes/ubigeo'));
app.use('/api',           require('./routes/panel'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Archivos subidos: solo con sesión
app.use('/uploads', requireAuth, express.static(path.join(__dirname, '../uploads'), {
  dotfiles: 'deny', index: false,
  setHeaders: res => res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'"),
}));

app.use(express.static(path.join(__dirname, '../public'), { index: 'index.html', extensions: ['html'] }));

// ── Errores ───────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const esMeta = err instanceof MetaError;
  const status = esMeta ? 502 : (err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500));
  if (status >= 500 && !esMeta) console.error(`✗ ${req.method} ${req.originalUrl}:`, err);
  // Los errores de Meta son informativos para el usuario; los internos no se exponen
  const visible = err instanceof HttpError || status < 500 || esMeta;
  res.status(status).json({
    error: visible ? err.message : 'Ocurrió un error interno. Revisa los logs del servidor.',
    codigo: err.codigo,
  });
});

// ── Socket.io autenticado ─────────────────────────────────────────────────
const io = new Server(server, { serveClient: true, cors: { origin: false } });
global.io = io;

io.use(async (socket, next) => {
  const cookies = Object.fromEntries(String(socket.handshake.headers.cookie || '').split(';')
    .map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  let u;
  try { u = await usuarioDesdeToken(cookies[COOKIE]); }
  catch (e) { return next(new Error('temporal')); } // el cliente reintenta solo
  if (!u || u.debe_cambiar_password) return next(new Error('no autorizado'));
  socket.data.user = { id: u.id, nombre: u.nombre };
  next();
});

io.on('connection', socket => {
  socket.join('auth');
  socket.join(`u:${socket.data.user.id}`);
});

// ── Arranque ──────────────────────────────────────────────────────────────
(async () => {
  try {
    await require('./setupDb').migrar({ log: () => {} });
    console.log('✅ Base de datos verificada');
  } catch (e) {
    console.error('❌ No se pudo preparar la base de datos:', e.message);
    process.exit(1);
  }
  require('./scheduler').iniciar();
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`🚀 CRM corriendo en http://localhost:${PORT}`);
  });
})();
