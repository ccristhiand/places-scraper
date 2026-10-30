const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const db        = require('../db');
const config    = require('../lib/config');
const { audit } = require('../lib/audit');
const { ah, HttpError, texto } = require('../lib/utils');
const A = require('../lib/auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
});

// Hash ficticio para igualar tiempos cuando el usuario no existe
const HASH_FALSO = require('bcryptjs').hashSync('no-existe', 12);

router.post('/login', loginLimiter, ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  const pass  = String(req.body.password || '');
  if (!email || !pass) throw new HttpError(400, 'Ingresa tu correo y contraseña.');
  req.auditEmail = email;

  const [[u]] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
  if (u?.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
    const min = Math.ceil((new Date(u.bloqueado_hasta) - Date.now()) / 60000);
    await audit(req, 'login_bloqueado', { entidad: 'usuario', entidadId: u.id });
    throw new HttpError(429, `Cuenta bloqueada temporalmente por intentos fallidos. Intenta en ${min} min.`);
  }

  const ok = await A.verificarPassword(pass, u?.password_hash || HASH_FALSO);
  if (!u || !ok || !u.activo) {
    if (u) {
      const max = await config.getInt('seguridad_intentos_max');
      const bloqueo = await config.getInt('seguridad_bloqueo_min');
      const intentos = (u.intentos_fallidos || 0) + 1;
      await db.query(
        'UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = IF(? >= ?, NOW() + INTERVAL ? MINUTE, NULL) WHERE id = ?',
        [intentos >= max ? 0 : intentos, intentos, max, bloqueo, u.id]);
    }
    await audit(req, 'login_fallido', { entidad: 'usuario', entidadId: u?.id || null });
    throw new HttpError(401, u && ok && !u.activo ? 'Tu usuario está desactivado. Contacta al administrador.' : 'Correo o contraseña incorrectos.');
  }

  await db.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = NOW() WHERE id = ?', [u.id]);
  const user = await A.cargarUsuario(u.id);
  await A.emitirSesion(res, req, user);
  req.user = user;
  await audit(req, 'login', { entidad: 'usuario', entidadId: u.id });
  res.json({ ok: true, usuario: A.usuarioPublico(user) });
}));

// Público: solo el nombre comercial, para la pantalla de acceso
router.get('/marca', ah(async (req, res) => {
  res.json({ empresa: await config.get('empresa_nombre') });
}));

router.post('/logout', A.csrfGuard, ah(async (req, res) => {
  const u = await A.usuarioDesdeToken(req.cookies?.[A.COOKIE]).catch(() => null);
  if (u) { req.user = u; await audit(req, 'logout', { entidad: 'usuario', entidadId: u.id }); }
  A.limpiarSesion(res);
  res.json({ ok: true });
}));

router.get('/me', A.requireAuth, ah(async (req, res) => {
  const empresa = await config.get('empresa_nombre');
  const moneda  = await config.get('empresa_moneda');
  res.json({ ok: true, usuario: A.usuarioPublico(req.user), empresa, moneda, meta: await config.metaConfigurado() });
}));

router.post('/cambiar-password', A.csrfGuard, A.requireAuth, loginLimiter, ah(async (req, res) => {
  const { actual, nueva } = req.body;
  const [[u]] = await db.query('SELECT password_hash FROM usuarios WHERE id = ?', [req.user.id]);
  if (!(await A.verificarPassword(actual, u.password_hash))) throw new HttpError(400, 'La contraseña actual no es correcta.');
  await A.validarPassword(nueva, { email: req.user.email });
  if (await A.verificarPassword(nueva, u.password_hash)) throw new HttpError(400, 'La nueva contraseña debe ser distinta a la actual.');

  await db.query(
    'UPDATE usuarios SET password_hash = ?, debe_cambiar_password = 0, token_version = token_version + 1, password_cambiado_at = NOW() WHERE id = ?',
    [await A.hashPassword(nueva), req.user.id]);
  const user = await A.cargarUsuario(req.user.id);
  await A.emitirSesion(res, req, user); // las demás sesiones abiertas quedan invalidadas
  await audit(req, 'cambio_password', { entidad: 'usuario', entidadId: req.user.id });
  res.json({ ok: true, usuario: A.usuarioPublico(user) });
}));

router.put('/perfil', A.csrfGuard, A.requireAuth, ah(async (req, res) => {
  const nombre = texto(req.body.nombre, 150);
  if (!nombre) throw new HttpError(400, 'El nombre es obligatorio.');
  const tema = ['auto', 'claro', 'oscuro'].includes(req.body.tema) ? req.body.tema : 'auto';
  await db.query('UPDATE usuarios SET nombre = ?, telefono = ?, tema = ? WHERE id = ?',
    [nombre, texto(req.body.telefono, 30), tema, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
