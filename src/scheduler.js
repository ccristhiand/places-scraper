const cron   = require('node-cron');
const db     = require('./db');
const config = require('./lib/config');
const queue  = require('./queue');
const plantillas = require('./lib/plantillas');
const { barrerPendientes } = require('./routes/webhook');
const { enviarAContacto, ventanaAbierta } = require('./lib/mensajeria');
const { notificar } = require('./lib/notificar');

let ocupado = false;

function iniciar() {
  queue.iniciar(); // procesador de campañas (loop propio)
  cron.schedule('* * * * *', async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await recordatorios();
      await tareasPorVencer();
    } catch (e) {
      console.error('Scheduler:', e.message);
    } finally { ocupado = false; }
  });
  // Avisos del webhook que no se pudieron procesar
  cron.schedule('*/5 * * * *', () => barrerPendientes());
  setTimeout(barrerPendientes, 20000);
  console.log('⏰ Scheduler activo (campañas, recordatorios, tareas y webhook)');
}

// Recordatorio único por reunión: 24 h antes (si se agendó con margen) y 1 h antes
async function recordatorios() {
  if (!(await config.getBool('recordatorios_activo')) || !(await config.metaConfigurado())) return;
  const tz = await config.get('empresa_zona_horaria');

  const [d24] = await db.query(`
    SELECT d.*, n.nombre, n.contacto_nombre, n.whatsapp, n.telefono_int, n.telefono, n.ultimo_entrante_at, n.id AS nid
    FROM demos d JOIN negocios n ON n.id = d.negocio_id
    WHERE d.estado = 'agendada' AND d.recordatorio_24h = 0
      AND d.fecha_hora > NOW() + INTERVAL 12 HOUR AND d.fecha_hora <= NOW() + INTERVAL 24 HOUR`);
  for (const d of d24) await recordar(d, 'recordatorio_24h', 'mañana', tz);

  const [d1] = await db.query(`
    SELECT d.*, n.nombre, n.contacto_nombre, n.whatsapp, n.telefono_int, n.telefono, n.ultimo_entrante_at, n.id AS nid
    FROM demos d JOIN negocios n ON n.id = d.negocio_id
    WHERE d.estado = 'agendada' AND d.recordatorio_1h = 0
      AND d.fecha_hora > NOW() + INTERVAL 10 MINUTE AND d.fecha_hora <= NOW() + INTERVAL 60 MINUTE`);
  for (const d of d1) await recordar(d, 'recordatorio_1h', 'en 1 hora', tz);
}

async function recordar(d, campo, cuando, tz) {
  await db.query(`UPDATE demos SET ${campo} = 1 WHERE id = ?`, [d.id]); // marcar primero: evita duplicados
  const negocio = { ...d, id: d.nid };
  const fecha = new Date(d.fecha_hora).toLocaleString('es-PE', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
  const enlace = d.enlace || '-';
  let resultado;
  try {
    if (ventanaAbierta(negocio)) {
      const texto = `📅 *Recordatorio*\n\nHola ${d.nombre}, te recordamos tu reunión *${d.titulo || 'programada'}* ${cuando}.\n\n🗓️ ${fecha}${d.enlace ? `\n🔗 ${d.enlace}` : ''}\n\n¡Te esperamos!`;
      await enviarAContacto(negocio, { texto }, { origen: 'recordatorio' });
      resultado = `Recordatorio (${cuando}) enviado por WhatsApp`;
    } else {
      // Fuera de la ventana de 24 h: plantilla del sistema "crm_recordatorio_reunion" (si Meta la aprobó)
      const p = await plantillas.aprobadaPara('recordatorio_reunion');
      if (!p) {
        resultado = `Recordatorio (${cuando}) no enviado: fuera de la ventana de 24 h y la plantilla de recordatorios no está aprobada (WhatsApp → Recordatorios)`;
      } else {
        const valores = {
          contacto: d.contacto_nombre || d.nombre,
          fecha: new Date(d.fecha_hora).toLocaleDateString('es-PE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }),
          hora: new Date(d.fecha_hora).toLocaleTimeString('es-PE', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        };
        await enviarAContacto(negocio, { plantilla: {
          nombre: p.nombre_meta, idioma: p.idioma, params: p.variables.map(k => valores[k] || '-'), cuerpo: p.cuerpo,
        } }, { origen: 'recordatorio' });
        resultado = `Recordatorio (${cuando}) enviado por WhatsApp`;
      }
    }
  } catch (e) {
    resultado = `Error al enviar recordatorio (${cuando}): ${e.message}`;
  }
  await db.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario) VALUES (?,?,?,?)',
    [d.negocio_id, 'reunion', resultado, 'Sistema']);
  if (d.asignado_a) await notificar([d.asignado_a], {
    tipo: 'reunion', titulo: `Reunión ${cuando}: ${d.nombre}`, cuerpo: fecha, enlace: '#/agenda',
  });
}

async function tareasPorVencer() {
  const [rows] = await db.query(`
    SELECT t.id, t.titulo, t.asignado_a, t.vence_at, n.nombre AS negocio_nombre
    FROM tareas t LEFT JOIN negocios n ON n.id = t.negocio_id
    WHERE t.estado = 'pendiente' AND t.notificada = 0 AND t.asignado_a IS NOT NULL
      AND t.vence_at IS NOT NULL AND t.vence_at <= NOW() + INTERVAL 15 MINUTE`);
  for (const t of rows) {
    await db.query('UPDATE tareas SET notificada = 1 WHERE id = ?', [t.id]);
    await notificar([t.asignado_a], {
      tipo: 'tarea', titulo: `Tarea por vencer: ${t.titulo}`,
      cuerpo: t.negocio_nombre ? `Contacto: ${t.negocio_nombre}` : null, enlace: '#/tareas',
    });
  }
}

module.exports = { iniciar };
