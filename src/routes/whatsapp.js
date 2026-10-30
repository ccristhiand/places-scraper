// WhatsApp (API oficial de Meta): conexión del número, plantillas y consumo
//   GET  /estado          estado de la conexión + datos públicos para el SDK de Facebook
//   POST /conectar        recibe el "code" de Embedded Signup, lo cambia por el token, suscribe la app
//                         a la cuenta, pide contactos e historial (coexistencia) o registra el número
//   POST /conectar-manual conexión con token permanente de usuario del sistema (avanzado)
//   POST /desconectar     quita la suscripción y borra el token
//   POST /diagnostico     relee el número desde Meta y corrige lo guardado
//   POST /registrar       registra el número en la API (error 133010)
//   GET/POST/DELETE /plantillas, GET/POST /plantillas-sistema, GET /consumo, POST /probar-app
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');
const meta    = require('../meta');
const config  = require('../lib/config');
const P       = require('../lib/plantillas');
const { encrypt, decrypt } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { upload } = require('../lib/uploads');
const { rutaUpload } = require('../lib/mensajeria');
const { ah, HttpError, texto } = require('../lib/utils');

function vistaCuenta(c) {
  return {
    estado: c?.estado || 'desconectado', modo: c?.modo || null,
    numero_display: c?.numero_display || null, nombre_verificado: c?.nombre_verificado || null,
    waba_id: c?.waba_id || null, phone_number_id: c?.phone_number_id || null,
    coexistencia: !!Number(c?.coexistencia), historial_sync: c?.historial_sync || 'no_aplica',
    calidad: c?.calidad || null, webhook_ok: !!Number(c?.webhook_ok),
    conectado_at: c?.conectado_at || null, ultimo_error: c?.ultimo_error || null,
  };
}

async function urlPublica(req) {
  const conf = String(await config.get('meta_public_url') || '').replace(/\/+$/, '');
  return conf || `${req.protocol}://${req.get('host')}`;
}

router.get('/estado', requirePerm('config.ver', 'chat.ver', 'campanas.ver'), ah(async (req, res) => {
  const [c, app] = await Promise.all([meta.cuenta(), meta.app()]);
  const base = await urlPublica(req);
  res.json({
    ok: true,
    cuenta: vistaCuenta(c),
    plataforma: {
      lista: app.lista,
      config_invalido: app.configInvalido,
      // Datos públicos para el SDK de Facebook (el App Secret nunca sale del servidor)
      app_id: app.lista ? app.appId : null,
      config_id: app.lista ? app.configId : null,
      graph_ver: await meta.version(),
      webhook_url: `${base}/api/webhook/meta`,
      webhook_verificado_at: (await db.query("SELECT valor FROM configuracion WHERE clave = 'meta_webhook_ok_at'"))[0][0]?.valor || null,
    },
  });
}));

// ── Conexión ──────────────────────────────────────────────────────────────
async function guardarCuenta(campos) {
  const cols = Object.keys(campos);
  await db.query(`INSERT INTO wa_cuenta (id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`, cols.map(c => campos[c]));
}

async function pedirSincronizacion(phoneId, token, avisos) {
  let historial = 'en_proceso';
  for (const tipo of ['smb_app_state_sync', 'history']) {
    try { await meta.graph('POST', `${phoneId}/smb_app_data`, { token, body: { messaging_product: 'whatsapp', sync_type: tipo } }); }
    catch (e) {
      avisos.push(`No se pudo pedir ${tipo === 'history' ? 'el historial' : 'los contactos'} (Meta solo lo permite en las primeras 24 h): ${e.message}`);
      if (tipo === 'history') historial = 'pendiente';
    }
  }
  return historial;
}

router.post('/conectar', requirePerm('config.editar'), ah(async (req, res) => {
  const app = await meta.app();
  if (!app.lista) throw new HttpError(409, 'Falta configurar la app de Meta (App ID, App Secret y Configuration ID) en Configuración → WhatsApp.');
  const code = String(req.body.code || '').trim();
  if (!code) throw new HttpError(422, 'Falta el código de autorización de Meta.');
  const evento = String(req.body.evento || '');
  let wabaId  = String(req.body.waba_id || '').trim() || null;
  let phoneId = String(req.body.phone_number_id || '').trim() || null;
  const bizId = String(req.body.business_id || '').trim() || null;

  await guardarCuenta({ estado: 'conectando', ultimo_error: null });
  try {
    // 1) Cambiar el code por el token (el code vence en ~30 s: va primero)
    const tok = await meta.graph('GET', 'oauth/access_token', { query: { client_id: app.appId, client_secret: app.secret, code } });
    const token = tok.access_token;
    if (!token) throw new HttpError(422, 'Meta no devolvió el token de acceso.');

    // 2) Si la ventana de Meta no envió los ids, se averiguan con el token
    if (!wabaId) {
      const dbg = await meta.graph('GET', 'debug_token', { query: { input_token: token, access_token: `${app.appId}|${app.secret}` } });
      wabaId = (dbg.data?.granular_scopes || []).find(s => s.scope === 'whatsapp_business_management')?.target_ids?.[0] || null;
    }
    if (!wabaId) throw new HttpError(422, 'No se pudo identificar tu cuenta de WhatsApp Business.');
    if (!phoneId) phoneId = (await meta.graph('GET', `${wabaId}/phone_numbers`, { token })).data?.[0]?.id || null;
    if (!phoneId) throw new HttpError(422, 'Tu cuenta de WhatsApp Business no tiene números.');

    // 3) Datos del número
    const info = await meta.graph('GET', phoneId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type' } });
    const coexistencia = evento === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || info.is_on_biz_app === true;

    // 4) Suscribir la app a la cuenta (sin esto no llegan los avisos del webhook)
    await meta.graph('POST', `${wabaId}/subscribed_apps`, { token });

    // 5) Coexistencia: pedir contactos e historial. Número nuevo: registrarlo con PIN de dos pasos
    const avisos = [];
    let historial = 'no_aplica', pin = null;
    if (coexistencia) historial = await pedirSincronizacion(phoneId, token, avisos);
    else {
      pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try { await meta.graph('POST', `${phoneId}/register`, { token, body: { messaging_product: 'whatsapp', pin } }); }
      catch (e) { pin = null; avisos.push('No se pudo registrar el número (si es el número de prueba de Meta, ignora este aviso: ya viene registrado). Detalle: ' + e.message); }
    }

    await guardarCuenta({
      estado: 'conectado', modo: 'embedded', business_id: bizId, waba_id: wabaId, phone_number_id: phoneId,
      numero_display: info.display_phone_number || null, nombre_verificado: info.verified_name || null,
      access_token: encrypt(token), coexistencia: coexistencia ? 1 : 0, historial_sync: historial,
      calidad: info.quality_rating || null, webhook_ok: 1, conectado_at: new Date(),
      ultimo_error: avisos.length ? avisos.join(' | ').slice(0, 2000) : null,
    });
    meta.invalidarPlantillas();
    await audit(req, 'whatsapp_conectado', { detalle: { numero: info.display_phone_number, coexistencia } });
    res.json({ ok: true, cuenta: vistaCuenta(await meta.cuenta()), avisos, pin });
  } catch (e) {
    await db.query("UPDATE wa_cuenta SET estado='error', ultimo_error=? WHERE id=1 AND estado <> 'conectado'", [String(e.message).slice(0, 1000)]).catch(() => {});
    throw e;
  }
}));

router.post('/conectar-manual', requirePerm('config.editar'), ah(async (req, res) => {
  const phoneId = String(req.body.phone_number_id || '').trim();
  const wabaId  = String(req.body.waba_id || '').trim();
  const token   = String(req.body.token || '').trim();
  if (!/^\d{5,30}$/.test(phoneId) || !/^\d{5,30}$/.test(wabaId)) throw new HttpError(422, 'Phone Number ID y WABA ID deben ser solo números.');
  if (token.length < 20) throw new HttpError(422, 'Pega el token permanente del usuario del sistema.');
  const info = await meta.graph('GET', phoneId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app' } });
  try { await meta.graph('POST', `${wabaId}/subscribed_apps`, { token }); } catch (_) { /* puede requerir permisos extra */ }
  await guardarCuenta({
    estado: 'conectado', modo: 'manual', waba_id: wabaId, phone_number_id: phoneId,
    numero_display: info.display_phone_number || null, nombre_verificado: info.verified_name || null,
    access_token: encrypt(token), coexistencia: info.is_on_biz_app ? 1 : 0, calidad: info.quality_rating || null,
    conectado_at: new Date(), ultimo_error: null,
  });
  meta.invalidarPlantillas();
  await audit(req, 'whatsapp_conectado', { detalle: { numero: info.display_phone_number, modo: 'manual' } });
  res.json({ ok: true, cuenta: vistaCuenta(await meta.cuenta()) });
}));

router.post('/desconectar', requirePerm('config.editar'), ah(async (req, res) => {
  const c = await meta.cuenta();
  if (c.waba_id && c.access_token) {
    try { await meta.graph('DELETE', `${c.waba_id}/subscribed_apps`, { token: decrypt(c.access_token) }); }
    catch (e) { console.warn('[whatsapp] No se pudo quitar la suscripción:', e.message); }
  }
  await db.query("UPDATE wa_cuenta SET estado='desconectado', access_token=NULL, phone_number_id=NULL, ultimo_error=NULL WHERE id=1");
  meta.invalidarPlantillas();
  await audit(req, 'whatsapp_desconectado');
  res.json({ ok: true });
}));

router.post('/diagnostico', requirePerm('config.editar'), ah(async (req, res) => {
  const { token, phoneId, wabaId } = await meta.credenciales();
  const { appId } = await meta.app();
  const avisos = [];
  let info;
  try {
    info = await meta.graph('GET', phoneId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type,status,name_status,code_verification_status,messaging_limit_tier' } });
  } catch {
    info = await meta.graph('GET', phoneId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type' } });
  }
  let suscrito = false;
  try {
    const subs = await meta.graph('GET', `${wabaId}/subscribed_apps`, { token });
    suscrito = (subs.data || []).some(s => !appId || String(s.whatsapp_business_api_data?.id || s.id || '') === String(appId));
    if (!suscrito) {
      await meta.graph('POST', `${wabaId}/subscribed_apps`, { token });
      suscrito = true;
      avisos.push('La app no estaba suscrita a tu cuenta de WhatsApp; se volvió a suscribir.');
    }
  } catch (e) { avisos.push('No se pudo revisar la suscripción del webhook: ' + e.message); }

  const c = await meta.cuenta();
  const coexistencia = info.is_on_biz_app === true || !!Number(c.coexistencia);
  let historial = c.historial_sync || 'no_aplica';
  if (coexistencia && !Number(c.coexistencia)) historial = await pedirSincronizacion(phoneId, token, avisos);

  await guardarCuenta({
    numero_display: info.display_phone_number || c.numero_display, nombre_verificado: info.verified_name || c.nombre_verificado,
    calidad: info.quality_rating || null, coexistencia: coexistencia ? 1 : 0, historial_sync: historial,
    webhook_ok: suscrito ? 1 : 0, ultimo_error: suscrito ? null : c.ultimo_error,
  });
  res.json({ ok: true, diagnostico: {
    numero: info.display_phone_number || null, nombre: info.verified_name || null, coexistencia,
    plataforma: info.platform_type || null, estado_numero: info.status || null, estado_nombre: info.name_status || null,
    verificacion: info.code_verification_status || null, calidad: info.quality_rating || null,
    limite: info.messaging_limit_tier || null, suscrito, avisos,
  } });
}));

router.post('/registrar', requirePerm('config.editar'), ah(async (req, res) => {
  const { token, phoneId } = await meta.credenciales();
  const pinDado = String(req.body?.pin || '').trim();
  if (pinDado && !/^\d{6}$/.test(pinDado)) throw new HttpError(422, 'El PIN debe tener 6 dígitos.');
  const pin = pinDado || String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await meta.graph('POST', `${phoneId}/register`, { token, body: { messaging_product: 'whatsapp', pin } });
  } catch (e) {
    let ayuda = '';
    if (/policy|polic/i.test(e.message)) ayuda = ' Revisa en el Administrador de WhatsApp que la cuenta tenga método de pago, el nombre visible aprobado y sin restricciones.';
    else if (/pin|two.?step|verificaci/i.test(e.message)) ayuda = ' Ese número ya tiene un PIN de verificación en dos pasos: escríbelo y vuelve a intentar.';
    throw new HttpError(422, `Meta no registró el número: ${e.message}.${ayuda}`);
  }
  await db.query('UPDATE wa_cuenta SET ultimo_error = NULL WHERE id = 1');
  await audit(req, 'whatsapp_numero_registrado');
  res.json({ ok: true, pin: pinDado ? null : pin });
}));

// Valida App ID + App Secret contra Meta
router.post('/probar-app', requirePerm('config.editar'), ah(async (req, res) => {
  const app = await meta.app();
  if (!app.appId || !app.secret) throw new HttpError(422, 'Primero guarda el App ID y la clave secreta.');
  const d = await meta.graph('GET', app.appId, { query: { fields: 'id,name', access_token: `${app.appId}|${app.secret}` } });
  res.json({ ok: true, app: d.name, config_id_ok: !!app.configId && !app.configInvalido });
}));

// ── Plantillas ────────────────────────────────────────────────────────────
router.get('/plantillas', requirePerm('campanas.ver', 'chat.enviar'), ah(async (req, res) => {
  res.json({ ok: true, rows: await P.listar() });
}));

router.post('/plantillas', requirePerm('campanas.gestionar'), upload.single('imagen'), ah(async (req, res) => {
  const b = req.body || {};
  const encTipo = ['texto', 'imagen'].includes(b.encabezado_tipo) ? b.encabezado_tipo : 'ninguno';
  if (encTipo === 'imagen' && !req.file) throw new HttpError(422, 'Elige la imagen de ejemplo del encabezado (JPG o PNG).');
  if (req.file && !['image/jpeg', 'image/png'].includes(req.file.mimetype)) throw new HttpError(422, 'Para plantillas, Meta solo acepta imágenes JPG o PNG.');
  const r = await P.crear({
    nombre: b.nombre, categoria: b.categoria, idioma: texto(b.idioma, 20) || 'es',
    cuerpoEtiquetas: b.cuerpo, encabezado: encTipo === 'texto' ? b.encabezado : '', pie: b.pie,
    imagen: req.file ? rutaUpload(`/uploads/${req.file.filename}`) : null,
    boton: { texto: b.boton_texto, url: b.boton_url },
    uso: b.categoria === 'MARKETING' ? 'campana' : 'manual', usuarioId: req.user.id,
  });
  await audit(req, 'plantilla_creada', { entidad: 'plantilla', entidadId: b.nombre });
  res.status(201).json({ ok: true, ...r });
}));

router.delete('/plantillas/:nombre', requirePerm('campanas.gestionar'), ah(async (req, res) => {
  await P.eliminar(String(req.params.nombre));
  await audit(req, 'plantilla_eliminada', { entidad: 'plantilla', entidadId: req.params.nombre });
  res.json({ ok: true });
}));

router.get('/plantillas-sistema', requirePerm('config.ver'), ah(async (req, res) => {
  try { await P.sincronizar(await meta.plantillasMeta()); } catch (_) { /* sin conexión: estado local */ }
  res.json({ ok: true, rows: await P.estadoSistema() });
}));

router.post('/plantillas-sistema', requirePerm('config.editar'), ah(async (req, res) => {
  const usos = req.body.uso ? [String(req.body.uso)] : P.SISTEMA.map(s => s.uso);
  const resultados = [];
  for (const uso of usos) {
    try { resultados.push({ uso, ok: true, ...(await P.crearSistema(uso, req.user.id)) }); }
    catch (e) { resultados.push({ uso, ok: false, error: e.message }); }
  }
  res.json({ ok: true, resultados });
}));

// ── Consumo del mes ───────────────────────────────────────────────────────
router.get('/consumo', requirePerm('config.ver', 'campanas.ver'), ah(async (req, res) => {
  const [filas] = await db.query(`
    SELECT COALESCE(origen, IF(tipo = 'plantilla', 'manual', 'manual')) AS origen, tipo,
           SUM(estado_entrega <> 'fallido' OR estado_entrega IS NULL) AS enviados, SUM(estado_entrega = 'fallido') AS fallidos
    FROM chat_mensajes
    WHERE direccion = 'saliente' AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
    GROUP BY origen, tipo`);
  const porOrigen = {};
  let total = 0, plantillas = 0;
  for (const f of filas) {
    const o = porOrigen[f.origen] = porOrigen[f.origen] || { enviados: 0, fallidos: 0 };
    o.enviados += Number(f.enviados || 0); o.fallidos += Number(f.fallidos || 0);
    total += Number(f.enviados || 0);
    if (f.tipo === 'plantilla') plantillas += Number(f.enviados || 0);
  }
  const alerta = await config.getInt('meta_alerta_mensual');
  res.json({ ok: true, mes: new Date().toISOString().slice(0, 7), total, plantillas, alerta, supera: total >= alerta, por_origen: porOrigen });
}));

module.exports = router;
