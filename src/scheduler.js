const cron = require('node-cron');
const db   = require('./db');
const wa   = require('./whatsapp');
const path = require('path');

function iniciar() {
  // Revisar cada minuto si hay recordatorios pendientes
  cron.schedule('* * * * *', async () => {
    try {
      const ahora     = new Date();
      const en1h      = new Date(ahora.getTime() + 60 * 60 * 1000);
      const en24h     = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
      const ventana   = 60 * 1000; // ± 1 minuto de tolerancia

      // Recordatorio 1 hora antes
      const [demos1h] = await db.execute(`
        SELECT d.*, n.nombre, n.whatsapp, n.telefono_int
        FROM demos d
        JOIN negocios n ON n.id = d.negocio_id
        WHERE d.estado = 'agendada'
          AND d.recordatorio_1h = 0
          AND ABS(TIMESTAMPDIFF(SECOND, d.fecha_hora, ?)) <= 3600 + 60
          AND d.fecha_hora > NOW()
      `, [en1h]);

      for (const demo of demos1h) {
        const numero = limpiarNumero(demo.whatsapp || demo.telefono_int);
        if (!numero) continue;

        const fecha = new Date(demo.fecha_hora).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' });
        const msg = `🔔 *Recordatorio de reunión*\n\nHola ${demo.nombre}, te recordamos que tienes una ${demo.tipo === 'virtual' ? 'reunión virtual' : 'demo'} programada en *1 hora*.\n\n📅 Fecha: ${fecha}\n${demo.enlace ? `🔗 Enlace: ${demo.enlace}` : ''}\n\n¡Nos vemos pronto! 👋`;

        try {
          await wa.enviarMensaje({ numero, texto: msg });
          await db.execute('UPDATE demos SET recordatorio_1h=1 WHERE id=?', [demo.id]);
          await db.execute(
            'INSERT INTO crm_historial (negocio_id, tipo, contenido) VALUES (?,?,?)',
            [demo.negocio_id, 'demo', `Recordatorio 1h enviado por WhatsApp`]
          );
          console.log(`📲 Recordatorio 1h enviado a ${demo.nombre}`);
        } catch (e) {
          console.error(`Error enviando recordatorio 1h a ${demo.nombre}:`, e.message);
        }
      }

      // Recordatorio 24 horas antes
      const [demos24h] = await db.execute(`
        SELECT d.*, n.nombre, n.whatsapp, n.telefono_int
        FROM demos d
        JOIN negocios n ON n.id = d.negocio_id
        WHERE d.estado = 'agendada'
          AND d.recordatorio_24h = 0
          AND ABS(TIMESTAMPDIFF(SECOND, d.fecha_hora, ?)) <= 86400 + 60
          AND d.fecha_hora > NOW()
      `, [en24h]);

      for (const demo of demos24h) {
        const numero = limpiarNumero(demo.whatsapp || demo.telefono_int);
        if (!numero) continue;

        const fecha = new Date(demo.fecha_hora).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'full', timeStyle: 'short' });
        const msg = `📅 *Recordatorio de reunión — Mañana*\n\nHola ${demo.nombre}, mañana tienes programada una ${demo.tipo === 'virtual' ? 'reunión virtual' : 'demo'} con nosotros.\n\n🗓️ ${fecha}\n${demo.enlace ? `🔗 ${demo.enlace}` : ''}\n\nConfírmanos tu asistencia respondiendo este mensaje. ¡Gracias! 🙌`;

        try {
          await wa.enviarMensaje({ numero, texto: msg });
          await db.execute('UPDATE demos SET recordatorio_24h=1 WHERE id=?', [demo.id]);
          await db.execute(
            'INSERT INTO crm_historial (negocio_id, tipo, contenido) VALUES (?,?,?)',
            [demo.negocio_id, 'demo', `Recordatorio 24h enviado por WhatsApp`]
          );
          console.log(`📲 Recordatorio 24h enviado a ${demo.nombre}`);
        } catch (e) {
          console.error(`Error enviando recordatorio 24h:`, e.message);
        }
      }
    } catch (e) {
      console.error('Scheduler error:', e.message);
    }
  });

  console.log('⏰ Scheduler de recordatorios activo');
}

function limpiarNumero(tel) {
  if (!tel) return null;
  const limpio = tel.replace(/[^0-9]/g, '');
  if (limpio.length < 8) return null;
  if (limpio.startsWith('51')) return limpio;
  if (limpio.startsWith('9') && limpio.length === 9) return '51' + limpio;
  return limpio;
}

module.exports = { iniciar };
