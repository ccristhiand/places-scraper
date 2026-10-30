// Proyectos de desarrollo: cálculos de pagos y alertas automáticas
const db = require('../db');
const { notificar } = require('./notificar');

const ACTIVOS = ['aprobado', 'desarrollo', 'pruebas'];
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
// Fecha YYYY-MM-DD en Lima (no UTC), con desplazamiento en días
const fechaLima = (dias = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(Date.now() + dias * 864e5));

// Los cobros cubren las cuotas en orden (adelanto primero). Marca cada cuota como pagada/parcial/vencida.
function aplicarPagos(cuotas, pagado) {
  let resto = r2(pagado);
  const hoy = fechaLima();
  return cuotas.map(c => {
    const monto = r2(c.monto);
    const cubierto = Math.min(resto, monto);
    resto = r2(resto - cubierto);
    const estado = cubierto >= monto ? 'pagada' : cubierto > 0 ? 'parcial' : (c.vence_at && c.vence_at < hoy ? 'vencida' : 'pendiente');
    return { ...c, monto, cubierto: r2(cubierto), estado: estado === 'parcial' && c.vence_at && c.vence_at < hoy ? 'vencida' : estado };
  });
}

async function cuotasDe(ids) {
  if (!ids.length) return {};
  const [rows] = await db.query(`SELECT id, proyecto_id, orden, concepto, monto, DATE_FORMAT(vence_at, '%Y-%m-%d') AS vence_at, aviso_previo, aviso_vencida
    FROM proyecto_cuotas WHERE proyecto_id IN (?) ORDER BY proyecto_id, orden, id`, [ids]);
  const out = {};
  rows.forEach(c => { (out[c.proyecto_id] = out[c.proyecto_id] || []).push(c); });
  return out;
}

async function registrarHistorial(p, contenido, usuario = null) {
  await db.query('INSERT INTO crm_historial (negocio_id, proyecto_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?,?)',
    [p.negocio_id, p.id, 'proyecto', `${p.codigo} · ${contenido}`, usuario?.nombre || 'Sistema', usuario?.id || null]);
  await db.query('UPDATE negocios SET ultima_actividad_at = NOW() WHERE id = ?', [p.negocio_id]);
}

// Valor del cliente en el pipeline = suma de sus proyectos aprobados (no propuestas ni cancelados)
async function actualizarValorCliente(negocioId) {
  await db.query(`UPDATE negocios SET valor_estimado = (
      SELECT NULLIF(SUM(monto), 0) FROM proyectos WHERE negocio_id = ? AND estado NOT IN ('propuesta','cancelado'))
    WHERE id = ? AND EXISTS (SELECT 1 FROM proyectos WHERE negocio_id = ? AND estado NOT IN ('propuesta','cancelado'))`,
    [negocioId, negocioId, negocioId]);
}

const destinatarios = p => [p.responsable_id || p.creado_por].filter(Boolean);
const dinero = (v, moneda = 'PEN') => Number(v || 0).toLocaleString('es-PE', { style: 'currency', currency: moneda, maximumFractionDigits: 2, minimumFractionDigits: 0 });
const fechaLarga = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('es-PE', { day: 'numeric', month: 'long' });

// Aviso al cliente por WhatsApp con una plantilla del sistema (si está aprobada). Nunca lanza.
async function avisarCliente(p, uso, valores) {
  try {
    const plantilla = await require('./plantillas').aprobadaPara(uso);
    if (!plantilla) {
      await registrarHistorial(p, `Aviso por WhatsApp no enviado: la plantilla "${uso}" no está aprobada (WhatsApp → Recordatorios)`);
      return false;
    }
    const [[n]] = await db.query('SELECT * FROM negocios WHERE id = ?', [p.negocio_id]);
    const v = { contacto: n.contacto_nombre || n.nombre, proyecto: p.nombre, ...valores };
    await require('./mensajeria').enviarAContacto(n, { plantilla: {
      nombre: plantilla.nombre_meta, idioma: plantilla.idioma, params: plantilla.variables.map(k => v[k] ?? '-'), cuerpo: plantilla.cuerpo,
    } }, { origen: 'proyecto' });
    await registrarHistorial(p, `Aviso enviado al cliente por WhatsApp (${uso === 'proyecto_cuota' ? 'cuota por vencer' : 'entrega'})`);
    return true;
  } catch (e) {
    await registrarHistorial(p, `No se pudo avisar al cliente por WhatsApp: ${e.message}`).catch(() => {});
    return false;
  }
}

// Avance = peso de los hitos completados / peso total
async function avances(ids) {
  if (!ids.length) return {};
  const [rows] = await db.query(`SELECT proyecto_id, SUM(peso) AS total, SUM(IF(completado = 1, peso, 0)) AS hecho, COUNT(*) AS n
    FROM proyecto_hitos WHERE proyecto_id IN (?) GROUP BY proyecto_id`, [ids]);
  return Object.fromEntries(rows.map(r => [r.proyecto_id, { pct: r.total ? Math.round((r.hecho / r.total) * 100) : 0, hitos: Number(r.n) }]));
}

// Rentabilidad: ingreso sin IGV − horas × costo por hora
async function rentabilidad(p) {
  const [[h]] = await db.query('SELECT COALESCE(SUM(horas), 0) AS horas FROM proyecto_horas WHERE proyecto_id = ?', [p.id]);
  const costoHora = Number(p.costo_hora ?? 0) || Number((await require('./config').get('proyectos_costo_hora')) || 0);
  // El monto ya incluye los adicionales aprobados (cambios de alcance e incidencias cobradas)
  const [[ad]] = await db.query("SELECT COALESCE(SUM(monto), 0) AS m FROM proyecto_cambios WHERE proyecto_id = ? AND estado = 'aprobado'", [p.id]);
  const bruto = r2(p.monto);
  const ingreso = r2(Number(p.incluye_igv) ? bruto / 1.18 : bruto);
  const horas = r2(h.horas);
  const costo = r2(horas * costoHora);
  return {
    horas, horas_estimadas: p.horas_estimadas !== null ? Number(p.horas_estimadas) : null, costo_hora: costoHora,
    ingreso, costo, margen: r2(ingreso - costo), margen_pct: ingreso ? Math.round(((ingreso - costo) / ingreso) * 100) : null,
    tarifa_efectiva: horas ? r2(ingreso / horas) : null, adicionales: r2(ad.m),
  };
}

// Se ejecuta cada hora desde el scheduler
async function alertas() {
  // 1) Cuotas por vencer (3 días) y vencidas
  const waCobros = await require('./config').getBool('proyectos_wa_cobros');
  const [proys] = await db.query(`SELECT p.id, p.codigo, p.nombre, p.negocio_id, p.responsable_id, p.creado_por, p.moneda, n.nombre AS cliente,
      COALESCE((SELECT SUM(monto) FROM proyecto_pagos x WHERE x.proyecto_id = p.id), 0) AS pagado
    FROM proyectos p JOIN negocios n ON n.id = p.negocio_id
    WHERE p.estado NOT IN ('propuesta','cancelado')
      AND EXISTS (SELECT 1 FROM proyecto_cuotas c WHERE c.proyecto_id = p.id AND (c.aviso_previo = 0 OR c.aviso_vencida = 0))`);
  const cuotas = await cuotasDe(proys.map(p => p.id));
  const hoy = fechaLima();
  const en3 = fechaLima(3);
  for (const p of proys) {
    for (const c of aplicarPagos(cuotas[p.id] || [], p.pagado)) {
      if (c.estado === 'pagada' || !c.vence_at) continue;
      if (c.vence_at < hoy && !c.aviso_vencida) {
        await db.query('UPDATE proyecto_cuotas SET aviso_vencida = 1, aviso_previo = 1 WHERE id = ?', [c.id]);
        await notificar(destinatarios(p), { tipo: 'alerta', titulo: `Cuota vencida: ${p.cliente}`, cuerpo: `${p.codigo} · ${c.concepto}`, enlace: `#/proyectos/${p.id}` });
      } else if (c.vence_at >= hoy && c.vence_at <= en3 && !c.aviso_previo) {
        await db.query('UPDATE proyecto_cuotas SET aviso_previo = 1 WHERE id = ?', [c.id]);
        await notificar(destinatarios(p), { tipo: 'info', titulo: `Cuota por cobrar: ${p.cliente}`, cuerpo: `${p.codigo} · ${c.concepto} vence el ${c.vence_at}`, enlace: `#/proyectos/${p.id}` });
        if (waCobros) await avisarCliente(p, 'proyecto_cuota', { concepto: c.concepto, monto: dinero(c.monto - c.cubierto, p.moneda), fecha: fechaLarga(c.vence_at) });
      }
    }
  }

  // 2) Entregas en 3 días o atrasadas
  const [entregas] = await db.query(`SELECT p.*, n.nombre AS cliente, DATEDIFF(p.fecha_entrega_estimada, CURDATE()) AS dias
    FROM proyectos p JOIN negocios n ON n.id = p.negocio_id
    WHERE p.estado IN (?) AND p.aviso_entrega = 0 AND p.fecha_entrega_estimada IS NOT NULL
      AND p.fecha_entrega_estimada <= CURDATE() + INTERVAL 3 DAY`, [ACTIVOS]);
  for (const p of entregas) {
    await db.query('UPDATE proyectos SET aviso_entrega = 1 WHERE id = ?', [p.id]);
    const cuando = p.dias < 0 ? `atrasada ${-p.dias} día(s)` : p.dias === 0 ? 'vence hoy' : `en ${p.dias} día(s)`;
    await notificar(destinatarios(p), { tipo: 'alerta', titulo: `Entrega ${cuando}: ${p.nombre}`, cuerpo: `${p.codigo} · ${p.cliente}`, enlace: `#/proyectos/${p.id}` });
  }

  // 3) Soporte por vencer (7 días): tarea para ofrecer mantenimiento
  const [soporte] = await db.query(`SELECT p.*, n.nombre AS cliente, DATE_FORMAT(p.fecha_fin_soporte, '%Y-%m-%d') AS fin
    FROM proyectos p JOIN negocios n ON n.id = p.negocio_id
    WHERE p.estado = 'soporte' AND p.aviso_soporte = 0 AND p.fecha_fin_soporte <= CURDATE() + INTERVAL 7 DAY`);
  for (const p of soporte) {
    await db.query('UPDATE proyectos SET aviso_soporte = 1 WHERE id = ?', [p.id]);
    const uid = p.responsable_id || p.creado_por;
    await db.query('INSERT INTO tareas SET ?', [{
      titulo: `Ofrecer plan de mantenimiento a ${p.cliente}`.slice(0, 255),
      descripcion: `El soporte de "${p.nombre}" (${p.codigo}) vence el ${p.fin}. Es buen momento para proponer un plan mensual de mantenimiento.`,
      negocio_id: p.negocio_id, proyecto_id: p.id, asignado_a: uid, creado_por: null,
      vence_at: `${p.fin} 10:00:00`, prioridad: 'alta',
    }]);
    await notificar([uid], { tipo: 'tarea', titulo: `Soporte por vencer: ${p.cliente}`, cuerpo: `${p.codigo} · vence el ${p.fin}`, enlace: `#/proyectos/${p.id}` });
  }

  // 4) Soporte vencido → proyecto cerrado
  const [vencidos] = await db.query("SELECT * FROM proyectos WHERE estado = 'soporte' AND fecha_fin_soporte < CURDATE()");
  for (const p of vencidos) {
    await db.query("UPDATE proyectos SET estado = 'cerrado' WHERE id = ?", [p.id]);
    await registrarHistorial(p, 'Terminó el período de soporte: proyecto cerrado');
  }
}

module.exports = { ACTIVOS, r2, fechaLima, dinero, aplicarPagos, cuotasDe, registrarHistorial, actualizarValorCliente, alertas, avisarCliente, avances, rentabilidad };
