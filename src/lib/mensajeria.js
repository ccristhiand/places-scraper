// Envío de mensajes a contactos + registro en la bandeja
const path   = require('path');
const db     = require('../db');
const meta   = require('../meta');
const config = require('./config');
const { emitir } = require('./notificar');
const { limpiarNumero, HttpError } = require('./utils');

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

// opciones: { texto } | { imagenUrl, texto } | { plantilla: { nombre, idioma, params, cuerpo, header } }
async function enviarAContacto(negocio, opciones, { usuarioId = null, exigirVentana = true, origen = 'manual' } = {}) {
  const numero = await numeroDe(negocio);
  if (!numero) throw new HttpError(400, 'El contacto no tiene un número válido.');

  if (opciones.plantilla) {
    const p = opciones.plantilla;
    let headerMediaId = null;
    if (p.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(p.header)) {
      const img = rutaUpload(p.headerUrl);
      if (!img) throw new HttpError(400, `La plantilla "${p.nombre}" requiere una imagen de cabecera.`);
      headerMediaId = await meta.subirMedia(img.ruta, img.mime);
    }
    const r = await meta.enviarPlantilla(numero, p.nombre, p.idioma, p.params || [], { headerMediaId, headerTipo: p.header });
    const contenido = p.cuerpo ? meta.renderPlantilla(p.cuerpo, p.params || []) : `[Plantilla ${p.nombre}]`;
    return registrarSaliente({ negocioId: negocio.id, numero, tipo: 'plantilla', contenido, mediaUrl: p.headerUrl || null, waId: r.id, usuarioId, origen });
  }

  if (exigirVentana && !ventanaAbierta(negocio))
    throw new HttpError(409, 'Pasaron más de 24 h desde el último mensaje del cliente. Usa una plantilla aprobada.', 'VENTANA_CERRADA');

  if (opciones.imagenUrl) {
    const img = rutaUpload(opciones.imagenUrl);
    const mediaId = await meta.subirMedia(img.ruta, img.mime);
    const r = await meta.enviarImagen(numero, mediaId, opciones.texto);
    return registrarSaliente({ negocioId: negocio.id, numero, tipo: 'imagen', contenido: opciones.texto || '', mediaUrl: opciones.imagenUrl, waId: r.id, usuarioId, origen });
  }

  const r = await meta.enviarTexto(numero, opciones.texto);
  return registrarSaliente({ negocioId: negocio.id, numero, tipo: 'texto', contenido: opciones.texto, waId: r.id, usuarioId, origen });
}

module.exports = { ventanaAbierta, numeroDe, rutaUpload, enviarAContacto, registrarSaliente, UPLOADS };
