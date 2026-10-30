const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db     = require('../db');
const config = require('./config');
const { HttpError } = require('./utils');

const COOKIE = 'crm_sid';

// Catálogo de permisos agrupado por módulo (la UI de roles se arma con esto)
const PERMISOS = {
  'Panel': {
    'dashboard.ver': 'Ver panel principal',
  },
  'Contactos': {
    'contactos.ver':       'Ver contactos',
    'contactos.ver_todos': 'Ver contactos de todos los vendedores',
    'contactos.crear':     'Crear contactos',
    'contactos.editar':    'Editar contactos y registrar actividad',
    'contactos.eliminar':  'Eliminar contactos',
    'contactos.exportar':  'Exportar contactos (CSV)',
    'contactos.asignar':   'Asignar contactos a vendedores',
  },
  'Pipeline': {
    'pipeline.ver':   'Ver pipeline',
    'pipeline.mover': 'Mover oportunidades entre etapas',
  },
  'Prospección': {
    'prospeccion.buscar': 'Buscar negocios en Google Places e importarlos',
  },
  'Bandeja WhatsApp': {
    'chat.ver':    'Ver conversaciones',
    'chat.enviar': 'Responder y enviar mensajes',
  },
  'Campañas y envíos': {
    'campanas.ver':       'Ver campañas',
    'campanas.gestionar': 'Crear y editar campañas',
    'envios.ver':         'Ver historial de envíos',
    'envios.ejecutar':    'Lanzar, pausar y cancelar envíos masivos',
  },
  'Agenda y tareas': {
    'agenda.ver':       'Ver reuniones',
    'agenda.gestionar': 'Agendar y editar reuniones',
    'tareas.ver':       'Ver tareas',
    'tareas.gestionar': 'Crear y editar tareas',
  },
  'Leads': {
    'leads.ver':       'Ver leads del formulario web',
    'leads.gestionar': 'Gestionar y convertir leads',
  },
  'Reportes': {
    'reportes.ver': 'Ver reportes',
  },
  'Administración': {
    'config.ver':         'Ver configuración',
    'config.editar':      'Editar configuración e integraciones',
    'usuarios.gestionar': 'Gestionar usuarios',
    'roles.gestionar':    'Gestionar roles y permisos',
    'auditoria.ver':      'Ver registro de auditoría',
  },
};
const TODOS = Object.values(PERMISOS).flatMap(g => Object.keys(g));

function parsePermisos(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
    return arr.includes('*') ? new Set(TODOS) : new Set(arr.filter(p => TODOS.includes(p)));
  } catch { return new Set(); }
}

async function cargarUsuario(id) {
  const [[u]] = await db.query(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.activo, u.rol_id, u.token_version,
           u.debe_cambiar_password, u.tema, r.nombre AS rol_nombre, r.permisos
    FROM usuarios u JOIN roles r ON r.id = u.rol_id
    WHERE u.id = ?`, [id]);
  if (!u) return null;
  const permisos = parsePermisos(u.permisos);
  delete u.permisos;
  u.permisos = permisos;
  u.can = p => permisos.has(p);
  return u;
}

async function emitirSesion(res, req, user) {
  const horas = await config.getInt('seguridad_sesion_horas');
  const token = jwt.sign({ uid: user.id, tv: user.token_version }, process.env.JWT_SECRET, { expiresIn: `${horas}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure:   req.secure || process.env.COOKIE_SECURE === '1',
    maxAge:   horas * 3600 * 1000,
    path:     '/',
  });
}

function limpiarSesion(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

const ERRORES_CONEXION = new Set(['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);

async function cargarUsuarioConReintento(id) {
  try { return await cargarUsuario(id); }
  catch (e) {
    if (!ERRORES_CONEXION.has(e.code)) throw e;
    return cargarUsuario(id); // conexión del pool caída: un reintento con otra conexión
  }
}

// Devuelve null solo si el token es inválido o el usuario ya no puede entrar.
// Los errores de base de datos se propagan: no deben cerrar la sesión del usuario.
async function usuarioDesdeToken(token, { conPayload = false } = {}) {
  if (!token) return null;
  let p;
  try { p = jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
  const u = await cargarUsuarioConReintento(p.uid);
  if (!u || !u.activo || u.token_version !== p.tv) return null;
  if (conPayload) u._token = p;
  return u;
}

// Rutas permitidas mientras el usuario debe cambiar su contraseña
const PERMITIDAS_CAMBIO = ['/api/auth/me', '/api/auth/cambiar-password', '/api/auth/logout'];

// Cada cuánto se renueva la cookie mientras el usuario está activo (sesión deslizante)
const RENOVAR_CADA_SEG = 10 * 60;

async function requireAuth(req, res, next) {
  let u;
  try {
    u = await usuarioDesdeToken(req.cookies?.[COOKIE], { conPayload: true });
  } catch (e) {
    console.error(`⚠️ No se pudo validar la sesión (${e.code || e.message}). Se mantiene la sesión.`);
    return res.status(503).json({ error: 'Problema temporal de conexión con la base de datos. Intenta de nuevo.', codigo: 'DB_TEMPORAL' });
  }
  try {
    if (!u) {
      limpiarSesion(res);
      return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.', codigo: 'NO_AUTH' });
    }
    // Sesión deslizante: la duración configurada cuenta desde la última actividad
    if (u._token?.iat && Date.now() / 1000 - u._token.iat > RENOVAR_CADA_SEG) await emitirSesion(res, req, u);
    delete u._token;
    req.user = u;
    if (u.debe_cambiar_password && !PERMITIDAS_CAMBIO.includes(req.originalUrl.split('?')[0]))
      return res.status(403).json({ error: 'Debes cambiar tu contraseña antes de continuar.', codigo: 'CAMBIO_PASSWORD' });
    next();
  } catch (e) { next(e); }
}

// Permite si el usuario tiene AL MENOS uno de los permisos
const requirePerm = (...perms) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'No autenticado'));
  if (perms.some(p => req.user.can(p))) return next();
  next(new HttpError(403, 'No tienes permiso para realizar esta acción.'));
};

// Defensa CSRF: además de SameSite=Strict exigimos un header propio,
// que un sitio externo no puede enviar sin pasar CORS.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') === 'crm') return next();
  res.status(403).json({ error: 'Solicitud rechazada (CSRF)' });
}

async function validarPassword(pass, { email } = {}) {
  const min = await config.getInt('seguridad_password_min');
  if (typeof pass !== 'string' || pass.length < min) throw new HttpError(400, `La contraseña debe tener al menos ${min} caracteres.`);
  if (pass.length > 128) throw new HttpError(400, 'La contraseña es demasiado larga.');
  if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) throw new HttpError(400, 'La contraseña debe combinar letras y números.');
  if (email && pass.toLowerCase().includes(String(email).split('@')[0].toLowerCase()))
    throw new HttpError(400, 'La contraseña no puede contener tu usuario de correo.');
}

const hashPassword = pass => bcrypt.hash(pass, 12);
const verificarPassword = (pass, hash) => bcrypt.compare(String(pass || ''), hash || '');

function passwordTemporal() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const num = '23456789';
  const r = n => require('crypto').randomInt(n);
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[r(abc.length)];
  for (let i = 0; i < 4; i++) s += num[r(num.length)];
  return s;
}

function usuarioPublico(u) {
  return {
    id: u.id, nombre: u.nombre, email: u.email, telefono: u.telefono, tema: u.tema,
    rol: u.rol_nombre, rol_id: u.rol_id, debe_cambiar_password: !!u.debe_cambiar_password,
    permisos: [...u.permisos],
  };
}

module.exports = {
  COOKIE, PERMISOS, TODOS, parsePermisos, cargarUsuario, emitirSesion, limpiarSesion,
  usuarioDesdeToken, requireAuth, requirePerm, csrfGuard, validarPassword,
  hashPassword, verificarPassword, passwordTemporal, usuarioPublico,
};
