// Procesador de campañas por WhatsApp (Meta o WhatsApp Web/Baileys, según el proveedor activo)
// - Loop con await: un ciclo solo empieza cuando terminó el anterior
// - Activa las campañas programadas cuya fecha llegó
// - Carga los contactos al empezar (filtros + alcance de quien la creó), sin bajas ni contactos recientes
// - Reserva atómica de un contacto a la vez (las reservas abandonadas se liberan)
// - Meta: solo plantillas aprobadas · WhatsApp Web: texto con variaciones {a|b} y protección antibaneo
const crypto = require('crypto');
const db     = require('./db');
const config = require('./lib/config');
const { emitir, notificar, notificarPermiso } = require('./lib/notificar');
const { enviarAContacto, destinoDe } = require('./lib/mensajeria');
const { filtroContactos } = require('./lib/filtros');
const { cargarUsuario } = require('./lib/auth');
const { valorVariable, procesarVariables } = require('./lib/utils');

const proveedor = () => require('./wa/proveedor');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const azar  = (a, b) => a + Math.random() * (b - a);
const log   = (...a) => console.log(new Date().toISOString(), '[campañas]', ...a);

const estado = {
  activo: false, bloqueo: null, ultimoCiclo: null,
  espera: 0,                         // ms hasta el próximo envío
  lote: { enviados: 0, pausaHasta: null },
  ultimos: [],                       // resultado de los últimos envíos (true = ok) para detectar problemas
};

function ahoraEnZona(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hora: parseInt(p.hour, 10), dia: dias[p.weekday] };
}

async function enviadosDesde(intervaloSql) {
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS n FROM envios WHERE estado IN ('enviado','entregado','leido') AND enviado_at >= ${intervaloSql}`);
  return Number(r.n || 0);
}
const enviadosHoy = () => enviadosDesde('CURDATE()');

// Límites de hoy según el proveedor. Con WhatsApp Web incluye el calentamiento del número.
async function limites() {
  const c = await config.getAll();
  if ((await proveedor().activo()) !== 'baileys') {
    return { proveedor: 'meta', dia: parseInt(c.limite_diario, 10), hora: null, calentamiento: null };
  }
  let dia = parseInt(c.ab_limite_dia, 10), calentamiento = null;
  if (c.ab_calentamiento_activo === '1') {
    const [[r]] = await db.query("SELECT valor FROM configuracion WHERE clave = 'baileys_desde'");
    const desde = r?.valor ? new Date(`${r.valor}T12:00:00`) : new Date();
    const diaN = Math.max(1, Math.floor((Date.now() - desde.getTime()) / 864e5) + 1);
    const tope = parseInt(c.ab_calentamiento_inicio, 10) + parseInt(c.ab_calentamiento_incremento, 10) * (diaN - 1);
    calentamiento = { dia: diaN, limite: tope, desde: r?.valor || null };
    dia = Math.min(dia, tope);
  }
  return { proveedor: 'baileys', dia, hora: parseInt(c.ab_limite_hora, 10), calentamiento };
}

// null si se puede enviar; si no, { tipo, msg } con el motivo
async function bloqueo() {
  const c = await config.getAll();
  const P = proveedor();
  if (c.envios_activo !== '1') return { tipo: 'desactivado', msg: 'Los envíos están desactivados en Configuración → Envíos masivos.' };
  if (!(await P.conectado())) return { tipo: 'config', msg: 'WhatsApp no está conectado (WhatsApp → Conexión).' };
  const { hora, dia } = ahoraEnZona(c.empresa_zona_horaria || 'America/Lima');
  if (!String(c.dias_envio || '').split(',').map(Number).includes(dia))
    return { tipo: 'horario', msg: 'Hoy no es un día habilitado para envíos. Las campañas continúan solas el próximo día hábil.' };
  const ini = parseInt(c.hora_inicio, 10), fin = parseInt(c.hora_fin, 10);
  if (hora < ini || hora > fin) return { tipo: 'horario', msg: `Fuera del horario de envío (${ini}:00 a ${fin}:59). Las campañas continúan solas.` };

  const lim = await limites();
  const hoy = await enviadosHoy();
  if (hoy >= lim.dia) return { tipo: 'limite', msg: `Límite de hoy alcanzado (${hoy}/${lim.dia}${lim.calentamiento ? `, día ${lim.calentamiento.dia} de calentamiento` : ''}). Las campañas continúan mañana.` };
  if (lim.hora) {
    const ultimaHora = await enviadosDesde('NOW() - INTERVAL 1 HOUR');
    if (ultimaHora >= lim.hora) return { tipo: 'limite', msg: `Límite por hora alcanzado (${ultimaHora}/${lim.hora}). Se retoma en unos minutos.` };
  }
  if (lim.proveedor === 'baileys' && estado.lote.pausaHasta && estado.lote.pausaHasta > Date.now()) {
    const h = new Date(estado.lote.pausaHasta).toLocaleTimeString('es-PE', { timeZone: c.empresa_zona_horaria || 'America/Lima', hour: '2-digit', minute: '2-digit' });
    return { tipo: 'lote', msg: `Descanso entre lotes (antibaneo) hasta las ${h}.` };
  }
  return null;
}

// Contactos de la campaña según sus filtros, con el alcance de quien la creó
async function cargarContactos(c) {
  let user = c.creado_por ? await cargarUsuario(c.creado_por) : null;
  if (!user) user = { id: 0, can: () => true };
  let filtros = {};
  try { filtros = JSON.parse(c.filtros || '{}'); } catch { filtros = {}; }
  let where, vals;
  if (Array.isArray(filtros.ids) && filtros.ids.length) {
    const f = filtroContactos({}, { user });
    where = `${f.where} AND n.id IN (?)`; vals = [...f.vals, filtros.ids.map(Number).filter(Boolean)];
  } else {
    ({ where, vals } = filtroContactos({ ...filtros, wa: filtros.wa || 'aptos' }, { user }));
  }
  const cfg = await config.getAll();
  const qr = (await proveedor().activo()) === 'baileys';
  // No repetir a quien recibió otra campaña hace poco
  const dias = parseInt(cfg.ab_dias_entre_campanas, 10) || 0;
  const reciente = dias > 0 ? `AND NOT EXISTS (SELECT 1 FROM envios e2 WHERE e2.negocio_id = n.id AND e2.campana_id <> ?
    AND e2.estado IN ('enviado','entregado','leido') AND e2.enviado_at > NOW() - INTERVAL ${dias} DAY)` : '';
  const orden = qr && cfg.ab_orden_aleatorio === '1' ? 'RAND()' : 'n.id';
  const maximo = Math.min(parseInt(filtros.maximo, 10) || 20000, 20000);
  const [r] = await db.query(`
    INSERT INTO envios (campana_id, negocio_id, estado, estado_destino, creado_por)
    SELECT ?, n.id, 'pendiente', ?, ? FROM negocios n
    WHERE ${where} AND COALESCE(n.wa_verificado, 1) = 1 AND COALESCE(n.no_contactar, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM envios e WHERE e.negocio_id = n.id AND e.campana_id = ?) ${reciente}
    ORDER BY ${orden} LIMIT ?`,
    [c.id, c.etapa_destino || null, c.creado_por || null, ...vals, c.id, ...(dias > 0 ? [c.id] : []), maximo]);
  await db.query('UPDATE campanas SET total = ?, contactos_cargados = 1 WHERE id = ?', [r.affectedRows, c.id]);
  log(`${r.affectedRows} contactos cargados para la campaña #${c.id}`);
  return r.affectedRows;
}

async function pausar(c, motivo, { avisar = true } = {}) {
  await db.query("UPDATE campanas SET estado = 'pausada', pausada_at = NOW(), ultimo_error = ? WHERE id = ? AND estado = 'enviando'", [String(motivo).slice(0, 500), c.id]);
  emitir('campana:estado', { id: c.id, estado: 'pausada', motivo });
  if (avisar) await notificarPermiso('envios.ejecutar', { tipo: 'alerta', titulo: `Campaña pausada: ${c.nombre}`, cuerpo: motivo, enlace: '#/campanas' });
  log(`Campaña #${c.id} pausada: ${motivo}`);
}

async function pausarTodas(motivo) {
  const [enCurso] = await db.query("SELECT id, nombre FROM campanas WHERE estado = 'enviando'");
  for (const [i, x] of enCurso.entries()) await pausar(x, motivo, { avisar: i === 0 });
}

async function completar(c) {
  await db.query("UPDATE campanas SET estado = 'completada', completada_at = NOW() WHERE id = ? AND estado = 'enviando'", [c.id]);
  emitir('campana:estado', { id: c.id, estado: 'completada' });
  if (c.creado_por) await notificar([c.creado_por], { tipo: 'info', titulo: `Campaña completada: ${c.nombre}`, enlace: '#/campanas' });
  log(`Campaña #${c.id} completada`);
}

function parametros(c, negocio) {
  let mapeo = [];
  try { mapeo = JSON.parse(c.meta_variables || '[]'); } catch { mapeo = []; }
  return mapeo.map(m => (m.tipo === 'dato' ? valorVariable(m.valor, negocio) : m.valor) || '-');
}

// {Hola|Buenas|Qué tal} → una opción al azar (admite anidados)
function spintax(texto) {
  let t = String(texto || ''), guard = 0;
  const re = /\{([^{}]*\|[^{}]*)\}/;
  while (re.test(t) && guard++ < 200) t = t.replace(re, (m, opts) => { const o = opts.split('|'); return o[Math.floor(Math.random() * o.length)]; });
  return t;
}
// Mensaje de una campaña de texto: [dato] y {{dato}} → valor del contacto, luego variaciones
function textoCampana(mensaje, negocio) {
  return spintax(procesarVariables(String(mensaje || '').replace(/\[([a-z_]{1,30})\]/gi, '{{$1}}'), negocio)).replace(/[ \t]{2,}/g, ' ').trim();
}

// Registro de resultados: si fallan demasiados envíos seguidos, algo anda mal con el número
async function registrarResultado(ok) {
  estado.ultimos.push(ok);
  if (estado.ultimos.length > 20) estado.ultimos.shift();
  const fallos = estado.ultimos.filter(x => !x).length;
  const max = await config.getInt('ab_max_fallos_pct');
  if (estado.ultimos.length >= 10 && (fallos / estado.ultimos.length) * 100 >= max) {
    estado.ultimos = [];
    await pausarTodas(`Se pausaron las campañas: fallaron ${fallos} de los últimos envíos. Revisa la conexión y el estado del número antes de reanudar.`);
  }
}

// Envía a UN contacto de la campaña. Devuelve true si se envió (para aplicar la pausa).
async function procesarCampana(c, prov) {
  const esTexto = c.tipo === 'texto';
  if (esTexto && prov !== 'baileys')
    return pausar(c, 'Esta campaña es de texto libre y solo se envía con WhatsApp QR. Cambia el proveedor en Configuración o usa una campaña con plantilla.');
  if (!esTexto && prov === 'meta' && (!c.nombre_meta || c.p_estado !== 'aprobada'))
    return pausar(c, `La plantilla ${c.nombre_meta || ''} no está aprobada por Meta (${c.p_estado || 'sin plantilla'}).`);
  if (!esTexto && prov === 'baileys' && !c.p_cuerpo)
    return pausar(c, 'No se conoce el texto de la plantilla de esta campaña para enviarla por WhatsApp QR.');
  if (!Number(c.contactos_cargados) && !(await cargarContactos(c))) return completar(c);

  const reserva = crypto.randomUUID();
  const [u] = await db.query(`UPDATE envios SET estado = 'procesando', reserva = ?, reservado_at = NOW()
    WHERE campana_id = ? AND estado = 'pendiente' ORDER BY id LIMIT 1`, [reserva, c.id]);
  if (!u.affectedRows) {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado IN ('pendiente','procesando')", [c.id]);
    if (!n) await completar(c);
    return false;
  }
  const [[e]] = await db.query('SELECT * FROM envios WHERE reserva = ?', [reserva]);
  const devolver = () => db.query("UPDATE envios SET estado = 'pendiente', reserva = NULL WHERE id = ?", [e.id]);

  const [[actual]] = await db.query('SELECT estado FROM campanas WHERE id = ?', [c.id]);
  if (actual?.estado !== 'enviando') { await devolver(); return false; }

  const [[n]] = await db.query(`SELECT n.*, u.nombre AS asignado_nombre FROM negocios n
    LEFT JOIN usuarios u ON u.id = n.asignado_a WHERE n.id = ?`, [e.negocio_id]);
  if (!n || Number(n.no_contactar)) {
    await db.query("UPDATE envios SET estado = 'cancelado', reserva = NULL, error_msg = ? WHERE id = ?", [n ? 'El contacto pidió no recibir mensajes' : 'Contacto eliminado', e.id]);
    return false;
  }

  const cfg = await config.getAll();
  // WhatsApp Web: comprobar que el número tenga WhatsApp antes de escribirle
  if (prov === 'baileys' && cfg.ab_verificar_numero === '1') {
    const { destino } = await destinoDe(n);
    if (destino && !destino.startsWith('lid:')) {
      let tiene = null;
      try { tiene = await proveedor().existe(destino); } catch (_) { tiene = null; }
      if (tiene === false) {
        await db.query("UPDATE envios SET estado = 'fallido', reserva = NULL, error_msg = 'El número no tiene WhatsApp' WHERE id = ?", [e.id]);
        await db.query('UPDATE campanas SET fallidos = fallidos + 1 WHERE id = ?', [c.id]);
        await db.query('UPDATE negocios SET wa_verificado = 0 WHERE id = ?', [n.id]);
        emitir('envio:progreso', { id: e.id, campana_id: c.id, estado: 'fallido', error: 'El número no tiene WhatsApp' });
        estado.espera = azar(3000, 7000);
        return false;
      }
      if (tiene === true && n.wa_verificado === null) await db.query('UPDATE negocios SET wa_verificado = 1 WHERE id = ?', [n.id]);
    }
  }

  const maxIntentos = parseInt(cfg.envios_max_intentos, 10) || 3;
  try {
    const opciones = esTexto
      ? (c.imagen_url ? { imagenUrl: c.imagen_url, texto: textoCampana(c.mensaje, n) } : { texto: textoCampana(c.mensaje, n) })
      : { plantilla: { nombre: c.nombre_meta, idioma: c.p_idioma || 'es', params: parametros(c, n), cuerpo: c.p_cuerpo,
          header: c.encabezado_tipo === 'imagen' ? 'IMAGE' : null, headerUrl: c.imagen_url } };
    const msg = await enviarAContacto(n, opciones, { origen: 'campana', exigirVentana: false });

    await db.query(`UPDATE envios SET estado = 'enviado', enviado_at = NOW(), wa_message_id = ?, mensaje_final = ?, numero = ?,
      error_msg = NULL, reserva = NULL WHERE id = ?`, [msg.wa_id, msg.contenido, msg.numero, e.id]);
    await db.query('UPDATE campanas SET enviados = enviados + 1, ultimo_error = NULL WHERE id = ?', [c.id]);
    await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario) VALUES (?,?,?,?)',
      [n.id, 'whatsapp', `Campaña enviada: ${c.nombre}`, 'Sistema']);
    const destinoEtapa = e.estado_destino || c.etapa_destino;
    if (destinoEtapa && destinoEtapa !== n.estado_crm) {
      await db.query('UPDATE negocios SET estado_crm = ? WHERE id = ?', [destinoEtapa, n.id]);
      await db.query('INSERT INTO crm_historial (negocio_id, tipo, estado_anterior, estado_nuevo, contenido, usuario) VALUES (?,?,?,?,?,?)',
        [n.id, 'estado', n.estado_crm, destinoEtapa, `Movido tras la campaña "${c.nombre}"`, 'Sistema']);
    }
    emitir('envio:progreso', { id: e.id, campana_id: c.id, estado: 'enviado', nombre: n.nombre });
    await registrarResultado(true);
    return true;
  } catch (err) {
    // Sin conexión: el contacto vuelve a la cola sin contar como intento (se retoma al reconectar)
    if (err.codigo === 'WA_NO_CONECTADO') { await devolver(); return false; }
    const intentos = (e.intentos || 0) + 1;
    const reintentar = err.temporal && !err.sinWhatsapp && !err.ventana && intentos < maxIntentos && !(err.status >= 400 && err.status < 500);
    await db.query('UPDATE envios SET estado = ?, intentos = ?, error_msg = ?, reserva = NULL WHERE id = ?',
      [reintentar ? 'pendiente' : 'fallido', intentos, String(err.message).slice(0, 500), e.id]);
    if (!reintentar) await db.query('UPDATE campanas SET fallidos = fallidos + 1 WHERE id = ?', [c.id]);
    if (err.sinWhatsapp) await db.query('UPDATE negocios SET wa_verificado = 0 WHERE id = ?', [n.id]);
    emitir('envio:progreso', { id: e.id, campana_id: c.id, estado: reintentar ? 'pendiente' : 'fallido', error: err.message });
    log(`${reintentar ? 'Reintento' : 'Fallido'} → ${n.nombre}: ${err.message}`);
    if (!err.sinWhatsapp) await registrarResultado(false);

    if (err.fatal || err.codigo === 'META_NO_CONFIG') {
      await pausarTodas(`Error de la cuenta de WhatsApp: ${err.message}`);
      return false;
    }
    if (reintentar) estado.espera = Math.max(estado.espera, 15000);
    return false;
  }
}

async function ciclo() {
  estado.espera = 0;
  await db.query("UPDATE envios SET estado = 'pendiente', reserva = NULL WHERE estado = 'procesando' AND reservado_at < NOW() - INTERVAL 10 MINUTE");
  const [act] = await db.query("UPDATE campanas SET estado = 'enviando', iniciada_at = IFNULL(iniciada_at, NOW()) WHERE estado = 'programada' AND programada_at <= NOW()");
  if (act.affectedRows) emitir('campana:estado', { estado: 'enviando' });

  const [camps] = await db.query(`
    SELECT c.*, p.nombre_meta, p.idioma AS p_idioma, p.estado AS p_estado, p.cuerpo AS p_cuerpo, p.encabezado_tipo
    FROM campanas c LEFT JOIN wa_plantillas p ON p.id = c.meta_plantilla_id
    WHERE c.estado = 'enviando' ORDER BY c.id`);
  if (!camps.length) { estado.bloqueo = null; return; }

  const b = await bloqueo();
  if (JSON.stringify(b) !== JSON.stringify(estado.bloqueo)) emitir('envio:control', b || { tipo: 'iniciado', msg: 'Enviando campañas…' });
  estado.bloqueo = b;
  if (b) return;

  const prov = await proveedor().activo();
  const cfg = await config.getAll();
  // Con WhatsApp Web se envía un solo mensaje por ciclo (las campañas se turnan); con Meta, uno por campaña
  const turno = prov === 'baileys' ? [camps[Math.floor(Math.random() * camps.length)]] : camps;
  for (const c of turno) {
    const enviado = await procesarCampana(c, prov);
    if (enviado && prov === 'baileys') {
      estado.espera = azar(parseInt(cfg.ab_delay_min_seg, 10), parseInt(cfg.ab_delay_max_seg, 10)) * 1000;
      if (++estado.lote.enviados >= (parseInt(cfg.ab_lote_tamano, 10) || 15)) {
        const min = azar(parseInt(cfg.ab_lote_pausa_min, 10), parseInt(cfg.ab_lote_pausa_max, 10));
        estado.lote = { enviados: 0, pausaHasta: Date.now() + min * 60000 };
        log(`Lote completo: descanso de ${Math.round(min)} min`);
      }
    }
    if (await bloqueo()) break;
  }
}

async function loop() {
  log('Procesador activo');
  while (estado.activo) {
    try { await ciclo(); estado.ultimoCiclo = new Date(); }
    catch (e) { log('Error en el ciclo:', e.message); }
    const prov = await proveedor().activo().catch(() => 'meta');
    const base = prov === 'baileys' ? 10000 : Math.max(1000, await config.getInt('delay_entre_mensajes').catch(() => 8000));
    await sleep(Math.max(base, estado.espera || 0));
  }
}

function iniciar() {
  if (estado.activo) return;
  estado.activo = true;
  loop();
}

function getEstado() {
  return { activo: estado.activo, bloqueo: estado.bloqueo, ultimoCiclo: estado.ultimoCiclo,
    lote: { enviados: estado.lote.enviados, pausaHasta: estado.lote.pausaHasta } };
}

module.exports = { iniciar, bloqueo, enviadosHoy, enviadosDesde, limites, getEstado, cargarContactos, spintax, textoCampana };
