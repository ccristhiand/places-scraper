// Mensajes entrantes y estados de entrega, comunes a los dos proveedores (Meta y Baileys)
const db     = require('../db');
const config = require('./config');
const { emitir, notificar } = require('./notificar');

async function buscarContacto(numero, jid = null) {
  if (jid) {
    const [[n]] = await db.query('SELECT * FROM negocios WHERE wa_jid = ? LIMIT 1', [jid]);
    if (n) return n;
  }
  if (!numero) return null;
  const corto = numero.startsWith('51') ? numero.slice(2) : numero;
  const [[n]] = await db.query(`
    SELECT * FROM negocios
    WHERE wa_jid = ? OR REPLACE(REPLACE(REPLACE(COALESCE(whatsapp,''),'+',''),' ',''),'-','') IN (?, ?)
       OR REPLACE(REPLACE(REPLACE(COALESCE(telefono_int,''),'+',''),' ',''),'-','') IN (?, ?)
       OR REPLACE(REPLACE(REPLACE(COALESCE(telefono,''),'+',''),' ',''),'-','') IN (?, ?)
    ORDER BY (wa_jid = ?) DESC, id ASC LIMIT 1`,
    [numero, numero, corto, numero, corto, numero, corto, numero]);
  return n || null;
}

// "No", "STOP", "baja"… como mensaje completo (no dentro de una frase larga)
const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function esBaja(texto) {
  if (!(await config.getBool('optout_activo'))) return false;
  const t = normalizar(texto);
  if (!t || t.length > 40) return false;
  const palabras = String(await config.get('optout_palabras') || '').split(',').map(normalizar).filter(Boolean);
  return palabras.includes(t);
}

async function darDeBaja(negocio) {
  await db.query('UPDATE negocios SET no_contactar = 1, no_contactar_at = NOW() WHERE id = ?', [negocio.id]);
  const [c] = await db.query("UPDATE envios SET estado = 'cancelado', reserva = NULL, error_msg = 'El contacto pidió no recibir mensajes' WHERE negocio_id = ? AND estado IN ('pendiente','procesando')", [negocio.id]);
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario) VALUES (?,?,?,?)',
    [negocio.id, 'sistema', `Pidió no recibir más mensajes: quedó excluido de las campañas${c.affectedRows ? ` (${c.affectedRows} envío(s) cancelados)` : ''}`, 'Sistema']);
  if (negocio.asignado_a) await notificar([negocio.asignado_a], { tipo: 'alerta', titulo: `${negocio.nombre} se dio de baja`, cuerpo: 'Ya no recibirá campañas.', enlace: `#/contactos/${negocio.id}` });
  const respuesta = String(await config.get('optout_respuesta') || '').trim();
  if (respuesta) {
    // La respuesta va dentro de la ventana de 24 h (acaba de escribir): sin costo en Meta
    require('./mensajeria').enviarAContacto({ ...negocio, ultimo_entrante_at: new Date() }, { texto: respuesta }, { origen: 'manual', exigirVentana: false })
      .catch(e => console.error('Respuesta de baja:', e.message));
  }
}

/**
 * Registra un mensaje entrante.
 *   numero: número real (puede faltar con identificadores @lid de Baileys)
 *   jid:    identificador estable de WhatsApp del contacto (número o lid)
 */
async function registrarEntrante({ numero, jid, perfil, waId, tipo = 'texto', texto = '', mediaUrl = null, ts = new Date() }) {
  numero = numero ? String(numero).replace(/\D/g, '') : null;
  if ((!numero && !jid) || !waId) return null;

  const [[dup]] = await db.query('SELECT id FROM chat_mensajes WHERE wa_id = ? LIMIT 1', [waId]);
  if (dup) return null;

  let negocio = await buscarContacto(numero, jid);
  if (!negocio && await config.getBool('chat_crear_contacto')) {
    const [r] = await db.query(
      `INSERT INTO negocios (place_id, nombre, whatsapp, wa_jid, wa_verificado, origen, estado_crm)
       VALUES (?, ?, ?, ?, 1, 'whatsapp', (SELECT clave FROM etapas ORDER BY orden LIMIT 1))`,
      [`wa:${numero || jid}`, perfil || (numero ? `+${numero}` : 'Contacto de WhatsApp'), numero, jid || numero]);
    [[negocio]] = await db.query('SELECT * FROM negocios WHERE id = ?', [r.insertId]);
    await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario) VALUES (?,?,?,?)',
      [negocio.id, 'sistema', 'Contacto creado automáticamente al recibir un WhatsApp', 'Sistema']);
  }

  const identificador = numero || jid;
  const [r] = await db.query(
    `INSERT INTO chat_mensajes (negocio_id, numero, direccion, tipo, contenido, media_url, wa_id, leido, created_at, origen)
     VALUES (?,?,?,?,?,?,?,0,?, 'entrante')`,
    [negocio?.id || null, identificador, 'entrante', tipo, texto || '', mediaUrl, waId, ts]);

  if (negocio) {
    await db.query(
      `UPDATE negocios SET ultimo_entrante_at = NOW(), ultima_actividad_at = NOW(), wa_verificado = 1,
         wa_jid = COALESCE(wa_jid, ?), whatsapp = IF(COALESCE(whatsapp,'') = '' AND ? IS NOT NULL, ?, whatsapp) WHERE id = ?`,
      [jid || numero, numero, numero, negocio.id]);

    if (tipo === 'texto' && !Number(negocio.no_contactar) && await esBaja(texto)) {
      await darDeBaja(negocio);
    } else {
      // Avance automático de etapa cuando responde un contacto de la primera etapa
      const etapaResp = await config.get('chat_etapa_respuesta');
      if (etapaResp && negocio.estado_crm !== etapaResp) {
        const [[primera]] = await db.query('SELECT clave FROM etapas ORDER BY orden LIMIT 1');
        const [[existe]]  = await db.query('SELECT clave FROM etapas WHERE clave = ?', [etapaResp]);
        if (existe && primera && negocio.estado_crm === primera.clave) {
          await db.query('UPDATE negocios SET estado_crm = ? WHERE id = ?', [etapaResp, negocio.id]);
          await db.query('INSERT INTO crm_historial (negocio_id, tipo, estado_anterior, estado_nuevo, contenido, usuario) VALUES (?,?,?,?,?,?)',
            [negocio.id, 'estado', negocio.estado_crm, etapaResp, 'El contacto respondió por WhatsApp', 'Sistema']);
        }
      }
    }
    if (negocio.asignado_a) {
      await notificar([negocio.asignado_a], {
        tipo: 'mensaje', titulo: `Nuevo mensaje de ${negocio.nombre}`, cuerpo: (texto || '').slice(0, 120), enlace: `#/bandeja/${negocio.id}`,
      });
    }
  }

  const msg = {
    id: r.insertId, negocio_id: negocio?.id || null, negocio_nombre: negocio?.nombre || perfil || identificador,
    numero: identificador, direccion: 'entrante', tipo, contenido: texto || '', media_url: mediaUrl, created_at: ts,
  };
  emitir('chat:mensaje', msg);
  return msg;
}

const ORDEN_ESTADO = { enviado: 1, entregado: 2, leido: 3, fallido: 4 };

// estado: enviado | entregado | leido | fallido. sinWhatsapp: el número no tiene WhatsApp
async function registrarEstado({ waId, estado, errorMsg = null, sinWhatsapp = false }) {
  if (!estado || !waId) return;
  const [[msg]] = await db.query('SELECT id, negocio_id, estado_entrega FROM chat_mensajes WHERE wa_id = ? LIMIT 1', [waId]);
  // No retroceder estados (pueden llegar desordenados)
  if (msg && (estado === 'fallido' || (ORDEN_ESTADO[estado] > (ORDEN_ESTADO[msg.estado_entrega] || 0)))) {
    await db.query('UPDATE chat_mensajes SET estado_entrega = ?, error_msg = ? WHERE id = ?', [estado, errorMsg, msg.id]);
  }

  const [[envio]] = await db.query('SELECT id, estado, negocio_id, campana_id FROM envios WHERE wa_message_id = ? LIMIT 1', [waId]);
  if (envio) {
    if (estado === 'entregado' && envio.estado === 'enviado')
      await db.query("UPDATE envios SET estado = 'entregado', entregado_at = NOW() WHERE id = ?", [envio.id]);
    else if (estado === 'leido' && ['enviado', 'entregado'].includes(envio.estado))
      await db.query("UPDATE envios SET estado = 'leido', leido_at = NOW(), entregado_at = COALESCE(entregado_at, NOW()) WHERE id = ?", [envio.id]);
    else if (estado === 'fallido' && envio.estado !== 'fallido') {
      await db.query("UPDATE envios SET estado = 'fallido', error_msg = ? WHERE id = ?", [errorMsg, envio.id]);
      if (envio.campana_id && ['enviado', 'entregado', 'leido'].includes(envio.estado))
        await db.query('UPDATE campanas SET enviados = GREATEST(enviados - 1, 0), fallidos = fallidos + 1 WHERE id = ?', [envio.campana_id]);
    }
    emitir('envio:estado', { id: envio.id, campana_id: envio.campana_id, estado });
  }

  const negocioId = msg?.negocio_id || envio?.negocio_id;
  if (negocioId && estado === 'fallido' && sinWhatsapp) await db.query('UPDATE negocios SET wa_verificado = 0 WHERE id = ?', [negocioId]);
  if (negocioId && (estado === 'entregado' || estado === 'leido'))
    await db.query('UPDATE negocios SET wa_verificado = 1 WHERE id = ? AND wa_verificado IS NULL', [negocioId]);
  if (msg) emitir('chat:estado', { wa_id: waId, negocio_id: negocioId, estado, error: errorMsg });
}

module.exports = { buscarContacto, registrarEntrante, registrarEstado, esBaja, darDeBaja };
