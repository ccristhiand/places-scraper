require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
global.io    = io;

const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.static(path.join(__dirname, '../public')));

// Routes
const wa = require('./whatsapp');
wa.setIO(io);

app.use('/api/ubigeo',   require('./routes/ubigeo'));
app.use('/api/negocios', require('./routes/negocios'));
app.use('/api/crm',      require('./routes/crm'));
app.use('/api/campanas', require('./routes/campanas'));
app.use('/api/envios',   require('./routes/envios'));
app.use('/api/demos',    require('./routes/demos'));
app.use('/api/chat',     require('./routes/chat'));

// WhatsApp routes
app.get('/api/wa/status',  (req, res) => res.json({ status: wa.getStatus() }));
app.post('/api/wa/conectar', async (req, res) => {
  try { await wa.connect(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wa/desconectar', async (req, res) => {
  try { await wa.desconectar(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve all views
app.get('/views/:view', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/views', req.params.view + '.html'));
});

// Socket.io
io.on('connection', socket => {
  socket.emit('wa:status', { status: wa.getStatus() });
});

// Scheduler
require('./scheduler').iniciar();

server.listen(PORT, () => {
  console.log(`\n🚀 Places CRM corriendo en http://localhost:${PORT}`);
  console.log('   Ejecuta "npm run setup-db" la primera vez\n');
  // Auto-conectar WhatsApp si hay sesión guardada
  const fs = require('fs');
  const authDir = path.join(__dirname, '../.wa_auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    console.log('🔄 Reconectando WhatsApp con sesión guardada...');
    wa.connect().catch(e => console.error('WA:', e.message));
  }
});
