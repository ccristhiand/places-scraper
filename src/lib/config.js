const db = require('../db');
const { encrypt, decrypt } = require('./crypto');
const { HttpError } = require('./utils');

// Catálogo de configuración. tipo: text | int | bool | secret | select
const DEFS = {
  // Empresa
  empresa_nombre:        { grupo: 'empresa', def: 'Mi Empresa', label: 'Nombre de la empresa' },
  empresa_zona_horaria:  { grupo: 'empresa', def: 'America/Lima', label: 'Zona horaria' },
  empresa_codigo_pais:   { grupo: 'empresa', def: '51', label: 'Código de país por defecto' },
  empresa_moneda:        { grupo: 'empresa', def: 'PEN', label: 'Moneda' },

  // App de Meta (plataforma). El número de la empresa se conecta con Embedded Signup → tabla wa_cuenta
  meta_app_id:           { grupo: 'meta', def: '', label: 'App ID' },
  meta_app_secret:       { grupo: 'meta', def: '', tipo: 'secret', label: 'Clave secreta de la app (App Secret)' },
  meta_config_id:        { grupo: 'meta', def: '', label: 'Configuration ID (Embedded Signup)' },
  meta_verify_token:     { grupo: 'meta', def: '', label: 'Token de verificación del webhook' },
  meta_api_version:      { grupo: 'meta', def: 'v25.0', label: 'Versión de Graph API' },
  meta_public_url:       { grupo: 'meta', def: '', label: 'URL pública del CRM (https)' },
  meta_alerta_mensual:   { grupo: 'meta', def: '1000', tipo: 'int', min: 1, max: 1000000, label: 'Avisar al superar estos mensajes al mes' },

  // Google Places
  google_api_key:        { grupo: 'google', def: '', tipo: 'secret', label: 'Google Places API key' },

  // Envíos masivos
  envios_activo:         { grupo: 'envios', def: '1', tipo: 'bool', label: 'Envíos habilitados' },
  delay_entre_mensajes:  { grupo: 'envios', def: '8000', tipo: 'int', min: 1000, max: 600000, label: 'Pausa entre mensajes (ms)' },
  limite_diario:         { grupo: 'envios', def: '250', tipo: 'int', min: 1, max: 100000, label: 'Límite diario de mensajes' },
  hora_inicio:           { grupo: 'envios', def: '9', tipo: 'int', min: 0, max: 23, label: 'Hora de inicio' },
  hora_fin:              { grupo: 'envios', def: '19', tipo: 'int', min: 0, max: 23, label: 'Hora de fin' },
  dias_envio:            { grupo: 'envios', def: '1,2,3,4,5,6', label: 'Días permitidos (0=domingo)' },
  envios_max_intentos:   { grupo: 'envios', def: '3', tipo: 'int', min: 1, max: 10, label: 'Reintentos por mensaje' },

  // Bandeja / chat
  chat_crear_contacto:   { grupo: 'chat', def: '1', tipo: 'bool', label: 'Crear contacto al recibir mensaje de un número desconocido' },
  chat_etapa_respuesta:  { grupo: 'chat', def: 'contactado', label: 'Mover a esta etapa cuando un contacto responde' },

  // Recordatorios de reuniones
  recordatorios_activo:  { grupo: 'recordatorios', def: '1', tipo: 'bool', label: 'Enviar recordatorios automáticos de reuniones' },

  // Leads (formulario público)
  leads_origenes:        { grupo: 'leads', def: '*', label: 'Orígenes permitidos (CORS)' },
  leads_alerta_numero:   { grupo: 'leads', def: '', label: 'WhatsApp para alertas de nuevos leads' },

  // Proyectos de desarrollo
  proyectos_costo_hora:     { grupo: 'proyectos', def: '0', label: 'Costo por hora del equipo (para la rentabilidad)' },
  proyectos_wa_cobros:      { grupo: 'proyectos', def: '0', tipo: 'bool', label: 'Avisar al cliente por WhatsApp cuando una cuota está por vencer' },
  proyectos_wa_entrega:     { grupo: 'proyectos', def: '0', tipo: 'bool', label: 'Avisar al cliente por WhatsApp cuando se entrega el proyecto' },

  // Seguridad
  seguridad_sesion_horas:  { grupo: 'seguridad', def: '8', tipo: 'int', min: 1, max: 720, label: 'Duración de la sesión (horas)' },
  seguridad_intentos_max:  { grupo: 'seguridad', def: '5', tipo: 'int', min: 3, max: 20, label: 'Intentos fallidos antes de bloquear' },
  seguridad_bloqueo_min:   { grupo: 'seguridad', def: '15', tipo: 'int', min: 1, max: 1440, label: 'Minutos de bloqueo' },
  seguridad_password_min:  { grupo: 'seguridad', def: '8', tipo: 'int', min: 8, max: 64, label: 'Largo mínimo de contraseña' },
};

let cache = null, cacheAt = 0;
const TTL = 15000;

async function getAll() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const [rows] = await db.query('SELECT clave, valor FROM configuracion');
  const out = {};
  for (const [k, d] of Object.entries(DEFS)) out[k] = d.def;
  for (const r of rows) {
    if (!(r.clave in DEFS)) continue;
    out[r.clave] = DEFS[r.clave].tipo === 'secret' ? decrypt(r.valor) : r.valor;
  }
  if (!out.google_api_key && process.env.GOOGLE_API_KEY) out.google_api_key = process.env.GOOGLE_API_KEY;
  cache = out; cacheAt = Date.now();
  return out;
}

async function get(clave) { return (await getAll())[clave]; }
async function getInt(clave) {
  const v = parseInt(await get(clave), 10);
  return Number.isNaN(v) ? parseInt(DEFS[clave].def, 10) : v;
}
async function getBool(clave) { return String(await get(clave)) === '1'; }

function invalidar() { cache = null; }

// Valida y guarda solo claves conocidas. Secretos vacíos = no cambiar.
async function set(valores) {
  // App de Meta: los IDs son solo números y el Configuration ID (Embedded Signup) no es el App ID
  const actual = await getAll();
  const appId = String(valores.meta_app_id ?? actual.meta_app_id ?? '').trim();
  const configId = String(valores.meta_config_id ?? actual.meta_config_id ?? '').trim();
  if (valores.meta_app_id && !/^\d{5,25}$/.test(appId)) throw new HttpError(400, 'El App ID debe tener solo números.');
  if (valores.meta_config_id && !/^\d{5,25}$/.test(configId)) throw new HttpError(400, 'El Configuration ID debe tener solo números.');
  if ((valores.meta_app_id !== undefined || valores.meta_config_id !== undefined) && appId && configId && appId === configId)
    throw new HttpError(400, 'El Configuration ID no es el App ID: cópialo de Inicio de sesión con Facebook para empresas → Configuraciones (la de WhatsApp Embedded Signup).');

  const cambiadas = [];
  for (const [clave, raw] of Object.entries(valores || {})) {
    const d = DEFS[clave];
    if (!d || raw === undefined || raw === null) continue;
    let v = String(raw).trim();
    if (d.tipo === 'secret') {
      if (!v || /^•+/.test(v)) continue;
      v = encrypt(v);
    } else if (d.tipo === 'int') {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < (d.min ?? -Infinity) || n > (d.max ?? Infinity))
        throw new HttpError(400, `Valor inválido para "${d.label}"`);
      v = String(n);
    } else if (d.tipo === 'bool') {
      v = (v === '1' || v === 'true') ? '1' : '0';
    } else {
      v = v.slice(0, 1000);
    }
    await db.query(
      'INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      [clave, v]
    );
    cambiadas.push(clave);
  }
  invalidar();
  return cambiadas;
}

// Vista para el panel: secretos enmascarados
async function vistaPublica() {
  const all = await getAll();
  const out = {};
  for (const [k, d] of Object.entries(DEFS)) {
    const v = all[k] || '';
    out[k] = d.tipo === 'secret'
      ? { configurado: !!v, valor: v ? '••••••••' + v.slice(-4) : '' }
      : v;
  }
  return out;
}

// ¿Hay un número de WhatsApp conectado y listo para enviar?
async function metaConfigurado() {
  const [[c]] = await db.query("SELECT estado, phone_number_id, access_token FROM wa_cuenta WHERE id = 1");
  return !!(c && c.estado === 'conectado' && c.phone_number_id && c.access_token);
}

module.exports = { DEFS, getAll, get, getInt, getBool, set, vistaPublica, invalidar, metaConfigurado };
