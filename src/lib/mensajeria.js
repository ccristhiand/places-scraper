// Envío de mensajes a contactos + registro en la bandeja (con el proveedor de WhatsApp activo)
const path   = require('path');
const db     = require('../db');
const config = require('./config');
const { emitir } = require('./notificar');
const { limpiarNumero, HttpError } = require('./utils');

const proveedor = () => require('../wa/proveedor');
const UPLOADS = path.join(__dirname, '../../uploads');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function ventanaAbierta(negocio) {
  if (!negocio?.ultimo_entrante_at) return false;
  return Date.now() - new Date(negocio.ultimo_entrante_at).getTime() < 24 * 3600 * 1000;
}

async function numeroDe(negocio) {
  const cp = await config.get('empresa_codigo_pais');
  return limpiarNumero(negocio.whatsapp || negocio.telefono_int || negocio.telefono, cp);
}

// Destino para enviar: el número; con WhatsApp Web también sirve el identificador @lid guardado
async function destinoDe(negocio) {
  const numero = await numeroDe(negocio);
  if (numero) return { destino: numero, numero };
  const jid = String(negocio.wa_jid || '');
  if (jid && !/^\d{8,15}$/.test(jid) && (await proveedor().activo()) === 'baileys') return { destino: `lid:${jid}`, numero: jid };
  if (/^\d{8,15}$/.test(jid)) return { destino: jid, numero: jid };
  return { destino: null, numero: null };
}

// Ruta local segura de una imagen subida (/uploads/xxx)
function rutaUpload(url) {
  if (!url) return null;
  const nombre = path.basename(String(url));
  return { ruta: path.join(UPLOADS, nombre), mime: MIME[path.extname(nombre).toLowerCase()] || 'image/jpeg' };
}

async function registrarSaliente({ negocioId, numero, tipo, contenido, mediaUrl = null, waId, usuarioId = null, origen = 'manual' }) {
  const [r] = await db.query(
    `INSERT INTO chat_mensajes (negocio_id, numero, direccion, tipo, contenido, media_url, wa_id, leido, estado_entrega, usuario_id, origen)
     VALUES (?,?,?,?,?,?,?,1,'enviado',?,?)`,
    [negocioId, numero, 'saliente', tipo, contenido, mediaUrl, waId, usuarioId, origen]);
  await db.query('UPDATE negocios SET ultima_actividad_at = NOW() WHERE id = ?', [negocioId]);
  const msg = { id: r.insertId, negocio_id: negocioId, numero, direccion: 'saliente', tipo, contenido, media_url: mediaUrl,
                wa_id: waId, estado_entrega: 'enviado', created_at: new Date() };
  emitir('chat:mensaje', msg);
  return msg;
}

// opciones: { texto } | { imagenUrl, texto } | { plantilla: { nombre, idioma, params, cuerpo, header, headerUrl } }
// escritura: con WhatsApp Web muestra "escribiendo…" antes de enviar
async function enviarAContacto(negocio, opciones, { usuarioId = null, exigirVentana = true, origen = 'manual', escritura = true } = {}) {
  const { destino, numero } = await destinoDe(negocio);
  if (!destino) throw new HttpError(400, 'El contacto no tiene un número válido.');
  const P = proveedor();

  if (opciones.plantilla) {
    const p = opciones.plantilla;
    const r = await P.enviarPlantilla(destino, { ...p, imagen: p.headerUrl ? rutaUpload(p.headerUrl) : null }, { escritura });
    return registrarSaliente({ negocioId: negocio.id, numero, tipo: (await P.activo()) === 'meta' ? 'plantilla' : (p.headerUrl ? 'imagen' : 'texto'),
      contenido: r.contenido, mediaUrl: p.headerUrl || null, waId: r.id, usuarioId, origen });
  }

  if (exigirVentana && (await P.requiereVentana()) && !ventanaAbierta(negocio))
    throw new HttpError(409, 'Pasaron más de 24 h desde el último mensaje del cliente. Usa una plantilla aprobada.', 'VENTANA_CERRADA');

  if (opciones.imagenUrl) {
    const r = await P.enviarImagen(destino, rutaUpload(opciones.imagenUrl), opciones.texto, { escritura });
    return registrarSaliente({ negocioId: negocio.id, numero, tipo: 'imagen', contenido: opciones.texto || '', mediaUrl: opciones.imagenUrl, waId: r.id, usuarioId, origen });
  }

  const r = await P.enviarTexto(destino, opciones.texto, { escritura });
  return registrarSaliente({ negocioId: negocio.id, numero, tipo: 'texto', contenido: opciones.texto, waId: r.id, usuarioId, origen });
}

module.exports = { ventanaAbierta, numeroDe, destinoDe, rutaUpload, enviarAContacto, registrarSaliente, UPLOADS };
