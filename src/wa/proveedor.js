// Proveedor de WhatsApp activo: 'meta' (API oficial) o 'baileys' (WhatsApp Web por QR).
// El resto del CRM envía por aquí y no necesita saber cuál está activo.
const config  = require('../lib/config');
const meta    = require('../meta');
const baileys = require('./baileys');

async function activo() {
  return (await config.get('wa_proveedor')) === 'baileys' ? 'baileys' : 'meta';
}

async function conectado() {
  return (await activo()) === 'baileys' ? baileys.conectado() : config.metaConfigurado();
}

// Con Meta hay ventana de 24 h para texto libre; con WhatsApp Web no existe esa regla
async function requiereVentana() {
  return (await activo()) === 'meta';
}

async function enviarTexto(destino, texto, opts = {}) {
  if ((await activo()) === 'baileys') return baileys.enviarTexto(destino, texto, opts);
  return meta.enviarTexto(destino, texto);
}

// imagen: { ruta, mime }
async function enviarImagen(destino, imagen, caption, opts = {}) {
  if ((await activo()) === 'baileys') return baileys.enviarImagen(destino, imagen.ruta, caption, opts);
  const mediaId = await meta.subirMedia(imagen.ruta, imagen.mime);
  return meta.enviarImagen(destino, mediaId, caption);
}

/**
 * Plantilla { nombre, idioma, params, cuerpo, header, imagen }:
 *  - Meta: se envía la plantilla aprobada.
 *  - Baileys: no hay plantillas; se envía el cuerpo con los datos ya reemplazados (con imagen si tiene).
 * Devuelve { id, contenido }.
 */
async function enviarPlantilla(destino, p, opts = {}) {
  const contenido = p.cuerpo ? meta.renderPlantilla(p.cuerpo, p.params || []) : `[Plantilla ${p.nombre}]`;
  if ((await activo()) === 'baileys') {
    if (!p.cuerpo) throw new Error(`No se conoce el texto de la plantilla "${p.nombre}" para enviarla como mensaje.`);
    const r = p.imagen ? await baileys.enviarImagen(destino, p.imagen.ruta, contenido, opts) : await baileys.enviarTexto(destino, contenido, opts);
    return { id: r.id, contenido };
  }
  let headerMediaId = null;
  if (p.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(p.header)) {
    if (!p.imagen) throw new Error(`La plantilla "${p.nombre}" requiere una imagen de cabecera.`);
    headerMediaId = await meta.subirMedia(p.imagen.ruta, p.imagen.mime);
  }
  const r = await meta.enviarPlantilla(destino, p.nombre, p.idioma, p.params || [], { headerMediaId, headerTipo: p.header });
  return { id: r.id, contenido };
}

async function marcarLeido({ waId, destino }) {
  if ((await activo()) === 'baileys') {
    if ((await config.get('ab_marcar_leido')) === '1') return baileys.marcarLeido({ waId, destino });
    return;
  }
  return meta.marcarLeido(waId);
}

// ¿El número tiene WhatsApp? Solo se puede saber con WhatsApp Web (null = no se sabe)
async function existe(numero) {
  if ((await activo()) !== 'baileys') return null;
  return baileys.existe(numero);
}

module.exports = { activo, conectado, requiereVentana, enviarTexto, enviarImagen, enviarPlantilla, marcarLeido, existe };
