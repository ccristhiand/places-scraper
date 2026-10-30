// Proyectos de desarrollo por cliente: monto, tiempo, soporte y plan de pagos
// Estados: propuesta → aprobado → desarrollo ⇄ pruebas → soporte → cerrado (+ pausado, cancelado)
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { asegurarAcceso } = require('../lib/filtros');
const config  = require('../lib/config');
const { upload, uploadDoc } = require('../lib/uploads');
const { notificar } = require('../lib/notificar');
const { ah, HttpError, texto, entero } = require('../lib/utils');
const { ACTIVOS, r2, fechaLima, aplicarPagos, cuotasDe, registrarHistorial, actualizarValorCliente,
        avisarCliente, avances, rentabilidad } = require('../lib/proyectos');

const TIPOS   = ['web', 'app', 'sistema', 'ecommerce', 'integracion', 'mantenimiento', 'otro'];
const MONEDAS = ['PEN', 'USD'];
const METODOS = ['transferencia', 'yape', 'plin', 'efectivo', 'tarjeta', 'otro'];
const NOMBRE_ESTADO = { propuesta: 'Propuesta', aprobado: 'Aprobado', desarrollo: 'En desarrollo', pruebas: 'En pruebas',
  soporte: 'En soporte', cerrado: 'Cerrado', pausado: 'Pausado', cancelado: 'Cancelado' };
// Acciones permitidas según el estado actual
const TRANSICIONES = {
  propuesta:  ['aprobado', 'cancelado'],
  aprobado:   ['desarrollo', 'pausado', 'cancelado'],
  desarrollo: ['pruebas', 'entregar', 'pausado', 'cancelado'],
  pruebas:    ['desarrollo', 'entregar', 'pausado', 'cancelado'],
  pausado:    ['desarrollo', 'cancelado'],
  soporte:    ['cerrado', 'desarrollo'],
  cerrado:    [],
  cancelado:  ['propuesta'],
};

const FECHAS = `DATE_FORMAT(p.fecha_inicio, '%Y-%m-%d') AS fecha_inicio,
  DATE_FORMAT(p.fecha_entrega_estimada, '%Y-%m-%d') AS fecha_entrega_estimada,
  DATE_FORMAT(p.fecha_entrega_real, '%Y-%m-%d') AS fecha_entrega_real,
  DATE_FORMAT(p.fecha_fin_soporte, '%Y-%m-%d') AS fecha_fin_soporte`;

const SELECT = `SELECT p.id, p.codigo, p.nombre, p.tipo, p.estado, p.alcance, p.moneda, p.monto, p.monto_base, p.incluye_igv,
    p.duracion_dias, p.dias_soporte, p.horas_estimadas, p.costo_hora,
    p.url_repo, p.url_demo, p.url_produccion, p.notas, p.created_at, ${FECHAS},
    (SELECT COUNT(*) FROM proyecto_tickets t WHERE t.proyecto_id = p.id AND t.estado IN ('abierto','en_proceso')) AS tickets_abiertos,
    p.negocio_id, n.nombre AS cliente, n.contacto_nombre, n.whatsapp, n.asignado_a,
    p.responsable_id, u.nombre AS responsable_nombre, p.creado_por,
    COALESCE((SELECT SUM(x.monto) FROM proyecto_pagos x WHERE x.proyecto_id = p.id), 0) AS pagado,
    DATEDIFF(p.fecha_fin_soporte, CURDATE()) AS dias_soporte_restantes,
    DATEDIFF(p.fecha_entrega_estimada, CURDATE()) AS dias_para_entrega
  FROM proyectos p JOIN negocios n ON n.id = p.negocio_id LEFT JOIN usuarios u ON u.id = p.responsable_id`;

// Alcance: sin "ver_todos" se ven los proyectos de clientes propios o donde soy responsable
function alcance(req, w, v) {
  if (req.user.can('contactos.ver_todos')) return;
  w.push('(n.asignado_a = ? OR p.responsable_id = ?)');
  v.push(req.user.id, req.user.id);
}

function enriquecer(p, cuotas, req) {
  p.pagado = r2(p.pagado);
  p.monto = r2(p.monto);
  p.saldo = r2(p.monto - p.pagado);
  p.atrasado = ACTIVOS.includes(p.estado) && p.dias_para_entrega !== null && p.dias_para_entrega < 0;
  const plan = aplicarPagos(cuotas || [], p.pagado);
  p.proxima_cuota = plan.find(c => c.estado !== 'pagada') || null;
  p.cuotas_vencidas = plan.filter(c => c.estado === 'vencida').length;
  p.tickets_abiertos = Number(p.tickets_abiertos || 0);
  if (!req.user.can('proyectos.montos')) {
    for (const k of ['monto', 'monto_base', 'pagado', 'saldo', 'proxima_cuota', 'cuotas_vencidas', 'incluye_igv', 'costo_hora']) delete p[k];
  }
  return p;
}

async function cargar(req, id) {
  const w = ['p.id = ?'], v = [id];
  alcance(req, w, v);
  const [[p]] = await db.query(`${SELECT} WHERE ${w.join(' AND ')}`, v);
  if (!p) throw new HttpError(404, 'Proyecto no encontrado');
  return p;
}

// ── Listado + resumen ─────────────────────────────────────────────────────
router.get('/', requirePerm('proyectos.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  alcance(req, w, v);
  if (req.query.negocio_id) { w.push('p.negocio_id = ?'); v.push(parseInt(req.query.negocio_id, 10)); }
  if (req.query.estado === 'activos') { w.push('p.estado IN (?)'); v.push(ACTIVOS); }
  else if (req.query.estado) { w.push('p.estado = ?'); v.push(req.query.estado); }
  if (req.query.responsable === 'yo') { w.push('p.responsable_id = ?'); v.push(req.user.id); }
  else if (req.query.responsable) { w.push('p.responsable_id = ?'); v.push(parseInt(req.query.responsable, 10)); }
  if (req.query.tipo) { w.push('p.tipo = ?'); v.push(req.query.tipo); }
  if (req.query.q) { const s = `%${req.query.q}%`; w.push('(p.nombre LIKE ? OR p.codigo LIKE ? OR n.nombre LIKE ?)'); v.push(s, s, s); }

  const [rows] = await db.query(`${SELECT} WHERE ${w.join(' AND ')}
    ORDER BY FIELD(p.estado,'desarrollo','pruebas','aprobado','soporte','propuesta','pausado','cerrado','cancelado'), p.fecha_entrega_estimada IS NULL, p.fecha_entrega_estimada, p.id DESC
    LIMIT 500`, v);
  const [cuotas, av] = await Promise.all([cuotasDe(rows.map(r => r.id)), avances(rows.map(r => r.id))]);
  rows.forEach(p => { enriquecer(p, cuotas[p.id], req); p.avance = av[p.id]?.pct ?? null; });

  const resumen = {
    activos: rows.filter(p => ACTIVOS.includes(p.estado)).length,
    atrasados: rows.filter(p => p.atrasado).length,
    soporte_por_vencer: rows.filter(p => p.estado === 'soporte' && p.dias_soporte_restantes !== null && p.dias_soporte_restantes <= 7).length,
    en_soporte: rows.filter(p => p.estado === 'soporte').length,
  };
  if (req.user.can('proyectos.montos')) {
    const porMoneda = (fn) => rows.filter(fn).reduce((acc, p) => { acc[p.moneda] = r2((acc[p.moneda] || 0) + p.saldo); return acc; }, {});
    resumen.por_cobrar = porMoneda(p => !['propuesta', 'cancelado'].includes(p.estado) && p.saldo > 0);
    resumen.cuotas_vencidas = rows.reduce((s, p) => s + (p.cuotas_vencidas || 0), 0);
  }
  res.json({ ok: true, rows, resumen, estados: NOMBRE_ESTADO, transiciones: TRANSICIONES });
}));

router.get('/:id', requirePerm('proyectos.ver'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const cuotas = (await cuotasDe([p.id]))[p.id] || [];
  enriquecer(p, cuotas, req);
  let plan = [], pagos = [];
  if (req.user.can('proyectos.montos')) {
    plan = aplicarPagos(cuotas, p.pagado);
    [pagos] = await db.query(`SELECT x.id, x.monto, DATE_FORMAT(x.fecha, '%Y-%m-%d') AS fecha, x.metodo, x.referencia, x.comprobante_url,
        u.nombre AS registrado_por_nombre, x.created_at
      FROM proyecto_pagos x LEFT JOIN usuarios u ON u.id = x.registrado_por WHERE x.proyecto_id = ? ORDER BY x.fecha DESC, x.id DESC`, [p.id]);
  }
  const [historial] = await db.query(`SELECT id, tipo, contenido, usuario, created_at FROM crm_historial
    WHERE proyecto_id = ? ORDER BY id DESC LIMIT 100`, [p.id]);
  const [tareas] = await db.query(`SELECT t.id, t.titulo, t.estado, t.vence_at, u.nombre AS asignado_nombre FROM tareas t
    LEFT JOIN usuarios u ON u.id = t.asignado_a WHERE t.proyecto_id = ? ORDER BY t.estado = 'completada', t.vence_at`, [p.id]);
  const [hitos] = await db.query(`SELECT h.id, h.orden, h.titulo, h.descripcion, DATE_FORMAT(h.fecha_objetivo, '%Y-%m-%d') AS fecha_objetivo,
      h.peso, h.completado, h.completado_at, u.nombre AS completado_por_nombre
    FROM proyecto_hitos h LEFT JOIN usuarios u ON u.id = h.completado_por WHERE h.proyecto_id = ? ORDER BY h.orden, h.id`, [p.id]);
  const [cambios] = await db.query(`SELECT c.*, u.nombre AS creado_por_nombre FROM proyecto_cambios c LEFT JOIN usuarios u ON u.id = c.creado_por
    WHERE c.proyecto_id = ? ORDER BY c.id DESC`, [p.id]);
  const [tickets] = await db.query(`SELECT t.*, a.nombre AS asignado_nombre, c.nombre AS creado_por_nombre,
      (SELECT COALESCE(SUM(horas), 0) FROM proyecto_horas hh WHERE hh.ticket_id = t.id) AS horas
    FROM proyecto_tickets t LEFT JOIN usuarios a ON a.id = t.asignado_a LEFT JOIN usuarios c ON c.id = t.creado_por
    WHERE t.proyecto_id = ? ORDER BY FIELD(t.estado,'abierto','en_proceso','resuelto','cerrado'), FIELD(t.prioridad,'urgente','alta','media','baja'), t.id DESC`, [p.id]);
  const [horas] = await db.query(`SELECT h.id, DATE_FORMAT(h.fecha, '%Y-%m-%d') AS fecha, h.horas, h.descripcion, h.usuario_id, u.nombre AS usuario_nombre,
      h.hito_id, h.ticket_id FROM proyecto_horas h LEFT JOIN usuarios u ON u.id = h.usuario_id WHERE h.proyecto_id = ? ORDER BY h.fecha DESC, h.id DESC LIMIT 100`, [p.id]);
  const [horasPorUsuario] = await db.query(`SELECT u.nombre, SUM(h.horas) AS horas FROM proyecto_horas h LEFT JOIN usuarios u ON u.id = h.usuario_id
    WHERE h.proyecto_id = ? GROUP BY h.usuario_id, u.nombre ORDER BY horas DESC`, [p.id]);
  const [archivos] = await db.query(`SELECT a.id, a.tipo, a.nombre, a.url, a.tamano, a.mime, a.created_at, u.nombre AS subido_por_nombre
    FROM proyecto_archivos a LEFT JOIN usuarios u ON u.id = a.subido_por WHERE a.proyecto_id = ? ORDER BY a.id DESC`, [p.id]);

  const total = hitos.reduce((s, h) => s + Number(h.peso), 0);
  p.avance = total ? Math.round((hitos.filter(h => h.completado).reduce((s, h) => s + Number(h.peso), 0) / total) * 100) : null;
  const montos = req.user.can('proyectos.montos');
  if (!montos) {
    cambios.forEach(c => delete c.monto);
    tickets.forEach(t => delete t.monto_adicional);
  }
  res.json({
    ok: true, proyecto: p, cuotas: plan, pagos, historial, tareas, hitos, cambios, tickets, horas,
    horas_por_usuario: horasPorUsuario.map(h => ({ nombre: h.nombre || '—', horas: r2(h.horas) })),
    horas_total: r2(horasPorUsuario.reduce((s, h) => s + Number(h.horas), 0)),
    archivos, rentabilidad: montos ? await rentabilidad({ ...p, monto: p.monto }) : null,
    transiciones: TRANSICIONES[p.estado] || [],
  });
}));

// ── Crear / editar ────────────────────────────────────────────────────────
function leer(b, req, previo = {}) {
  const val = (k, f) => (b[k] !== undefined ? f(b[k]) : previo[k]);
  const fecha = x => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  const url = x => { const s = texto(x, 500); if (s && !/^https?:\/\//i.test(s)) throw new HttpError(422, 'Los enlaces deben empezar con http:// o https://'); return s; };
  const d = {
    nombre: val('nombre', x => texto(x, 200)),
    tipo: val('tipo', x => (TIPOS.includes(x) ? x : 'otro')),
    alcance: val('alcance', x => texto(x, 10000)),
    responsable_id: val('responsable_id', x => parseInt(x, 10) || null),
    fecha_inicio: val('fecha_inicio', fecha),
    duracion_dias: val('duracion_dias', x => (x === '' || x === null ? null : entero(x, null, 1, 3650))),
    dias_soporte: val('dias_soporte', x => entero(x, 30, 0, 3650)),
    horas_estimadas: val('horas_estimadas', x => (x === '' || x === null ? null : Math.max(0, r2(parseFloat(x) || 0)))),
    url_repo: val('url_repo', url), url_demo: val('url_demo', url), url_produccion: val('url_produccion', url),
    notas: val('notas', x => texto(x, 5000)),
  };
  if (req.user.can('proyectos.montos')) {
    d.moneda = val('moneda', x => (MONEDAS.includes(x) ? x : 'PEN'));
    d.monto = val('monto', x => Math.max(0, r2(parseFloat(x) || 0)));
    d.incluye_igv = val('incluye_igv', x => (x === true || x === '1' || x === 1 ? 1 : 0));
    d.costo_hora = val('costo_hora', x => (x === '' || x === null ? null : Math.max(0, r2(parseFloat(x) || 0))));
  }
  if (!d.nombre) throw new HttpError(422, 'Ponle un nombre al proyecto.');
  Object.keys(d).forEach(k => d[k] === undefined && delete d[k]);
  return d;
}

// Fecha de entrega = inicio + duración; fin de soporte = entrega real + días de soporte
async function recalcularFechas(id) {
  await db.query(`UPDATE proyectos SET
      fecha_entrega_estimada = IF(fecha_inicio IS NOT NULL AND duracion_dias IS NOT NULL, DATE_ADD(fecha_inicio, INTERVAL duracion_dias DAY), fecha_entrega_estimada),
      fecha_fin_soporte = IF(fecha_entrega_real IS NOT NULL, DATE_ADD(fecha_entrega_real, INTERVAL dias_soporte DAY), NULL)
    WHERE id = ?`, [id]);
}

async function siguienteCodigo() {
  const anio = fechaLima().slice(0, 4);
  const [[r]] = await db.query("SELECT MAX(CAST(SUBSTRING_INDEX(codigo, '-', -1) AS UNSIGNED)) AS n FROM proyectos WHERE codigo LIKE ?", [`PRY-${anio}-%`]);
  return `PRY-${anio}-${String((r.n || 0) + 1).padStart(3, '0')}`;
}

function leerCuotas(lista, monto) {
  if (!Array.isArray(lista)) return null;
  const cuotas = lista.map((c, i) => ({
    concepto: texto(c.concepto, 150) || `Cuota ${i + 1}`,
    monto: r2(parseFloat(c.monto) || 0),
    vence_at: c.vence_at && /^\d{4}-\d{2}-\d{2}$/.test(c.vence_at) ? c.vence_at : null,
    orden: i,
  })).filter(c => c.monto > 0);
  const total = r2(cuotas.reduce((s, c) => s + c.monto, 0));
  if (total > r2(monto) + 0.01) throw new HttpError(422, `Las cuotas suman ${total} y superan el monto del proyecto (${r2(monto)}).`);
  return cuotas;
}

async function guardarCuotas(proyectoId, cuotas) {
  await db.query('DELETE FROM proyecto_cuotas WHERE proyecto_id = ?', [proyectoId]);
  for (const c of cuotas) await db.query('INSERT INTO proyecto_cuotas SET ?', [{ ...c, proyecto_id: proyectoId }]);
}

router.post('/', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const negocioId = parseInt(req.body.negocio_id, 10);
  if (!negocioId) throw new HttpError(422, 'Elige el cliente del proyecto.');
  await asegurarAcceso(req, negocioId);
  const d = leer(req.body, req);
  d.negocio_id = negocioId;
  d.creado_por = req.user.id;
  d.responsable_id = d.responsable_id || req.user.id;
  d.estado = req.body.estado === 'aprobado' ? 'aprobado' : 'propuesta';
  d.monto_base = d.monto ?? 0;
  const cuotas = req.user.can('proyectos.montos') ? leerCuotas(req.body.cuotas, d.monto || 0) : null;

  let id;
  for (let intento = 0; intento < 3 && !id; intento++) {
    try { d.codigo = await siguienteCodigo(); [{ insertId: id }] = await db.query('INSERT INTO proyectos SET ?', [d]); }
    catch (e) { if (e.code !== 'ER_DUP_ENTRY' || intento === 2) throw e; }
  }
  await recalcularFechas(id);
  if (cuotas) await guardarCuotas(id, cuotas);
  const p = { id, codigo: d.codigo, negocio_id: negocioId };
  await registrarHistorial(p, `Proyecto creado: ${d.nombre} (${d.estado === 'aprobado' ? 'aprobado' : 'propuesta'})`, req.user);
  if (d.estado === 'aprobado') await alAprobar(p, req.user);
  await audit(req, 'proyecto_creado', { entidad: 'proyecto', entidadId: id, detalle: { codigo: d.codigo, cliente: negocioId } });
  res.status(201).json({ ok: true, id, codigo: d.codigo });
}));

router.put('/:id', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const previo = await cargar(req, parseInt(req.params.id, 10));
  const d = leer(req.body, req, previo);
  delete d.estado;
  await db.query('UPDATE proyectos SET ? WHERE id = ?', [d, previo.id]);
  await recalcularFechas(previo.id);
  // Si cambió la fecha de entrega o el soporte, los avisos vuelven a programarse
  if (['fecha_inicio', 'duracion_dias'].some(k => d[k] !== undefined && String(d[k]) !== String(previo[k])))
    await db.query('UPDATE proyectos SET aviso_entrega = 0 WHERE id = ?', [previo.id]);
  if (d.dias_soporte !== undefined && Number(d.dias_soporte) !== Number(previo.dias_soporte))
    await db.query('UPDATE proyectos SET aviso_soporte = 0 WHERE id = ?', [previo.id]);
  if (req.user.can('proyectos.montos') && Array.isArray(req.body.cuotas)) {
    await guardarCuotas(previo.id, leerCuotas(req.body.cuotas, d.monto ?? previo.monto));
  }
  if (d.monto !== undefined && Number(d.monto) !== Number(previo.monto)) {
    // El monto total incluye los adicionales aprobados: el monto base es lo restante
    await db.query(`UPDATE proyectos SET monto_base = monto - COALESCE((SELECT SUM(monto) FROM proyecto_cambios WHERE proyecto_id = ? AND estado = 'aprobado'), 0)
      WHERE id = ?`, [previo.id, previo.id]);
    await actualizarValorCliente(previo.negocio_id);
  }
  res.json({ ok: true });
}));

// ── Cambio de estado ──────────────────────────────────────────────────────
async function alAprobar(p, usuario) {
  // El cliente pasa a la etapa "ganada" del pipeline con el valor de sus proyectos
  const [[n]] = await db.query('SELECT n.estado_crm, e.tipo FROM negocios n LEFT JOIN etapas e ON e.clave = n.estado_crm WHERE n.id = ?', [p.negocio_id]);
  const [[ganada]] = await db.query("SELECT clave, nombre FROM etapas WHERE tipo = 'ganada' ORDER BY orden LIMIT 1");
  if (ganada && n && n.tipo !== 'ganada') {
    await db.query('UPDATE negocios SET estado_crm = ? WHERE id = ?', [ganada.clave, p.negocio_id]);
    await db.query('INSERT INTO crm_historial (negocio_id, proyecto_id, tipo, estado_anterior, estado_nuevo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?,?,?,?)',
      [p.negocio_id, p.id, 'estado', n.estado_crm, ganada.clave, `Movido a ${ganada.nombre}: se aprobó el proyecto ${p.codigo}`, usuario?.nombre || 'Sistema', usuario?.id || null]);
  }
  await actualizarValorCliente(p.negocio_id);
}

router.post('/:id/estado', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const accion = String(req.body.estado || '');
  if (!(TRANSICIONES[p.estado] || []).includes(accion)) throw new HttpError(422, `Un proyecto ${NOMBRE_ESTADO[p.estado]?.toLowerCase()} no puede pasar a ese estado.`);

  if (accion === 'entregar') {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : fechaLima();
    const nuevo = Number(p.dias_soporte) > 0 ? 'soporte' : 'cerrado';
    await db.query('UPDATE proyectos SET estado = ?, fecha_entrega_real = ?, aviso_soporte = 0 WHERE id = ?', [nuevo, fecha, p.id]);
    await recalcularFechas(p.id);
    await registrarHistorial(p, `Proyecto entregado el ${fecha}${nuevo === 'soporte' ? ` · ${p.dias_soporte} días de soporte` : ''}`, req.user);
    // Hitos pendientes se dan por completados al entregar
    await db.query('UPDATE proyecto_hitos SET completado = 1, completado_at = NOW(), completado_por = ? WHERE proyecto_id = ? AND completado = 0', [req.user.id, p.id]);
    if (await config.getBool('proyectos_wa_entrega')) avisarCliente(p, 'proyecto_entrega', { dias: String(p.dias_soporte) });
  } else {
    const extra = accion === 'desarrollo' && !p.fecha_inicio ? ', fecha_inicio = CURDATE()' : '';
    await db.query(`UPDATE proyectos SET estado = ?${extra} WHERE id = ?`, [accion, p.id]);
    if (extra) await recalcularFechas(p.id);
    await registrarHistorial(p, `Estado: ${NOMBRE_ESTADO[accion]}${req.body.motivo ? ` — ${texto(req.body.motivo, 300)}` : ''}`, req.user);
    if (accion === 'aprobado') await alAprobar(p, req.user);
    if (accion === 'cancelado') await actualizarValorCliente(p.negocio_id);
  }
  await audit(req, 'proyecto_estado', { entidad: 'proyecto', entidadId: p.id, detalle: { de: p.estado, a: accion } });
  res.json({ ok: true });
}));

// ── Pagos ─────────────────────────────────────────────────────────────────
router.post('/:id/pagos', requirePerm('proyectos.montos'), upload.single('comprobante'), ah(async (req, res) => {
  if (!req.user.can('proyectos.gestionar')) throw new HttpError(403, 'No tienes permiso para registrar cobros.');
  const p = await cargar(req, parseInt(req.params.id, 10));
  const monto = r2(parseFloat(req.body.monto));
  if (!(monto > 0)) throw new HttpError(422, 'Escribe el monto cobrado.');
  const saldo = r2(p.monto - p.pagado);
  if (monto > saldo + 0.01) throw new HttpError(422, `El cobro supera el saldo pendiente (${saldo}). Si hubo trabajo adicional, primero sube el monto del proyecto.`);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : fechaLima();
  const [r] = await db.query('INSERT INTO proyecto_pagos SET ?', [{
    proyecto_id: p.id, monto, fecha, metodo: METODOS.includes(req.body.metodo) ? req.body.metodo : 'otro',
    referencia: texto(req.body.referencia, 150), comprobante_url: req.file ? `/uploads/${req.file.filename}` : null, registrado_por: req.user.id,
  }]);
  // El historial del cliente no muestra montos (lo ven usuarios sin permiso de montos)
  await registrarHistorial(p, `Cobro registrado (${req.body.metodo || 'pago'})${r2(monto) >= saldo ? ' · proyecto pagado al 100 %' : ''}`, req.user);
  await audit(req, 'proyecto_pago', { entidad: 'proyecto', entidadId: p.id, detalle: { monto, fecha } });
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.delete('/pagos/:pagoId', requirePerm('proyectos.montos'), ah(async (req, res) => {
  if (!req.user.can('proyectos.gestionar')) throw new HttpError(403, 'No tienes permiso para eliminar cobros.');
  const [[x]] = await db.query('SELECT proyecto_id, monto FROM proyecto_pagos WHERE id = ?', [req.params.pagoId]);
  if (!x) throw new HttpError(404, 'Cobro no encontrado');
  const p = await cargar(req, x.proyecto_id);
  await db.query('DELETE FROM proyecto_pagos WHERE id = ?', [req.params.pagoId]);
  await db.query('UPDATE proyecto_cuotas SET aviso_vencida = 0, aviso_previo = 0 WHERE proyecto_id = ?', [p.id]);
  await registrarHistorial(p, 'Se anuló un cobro registrado', req.user);
  await audit(req, 'proyecto_pago_eliminado', { entidad: 'proyecto', entidadId: p.id, detalle: { monto: x.monto } });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════
//  FASE 2 · Avance (hitos), cambios de alcance e incidencias
// ════════════════════════════════════════════════════════════════════════
const puedeTrabajar = requirePerm('proyectos.trabajar', 'proyectos.gestionar');

// Proyecto dueño de un registro hijo (verifica acceso)
async function proyectoDe(req, tabla, id) {
  const [[r]] = await db.query(`SELECT proyecto_id FROM ${tabla} WHERE id = ?`, [id]);
  if (!r) throw new HttpError(404, 'Registro no encontrado');
  return cargar(req, r.proyecto_id);
}

function leerHito(b) {
  const h = {
    titulo: texto(b.titulo, 200),
    descripcion: b.descripcion !== undefined ? texto(b.descripcion, 2000) : undefined,
    fecha_objetivo: b.fecha_objetivo !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.fecha_objetivo || '') ? b.fecha_objetivo : null) : undefined,
    peso: b.peso !== undefined ? entero(b.peso, 1, 1, 100) : undefined,
  };
  if (!h.titulo) throw new HttpError(422, 'El hito necesita un título.');
  Object.keys(h).forEach(k => h[k] === undefined && delete h[k]);
  return h;
}

router.post('/:id/hitos', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const [[{ n }]] = await db.query('SELECT COALESCE(MAX(orden), -1) + 1 AS n FROM proyecto_hitos WHERE proyecto_id = ?', [p.id]);
  const [r] = await db.query('INSERT INTO proyecto_hitos SET ?', [{ ...leerHito(req.body), proyecto_id: p.id, orden: n }]);
  res.status(201).json({ ok: true, id: r.insertId });
}));

// Hitos estándar de un desarrollo, con fechas repartidas entre inicio y entrega según su peso
const HITOS_ESTANDAR = [['Análisis y requerimientos', 1], ['Diseño de pantallas', 2], ['Desarrollo', 4], ['Pruebas y ajustes', 2], ['Entrega y capacitación', 1]];
router.post('/:id/hitos/plantilla', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM proyecto_hitos WHERE proyecto_id = ?', [p.id]);
  if (n) throw new HttpError(422, 'El proyecto ya tiene hitos.');
  const total = HITOS_ESTANDAR.reduce((s, h) => s + h[1], 0);
  const dias = p.fecha_inicio && p.fecha_entrega_estimada
    ? Math.round((new Date(`${p.fecha_entrega_estimada}T12:00:00`) - new Date(`${p.fecha_inicio}T12:00:00`)) / 864e5) : null;
  let acumulado = 0;
  for (const [i, [titulo, peso]] of HITOS_ESTANDAR.entries()) {
    acumulado += peso;
    let fecha = null;
    if (dias !== null) {
      const x = new Date(`${p.fecha_inicio}T12:00:00`);
      x.setDate(x.getDate() + Math.round((dias * acumulado) / total));
      fecha = x.toISOString().slice(0, 10);
    }
    await db.query('INSERT INTO proyecto_hitos SET ?', [{ proyecto_id: p.id, orden: i, titulo, peso, fecha_objetivo: fecha }]);
  }
  res.json({ ok: true });
}));

router.put('/hitos/:hid', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  await proyectoDe(req, 'proyecto_hitos', req.params.hid);
  await db.query('UPDATE proyecto_hitos SET ? WHERE id = ?', [leerHito(req.body), req.params.hid]);
  res.json({ ok: true });
}));

router.post('/hitos/:hid/completar', puedeTrabajar, ah(async (req, res) => {
  const p = await proyectoDe(req, 'proyecto_hitos', req.params.hid);
  const hecho = req.body.completado !== false && req.body.completado !== '0';
  const [[h]] = await db.query('SELECT titulo FROM proyecto_hitos WHERE id = ?', [req.params.hid]);
  await db.query('UPDATE proyecto_hitos SET completado = ?, completado_at = ?, completado_por = ? WHERE id = ?',
    [hecho ? 1 : 0, hecho ? new Date() : null, hecho ? req.user.id : null, req.params.hid]);
  if (hecho) await registrarHistorial(p, `Hito completado: ${h.titulo}`, req.user);
  res.json({ ok: true });
}));

router.delete('/hitos/:hid', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  await proyectoDe(req, 'proyecto_hitos', req.params.hid);
  await db.query('DELETE FROM proyecto_hitos WHERE id = ?', [req.params.hid]);
  res.json({ ok: true });
}));

// ── Cambios de alcance ────────────────────────────────────────────────────
router.post('/:id/cambios', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const titulo = texto(req.body.titulo, 200);
  if (!titulo) throw new HttpError(422, 'Describe brevemente el cambio.');
  const [r] = await db.query('INSERT INTO proyecto_cambios SET ?', [{
    proyecto_id: p.id, titulo, descripcion: texto(req.body.descripcion, 5000),
    monto: req.user.can('proyectos.montos') ? Math.max(0, r2(parseFloat(req.body.monto) || 0)) : 0,
    dias_extra: entero(req.body.dias_extra, 0, 0, 3650), creado_por: req.user.id,
  }]);
  await registrarHistorial(p, `Cambio de alcance solicitado: ${titulo}`, req.user);
  res.status(201).json({ ok: true, id: r.insertId });
}));

// Aprobar: suma el monto y los días al proyecto y agrega una cuota por el adicional
async function aprobarCambio(req, cambioId) {
  const p = await proyectoDe(req, 'proyecto_cambios', cambioId);
  const [[c]] = await db.query('SELECT * FROM proyecto_cambios WHERE id = ?', [cambioId]);
  if (c.estado !== 'pendiente') throw new HttpError(422, 'Este cambio ya fue resuelto.');
  await db.query("UPDATE proyecto_cambios SET estado = 'aprobado', resuelto_at = NOW() WHERE id = ?", [c.id]);
  if (Number(c.monto) > 0) {
    await db.query('UPDATE proyectos SET monto = monto + ? WHERE id = ?', [c.monto, p.id]);
    const [[{ n }]] = await db.query('SELECT COALESCE(MAX(orden), -1) + 1 AS n FROM proyecto_cuotas WHERE proyecto_id = ?', [p.id]);
    await db.query('INSERT INTO proyecto_cuotas SET ?', [{
      proyecto_id: p.id, orden: n, concepto: `Adicional: ${c.titulo}`.slice(0, 150), monto: c.monto, vence_at: fechaLima(7),
    }]);
    await actualizarValorCliente(p.negocio_id);
  }
  if (Number(c.dias_extra) > 0) {
    await db.query('UPDATE proyectos SET duracion_dias = duracion_dias + ?, aviso_entrega = 0 WHERE id = ? AND duracion_dias IS NOT NULL', [c.dias_extra, p.id]);
    await recalcularFechas(p.id);
  }
  await registrarHistorial(p, `Cambio de alcance aprobado: ${c.titulo}${Number(c.dias_extra) ? ` (+${c.dias_extra} días)` : ''}`, req.user);
  return { p, c };
}

router.post('/cambios/:cid/aprobar', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  await aprobarCambio(req, req.params.cid);
  res.json({ ok: true });
}));

router.post('/cambios/:cid/rechazar', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await proyectoDe(req, 'proyecto_cambios', req.params.cid);
  const [r] = await db.query("UPDATE proyecto_cambios SET estado = 'rechazado', resuelto_at = NOW() WHERE id = ? AND estado = 'pendiente'", [req.params.cid]);
  if (!r.affectedRows) throw new HttpError(422, 'Este cambio ya fue resuelto.');
  await registrarHistorial(p, 'Cambio de alcance rechazado', req.user);
  res.json({ ok: true });
}));

router.delete('/cambios/:cid', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  await proyectoDe(req, 'proyecto_cambios', req.params.cid);
  const [r] = await db.query("DELETE FROM proyecto_cambios WHERE id = ? AND estado <> 'aprobado'", [req.params.cid]);
  if (!r.affectedRows) throw new HttpError(422, 'Un cambio aprobado no se puede eliminar.');
  res.json({ ok: true });
}));

// ── Incidencias ───────────────────────────────────────────────────────────
const TIPOS_TICKET = ['error', 'mejora', 'consulta', 'cambio'];
const PRIORIDADES  = ['baja', 'media', 'alta', 'urgente'];
const ESTADOS_TICKET = ['abierto', 'en_proceso', 'resuelto', 'cerrado'];

router.post('/:id/tickets', puedeTrabajar, ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const titulo = texto(req.body.titulo, 200);
  if (!titulo) throw new HttpError(422, 'Describe la incidencia.');
  // Cubierta si el proyecto está en desarrollo o dentro del período de soporte
  const cubierto = ACTIVOS.includes(p.estado) || (p.estado === 'soporte' && p.dias_soporte_restantes >= 0) ? 1 : 0;
  const [[{ n }]] = await db.query('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM proyecto_tickets WHERE proyecto_id = ?', [p.id]);
  const asignado = parseInt(req.body.asignado_a, 10) || p.responsable_id || null;
  const [r] = await db.query('INSERT INTO proyecto_tickets SET ?', [{
    proyecto_id: p.id, numero: n, titulo, descripcion: texto(req.body.descripcion, 5000),
    tipo: TIPOS_TICKET.includes(req.body.tipo) ? req.body.tipo : 'error',
    prioridad: PRIORIDADES.includes(req.body.prioridad) ? req.body.prioridad : 'media',
    cubierto, asignado_a: asignado, creado_por: req.user.id,
  }]);
  await registrarHistorial(p, `Incidencia #${n}: ${titulo}${cubierto ? '' : ' (fuera de soporte)'}`, req.user);
  if (asignado && asignado !== req.user.id)
    await notificar([asignado], { tipo: 'tarea', titulo: `Incidencia #${n} en ${p.nombre}`, cuerpo: titulo, enlace: `#/proyectos/${p.id}` });
  res.status(201).json({ ok: true, id: r.insertId, numero: n, cubierto });
}));

router.put('/tickets/:tid', puedeTrabajar, ah(async (req, res) => {
  const p = await proyectoDe(req, 'proyecto_tickets', req.params.tid);
  const [[t]] = await db.query('SELECT * FROM proyecto_tickets WHERE id = ?', [req.params.tid]);
  const b = req.body, d = {};
  if (b.estado !== undefined) {
    if (!ESTADOS_TICKET.includes(b.estado)) throw new HttpError(422, 'Estado inválido.');
    d.estado = b.estado;
    d.resuelto_at = ['resuelto', 'cerrado'].includes(b.estado) ? (t.resuelto_at || new Date()) : null;
  }
  if (b.prioridad !== undefined && PRIORIDADES.includes(b.prioridad)) d.prioridad = b.prioridad;
  if (b.tipo !== undefined && TIPOS_TICKET.includes(b.tipo)) d.tipo = b.tipo;
  if (b.solucion !== undefined) d.solucion = texto(b.solucion, 5000);
  if (b.titulo !== undefined) d.titulo = texto(b.titulo, 200) || t.titulo;
  if (b.descripcion !== undefined) d.descripcion = texto(b.descripcion, 5000);
  if (b.asignado_a !== undefined) d.asignado_a = parseInt(b.asignado_a, 10) || null;
  if (req.user.can('proyectos.gestionar')) {
    if (b.cubierto !== undefined) d.cubierto = b.cubierto === true || b.cubierto === '1' || b.cubierto === 1 ? 1 : 0;
    if (b.monto_adicional !== undefined && req.user.can('proyectos.montos'))
      d.monto_adicional = b.monto_adicional === '' || b.monto_adicional === null ? null : Math.max(0, r2(parseFloat(b.monto_adicional) || 0));
  }
  if (!Object.keys(d).length) return res.json({ ok: true });
  await db.query('UPDATE proyecto_tickets SET ? WHERE id = ?', [d, t.id]);
  if (d.estado && d.estado !== t.estado)
    await registrarHistorial(p, `Incidencia #${t.numero} → ${d.estado.replace('_', ' ')}`, req.user);
  if (d.asignado_a && d.asignado_a !== t.asignado_a && d.asignado_a !== req.user.id)
    await notificar([d.asignado_a], { tipo: 'tarea', titulo: `Incidencia #${t.numero} en ${p.nombre}`, cuerpo: d.titulo || t.titulo, enlace: `#/proyectos/${p.id}` });
  res.json({ ok: true });
}));

// Cobrar una incidencia fuera de soporte: se convierte en un cambio de alcance aprobado
router.post('/tickets/:tid/cobrar', requirePerm('proyectos.montos'), ah(async (req, res) => {
  if (!req.user.can('proyectos.gestionar')) throw new HttpError(403, 'No tienes permiso para cobrar adicionales.');
  const p = await proyectoDe(req, 'proyecto_tickets', req.params.tid);
  const [[t]] = await db.query('SELECT * FROM proyecto_tickets WHERE id = ?', [req.params.tid]);
  if (t.cubierto) throw new HttpError(422, 'Esta incidencia está cubierta por el soporte.');
  if (!(Number(t.monto_adicional) > 0)) throw new HttpError(422, 'Primero indica el monto adicional de la incidencia.');
  if (t.cambio_id) throw new HttpError(422, 'Esta incidencia ya se agregó al cobro.');
  const [r] = await db.query('INSERT INTO proyecto_cambios SET ?', [{
    proyecto_id: p.id, titulo: `Incidencia #${t.numero}: ${t.titulo}`.slice(0, 200), monto: t.monto_adicional, creado_por: req.user.id,
  }]);
  await aprobarCambio(req, r.insertId);
  await db.query('UPDATE proyecto_tickets SET cambio_id = ? WHERE id = ?', [r.insertId, t.id]);
  res.json({ ok: true });
}));

router.delete('/tickets/:tid', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  await proyectoDe(req, 'proyecto_tickets', req.params.tid);
  await db.query('DELETE FROM proyecto_tickets WHERE id = ?', [req.params.tid]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════
//  FASE 3 · Horas trabajadas y archivos
// ════════════════════════════════════════════════════════════════════════
router.post('/:id/horas', puedeTrabajar, ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  const horas = r2(parseFloat(req.body.horas));
  if (!(horas > 0 && horas <= 24)) throw new HttpError(422, 'Indica entre 0.25 y 24 horas.');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : fechaLima();
  if (fecha > fechaLima()) throw new HttpError(422, 'No puedes registrar horas en una fecha futura.');
  const usuario = req.user.can('proyectos.gestionar') && req.body.usuario_id ? parseInt(req.body.usuario_id, 10) : req.user.id;
  const ref = async (tabla, v) => {
    const id = parseInt(v, 10);
    if (!id) return null;
    const [[x]] = await db.query(`SELECT id FROM ${tabla} WHERE id = ? AND proyecto_id = ?`, [id, p.id]);
    return x ? id : null;
  };
  const [r] = await db.query('INSERT INTO proyecto_horas SET ?', [{
    proyecto_id: p.id, usuario_id: usuario, fecha, horas, descripcion: texto(req.body.descripcion, 300),
    hito_id: await ref('proyecto_hitos', req.body.hito_id), ticket_id: await ref('proyecto_tickets', req.body.ticket_id),
  }]);
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.delete('/horas/:hid', puedeTrabajar, ah(async (req, res) => {
  await proyectoDe(req, 'proyecto_horas', req.params.hid);
  const [[h]] = await db.query('SELECT usuario_id FROM proyecto_horas WHERE id = ?', [req.params.hid]);
  if (h.usuario_id !== req.user.id && !req.user.can('proyectos.gestionar')) throw new HttpError(403, 'Solo puedes borrar tus propias horas.');
  await db.query('DELETE FROM proyecto_horas WHERE id = ?', [req.params.hid]);
  res.json({ ok: true });
}));

const TIPOS_ARCHIVO = ['contrato', 'propuesta', 'acta', 'factura', 'diseno', 'documentacion', 'otro'];
router.post('/:id/archivos', puedeTrabajar, uploadDoc.single('archivo'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  if (!req.file) throw new HttpError(422, 'Elige un archivo.');
  const tipo = TIPOS_ARCHIVO.includes(req.body.tipo) ? req.body.tipo : 'otro';
  // Contratos, propuestas y facturas contienen montos: solo quien ve montos puede subirlos
  if (['contrato', 'propuesta', 'factura'].includes(tipo) && !req.user.can('proyectos.montos')) throw new HttpError(403, 'No puedes subir documentos con montos.');
  const nombre = (texto(req.body.nombre, 200) || Buffer.from(req.file.originalname, 'latin1').toString('utf8')).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 255);
  const [r] = await db.query('INSERT INTO proyecto_archivos SET ?', [{
    proyecto_id: p.id, tipo, nombre, url: `/uploads/docs/${req.file.filename}`, tamano: req.file.size, mime: req.file.mimetype, subido_por: req.user.id,
  }]);
  await registrarHistorial(p, `Archivo agregado (${tipo}): ${nombre}`, req.user);
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.delete('/archivos/:aid', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await proyectoDe(req, 'proyecto_archivos', req.params.aid);
  const [[a]] = await db.query('SELECT url, nombre FROM proyecto_archivos WHERE id = ?', [req.params.aid]);
  await db.query('DELETE FROM proyecto_archivos WHERE id = ?', [req.params.aid]);
  try { require('fs').unlinkSync(require('path').join(__dirname, '../..', a.url)); } catch (_) { /* ya no estaba */ }
  await registrarHistorial(p, `Archivo eliminado: ${a.nombre}`, req.user);
  res.json({ ok: true });
}));

router.delete('/:id', requirePerm('proyectos.gestionar'), ah(async (req, res) => {
  const p = await cargar(req, parseInt(req.params.id, 10));
  if (!['propuesta', 'cancelado'].includes(p.estado)) throw new HttpError(422, 'Solo se pueden eliminar propuestas o proyectos cancelados.');
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM proyecto_pagos WHERE proyecto_id = ?', [p.id]);
  if (n) throw new HttpError(422, 'El proyecto tiene cobros registrados: cancélalo en lugar de eliminarlo.');
  await db.query('DELETE FROM proyectos WHERE id = ?', [p.id]);
  await db.query('UPDATE crm_historial SET proyecto_id = NULL WHERE proyecto_id = ?', [p.id]);
  await audit(req, 'proyecto_eliminado', { entidad: 'proyecto', entidadId: p.id, detalle: p.codigo });
  res.json({ ok: true });
}));

module.exports = router;
