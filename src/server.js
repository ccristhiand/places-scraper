require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});
global.io = io;

const PORT = process.env.PORT || 3000;

// CORS para permitir requests desde la landing en otro dominio
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.static(path.join(__dirname, '../public')));

const wa = require('./whatsapp');
wa.setIO(io);

app.use('/api/ubigeo',   require('./routes/ubigeo'));
app.use('/api/negocios', require('./routes/negocios'));
app.use('/api/crm',      require('./routes/crm'));
app.use('/api/campanas', require('./routes/campanas'));
app.use('/api/envios',   require('./routes/envios'));
app.use('/api/demos',    require('./routes/demos'));
app.use('/api/chat',     require('./routes/chat'));
app.use('/api/leads',    require('./routes/leads'));

app.get('/api/wa/status', (req, res) => res.json({ status: wa.getStatus() }));
app.get('/api/wa/qr', (req, res) => {
  const qr = wa.getQR();
  if (!qr) return res.json({ ok: false, msg: 'Sin QR disponible' });
  res.json({ ok: true, qr });
});
app.post('/api/wa/conectar', async (req, res) => {
  try { await wa.connect(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wa/desconectar', async (req, res) => {
  try { await wa.desconectar(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/views/:view', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views', req.params.view + '.html'));
});

io.on('connection', socket => {
  console.log('Cliente conectado:', socket.id);
  socket.emit('wa:status', { status: wa.getStatus() });
  socket.on('disconnect', () => console.log('Cliente desconectado:', socket.id));
});

require('./scheduler').iniciar();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Places CRM corriendo en http://0.0.0.0:${PORT}`);
  const fs = require('fs');
  const authDir = path.join(__dirname, '../.wa_auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    console.log('🔄 Reconectando WhatsApp con sesión guardada...');
    wa.connect().catch(e => console.error('WA error:', e.message));
  }
});