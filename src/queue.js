// Procesador de campañas por WhatsApp (API oficial de Meta)
// - Loop con await: un ciclo solo empieza cuando terminó el anterior
// - Activa las campañas programadas cuya fecha llegó
// - Carga los contactos de la campaña al empezar (según los filtros y el alcance de quien la creó)
// - Reserva atómica de un contacto a la vez (sobrevive a reinicios: las reservas viejas se liberan)
// - Solo envía plantillas aprobadas: si Meta la pausa o rechaza, la campaña se pausa
// - Respeta horario, días y límite diario de Configuración → Envíos masivos
const crypto = require('crypto');
const db     = require('./db');
const config = require('./lib/config');
const { emitir, notificar, notificarPermiso } = require('./lib/notificar');
const { enviarAContacto } = require('./lib/mensajeria');
const { filtroContactos } = require('./lib/filtros');
const { cargarUsuario } = require('./lib/auth');
const { valorVariable } = require('./lib/utils');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), '[campañas]', ...a);

const estado = { activo: false, bloqueo: null, ultimoCiclo: null };

function ahoraEnZona(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hora: parseInt(p.hour, 10), dia: dias[p.weekday] };
}

async function enviadosHoy() {
  const [[r]] = await db.query(
    "SELECT COUNT(*) AS n FROM envios WHERE estado IN ('enviado','entregado','leido') AND enviado_at >= CURDATE()");
  return Number(r.n || 0);
}

// null si se puede enviar; si no, { tipo, msg } con el motivo
async function bloqueo() {
  const c = await config.getAll();
  if (c.envios_activo !== '1') return { tipo: 'desactivado', msg: 'Los envíos están desactivados en Configuración → Envíos masivos.' };
  if (!(await config.metaConfigurado())) return { tipo: 'config', msg: 'WhatsApp no está conectado (WhatsApp → Conexión).' };
  const { hora, dia } = ahoraEnZona(c.empresa_zona_horaria || 'America/Lima');
  if (!String(c.dias_envio || '').split(',').map(Number).includes(dia))
    return { tipo: 'horario', msg: 'Hoy no es un día habilitado para envíos. Las campañas continúan solas el próximo día hábil.' };
  const ini = parseInt(c.hora_inicio, 10), fin = parseInt(c.hora_fin, 10);
  if (hora < ini || hora > fin) return { tipo: 'horario', msg: `Fuera del horario de envío (${ini}:00 a ${fin}:59). Las campañas continúan solas.` };
  const hoy = await enviadosHoy(), lim = parseInt(c.limite_diario, 10);
  if (hoy >= lim) return { tipo: 'limite', msg: `Límite diario alcanzado (${hoy}/${lim}). Las campañas continúan mañana.` };
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
  const maximo = Math.min(parseInt(filtros.maximo, 10) || 20000, 20000);
  const [r] = await db.query(`
    INSERT INTO envios (campana_id, negocio_id, estado, estado_destino, creado_por)
    SELECT ?, n.id, 'pendiente', ?, ? FROM negocios n
    WHERE ${where} AND COALESCE(n.wa_verificado, 1) = 1
      AND NOT EXISTS (SELECT 1 FROM envios e WHERE e.negocio_id = n.id AND e.campana_id = ?)
    ORDER BY n.id LIMIT ?`,
    [c.id, c.etapa_destino || null, c.creado_por || null, ...vals, c.id, maximo]);
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

// Envía a UN contacto de la campaña
async function procesarCampana(c) {
  if (!c.nombre_meta || c.p_estado !== 'aprobada') {
    return pausar(c, `La plantilla ${c.nombre_meta || ''} no está aprobada por Meta (${c.p_estado || 'sin plantilla'}).`);
  }
  if (!Number(c.contactos_cargados) && !(await cargarContactos(c))) return completar(c);

  const reserva = crypto.randomUUID();
  const [u] = await db.query(`UPDATE envios SET estado = 'procesando', reserva = ?, reservado_at = NOW()
    WHERE campana_id = ? AND estado = 'pendiente' ORDER BY id LIMIT 1`, [reserva, c.id]);
  if (!u.affectedRows) {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM envios WHERE campana_id = ? AND estado IN ('pendiente','procesando')", [c.id]);
    if (!n) await completar(c);
    return;
  }
  const [[e]] = await db.query('SELECT * FROM envios WHERE reserva = ?', [reserva]);

  // Pudo pausarse o cancelarse mientras tanto: el contacto vuelve a pendiente
  const [[actual]] = await db.query('SELECT estado FROM campanas WHERE id = ?', [c.id]);
  if (actual?.estado !== 'enviando') {
    await db.query("UPDATE envios SET estado = 'pendiente', reserva = NULL WHERE id = ?", [e.id]);
    return;
  }

  const [[n]] = await db.query(`SELECT n.*, u.nombre AS asignado_nombre FROM negocios n
    LEFT JOIN usuarios u ON u.id = n.asignado_a WHERE n.id = ?`, [e.negocio_id]);
  if (!n) {
    await db.query("UPDATE envios SET estado = 'cancelado', reserva = NULL, error_msg = 'Contacto eliminado' WHERE id = ?", [e.id]);
    return;
  }

  const maxIntentos = await config.getInt('envios_max_intentos');
  try {
    const msg = await enviarAContacto(n, { plantilla: {
      nombre: c.nombre_meta, idioma: c.p_idioma || 'es', params: parametros(c, n), cuerpo: c.p_cuerpo,
      header: c.encabezado_tipo === 'imagen' ? 'IMAGE' : null, headerUrl: c.imagen_url,
    } }, { origen: 'campana' });

    await db.query(`UPDATE envios SET estado = 'enviado', enviado_at = NOW(), wa_message_id = ?, mensaje_final = ?, numero = ?,
      error_msg = NULL, reserva = NULL WHERE id = ?`, [msg.wa_id, msg.contenido, msg.numero, e.id]);
    await db.query('UPDATE campanas SET enviados = enviados + 1, ultimo_error = NULL WHERE id = ?', [c.id]);
    await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario) VALUES (?,?,?,?)',
      [n.id, 'whatsapp', `Campaña enviada: ${c.nombre}`, 'Sistema']);
    const destino = e.estado_destino || c.etapa_destino;
    if (destino && destino !== n.estado_crm) {
      await db.query('UPDATE negocios SET estado_crm = ? WHERE id = ?', [destino, n.id]);
      await db.query('INSERT INTO crm_historial (negocio_id, tipo, estado_anterior, estado_nuevo, contenido, usuario) VALUES (?,?,?,?,?,?)',
        [n.id, 'estado', n.estado_crm, destino, `Movido tras la campaña "${c.nombre}"`, 'Sistema']);
    }
    emitir('envio:progreso', { id: e.id, campana_id: c.id, estado: 'enviado', nombre: n.nombre });
  } catch (err) {
    const intentos = (e.intentos || 0) + 1;
    const reintentar = err.temporal && !err.sinWhatsapp && !err.ventana && intentos < maxIntentos && !(err.status >= 400 && err.status < 500);
    await db.query('UPDATE envios SET estado = ?, intentos = ?, error_msg = ?, reserva = NULL WHERE id = ?',
      [reintentar ? 'pendiente' : 'fallido', intentos, String(err.message).slice(0, 500), e.id]);
    if (!reintentar) await db.query('UPDATE campanas SET fallidos = fallidos + 1 WHERE id = ?', [c.id]);
    if (err.sinWhatsapp) await db.query('UPDATE negocios SET wa_verificado = 0 WHERE id = ?', [n.id]);
    emitir('envio:progreso', { id: e.id, campana_id: c.id, estado: reintentar ? 'pendiente' : 'fallido', error: err.message });
    log(`${reintentar ? 'Reintento' : 'Fallido'} → ${n.nombre}: ${err.message}`);

    if (err.fatal || err.codigo === 'META_NO_CONFIG') {
      // Problema de la cuenta: se pausan todas las campañas en curso
      const [enCurso] = await db.query("SELECT id, nombre FROM campanas WHERE estado = 'enviando'");
      for (const x of enCurso) await pausar(x, `Error de la cuenta de WhatsApp: ${err.message}`, { avisar: x.id === c.id });
      return;
    }
    if (reintentar) await sleep(15000);
  }
}

async function ciclo() {
  // Reservas abandonadas (reinicio a mitad de un envío) vuelven a la cola
  await db.query("UPDATE envios SET estado = 'pendiente', reserva = NULL WHERE estado = 'procesando' AND reservado_at < NOW() - INTERVAL 10 MINUTE");
  // Campañas programadas cuya hora llegó
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

  for (const c of camps) {
    await procesarCampana(c);
    if (await bloqueo()) break;
  }
}

async function loop() {
  log('Procesador activo');
  while (estado.activo) {
    try { await ciclo(); estado.ultimoCiclo = new Date(); }
    catch (e) { log('Error en el ciclo:', e.message); }
    await sleep(Math.max(1000, await config.getInt('delay_entre_mensajes').catch(() => 8000)));
  }
}

function iniciar() {
  if (estado.activo) return;
  estado.activo = true;
  loop();
}

function getEstado() { return { activo: estado.activo, bloqueo: estado.bloqueo, ultimoCiclo: estado.ultimoCiclo }; }

module.exports = { iniciar, bloqueo, enviadosHoy, getEstado, cargarContactos };
