// Suscripciones SaaS (registro manual): catálogo (productos, planes, integraciones),
// suscripciones por cliente y pagos por periodo. Nada se genera ni cambia solo.
// Estados (manuales): activa · suspendida · cancelada
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { asegurarAcceso } = require('../lib/filtros');
const { upload } = require('../lib/uploads');
const { ah, HttpError, texto, entero } = require('../lib/utils');
const S = require('../lib/suscripciones');

const { r2, fechaLima, MESES, CICLOS } = S;
const MONEDAS = ['PEN', 'USD'];
const METODOS = ['transferencia', 'yape', 'plin', 'efectivo', 'tarjeta', 'otro'];
const ESTADOS = { activa: 'Activa', suspendida: 'Suspendida', cancelada: 'Cancelada' };
const fechaOk = x => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
const dec = (x, { nulo = false } = {}) => {
  if ((x === '' || x === null || x === undefined) && nulo) return null;
  const n = r2(parseFloat(x));
  return Number.isFinite(n) && n >= 0 ? n : (nulo ? null : 0);
};
const montos = req => req.user.can('suscripciones.cobros');
const gestionar = requirePerm('suscripciones.gestionar');
const activoDe = b => (b.activo === false || b.activo === '0' || b.activo === 0 ? 0 : 1);

// ════════════════════════════════════════════════════════════════════════
//  Catálogo
// ════════════════════════════════════════════════════════════════════════
router.get('/catalogo', requirePerm('suscripciones.ver'), ah(async (req, res) => {
  const [productos] = await db.query('SELECT * FROM saas_productos ORDER BY activo DESC, nombre');
  const [planes] = await db.query(`SELECT p.*, (SELECT COUNT(*) FROM suscripciones s WHERE s.plan_id = p.id AND s.estado <> 'cancelada') AS en_uso
    FROM saas_planes p ORDER BY p.producto_id, p.orden, p.precio_mensual`);
  const [integraciones] = await db.query(`SELECT i.*, (SELECT COUNT(*) FROM suscripcion_integraciones si WHERE si.integracion_id = i.id AND si.activo = 1) AS en_uso
    FROM saas_integraciones i ORDER BY i.activo DESC, i.nombre`);
  if (!montos(req)) {
    planes.forEach(p => { delete p.precio_mensual; delete p.precio_trimestral; delete p.precio_anual; });
    integraciones.forEach(i => { delete i.precio_mensual; });
  }
  res.json({ ok: true, productos, planes, integraciones });
}));

router.post('/productos', gestionar, ah(async (req, res) => {
  const nombre = texto(req.body.nombre, 120);
  if (!nombre) throw new HttpError(422, 'Ponle un nombre al producto.');
  const [r] = await db.query('INSERT INTO saas_productos SET ?', [{ nombre, descripcion: texto(req.body.descripcion, 2000), url: texto(req.body.url, 500) }]);
  await audit(req, 'saas_producto_creado', { entidad: 'saas_producto', entidadId: r.insertId, detalle: { nombre } });
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.put('/productos/:id', gestionar, ah(async (req, res) => {
  const nombre = texto(req.body.nombre, 120);
  if (!nombre) throw new HttpError(422, 'Ponle un nombre al producto.');
  await db.query('UPDATE saas_productos SET ? WHERE id = ?', [{
    nombre, descripcion: texto(req.body.descripcion, 2000), url: texto(req.body.url, 500), activo: activoDe(req.body),
  }, req.params.id]);
  res.json({ ok: true });
}));

router.delete('/productos/:id', gestionar, ah(async (req, res) => {
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM suscripciones s JOIN saas_planes p ON p.id = s.plan_id WHERE p.producto_id = ?', [req.params.id]);
  if (n) {
    await db.query('UPDATE saas_productos SET activo = 0 WHERE id = ?', [req.params.id]);
    return res.json({ ok: true, desactivado: true });
  }
  await db.query('DELETE FROM saas_productos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

function leerPlan(b) {
  const d = {
    nombre: texto(b.nombre, 80),
    moneda: MONEDAS.includes(b.moneda) ? b.moneda : 'PEN',
    precio_mensual: dec(b.precio_mensual),
    precio_trimestral: dec(b.precio_trimestral, { nulo: true }),
    precio_anual: dec(b.precio_anual, { nulo: true }),
    incluye: texto(b.incluye, 3000),
    orden: entero(b.orden, 0, 0, 999),
  };
  if (!d.nombre) throw new HttpError(422, 'Ponle un nombre al plan.');
  if (!(d.precio_mensual > 0)) throw new HttpError(422, 'Indica el precio mensual del plan.');
  return d;
}

router.post('/planes', gestionar, requirePerm('suscripciones.cobros'), ah(async (req, res) => {
  const productoId = parseInt(req.body.producto_id, 10);
  const [[p]] = await db.query('SELECT id FROM saas_productos WHERE id = ?', [productoId]);
  if (!p) throw new HttpError(422, 'Elige el producto del plan.');
  const [r] = await db.query('INSERT INTO saas_planes SET ?', [{ ...leerPlan(req.body), producto_id: productoId }]);
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.put('/planes/:id', gestionar, requirePerm('suscripciones.cobros'), ah(async (req, res) => {
  await db.query('UPDATE saas_planes SET ? WHERE id = ?', [{ ...leerPlan(req.body), activo: activoDe(req.body) }, req.params.id]);
  res.json({ ok: true });
}));

router.delete('/planes/:id', gestionar, ah(async (req, res) => {
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM suscripciones WHERE plan_id = ?', [req.params.id]);
  if (n) {
    await db.query('UPDATE saas_planes SET activo = 0 WHERE id = ?', [req.params.id]);
    return res.json({ ok: true, desactivado: true });
  }
  await db.query('DELETE FROM saas_planes WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

function leerIntegracion(b) {
  const d = {
    nombre: texto(b.nombre, 120),
    descripcion: texto(b.descripcion, 2000),
    producto_id: parseInt(b.producto_id, 10) || null,
    precio_mensual: dec(b.precio_mensual),
  };
  if (!d.nombre) throw new HttpError(422, 'Ponle un nombre a la integración.');
  return d;
}

router.post('/integraciones', gestionar, requirePerm('suscripciones.cobros'), ah(async (req, res) => {
  const [r] = await db.query('INSERT INTO saas_integraciones SET ?', [leerIntegracion(req.body)]);
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.put('/integraciones/:id', gestionar, requirePerm('suscripciones.cobros'), ah(async (req, res) => {
  await db.query('UPDATE saas_integraciones SET ? WHERE id = ?', [{ ...leerIntegracion(req.body), activo: activoDe(req.body) }, req.params.id]);
  res.json({ ok: true });
}));

router.delete('/integraciones/:id', gestionar, ah(async (req, res) => {
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM suscripcion_integraciones WHERE integracion_id = ?', [req.params.id]);
  if (n) {
    await db.query('UPDATE saas_integraciones SET activo = 0 WHERE id = ?', [req.params.id]);
    return res.json({ ok: true, desactivado: true });
  }
  await db.query('DELETE FROM saas_integraciones WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════
//  Suscripciones
// ════════════════════════════════════════════════════════════════════════
const SELECT = `SELECT s.id, s.codigo, s.negocio_id, s.plan_id, s.proyecto_id, s.ciclo, s.moneda, s.precio_especial, s.descuento_pct, s.incluye_igv,
    s.estado, s.responsable_id, s.creado_por, s.notas, s.motivo_cancelacion, s.created_at,
    DATE_FORMAT(s.fecha_inicio, '%Y-%m-%d') AS fecha_inicio, DATE_FORMAT(s.cancelada_at, '%Y-%m-%d') AS cancelada_at,
    p.nombre AS plan_nombre, p.precio_mensual, p.precio_trimestral, p.precio_anual, pr.id AS producto_id, pr.nombre AS producto_nombre,
    n.nombre AS cliente, n.contacto_nombre, n.whatsapp, n.asignado_a, u.nombre AS responsable_nombre, py.codigo AS proyecto_codigo,
    (SELECT DATE_FORMAT(MAX(x.periodo_fin), '%Y-%m-%d') FROM suscripcion_pagos x WHERE x.suscripcion_id = s.id) AS pagado_hasta,
    (SELECT COALESCE(SUM(x.monto), 0) FROM suscripcion_pagos x WHERE x.suscripcion_id = s.id) AS total_pagado
  FROM suscripciones s JOIN saas_planes p ON p.id = s.plan_id JOIN saas_productos pr ON pr.id = p.producto_id
  JOIN negocios n ON n.id = s.negocio_id LEFT JOIN usuarios u ON u.id = s.responsable_id LEFT JOIN proyectos py ON py.id = s.proyecto_id`;

function alcance(req, w, v) {
  if (req.user.can('contactos.ver_todos')) return;
  w.push('(n.asignado_a = ? OR s.responsable_id = ?)');
  v.push(req.user.id, req.user.id);
}

async function integracionesDe(ids) {
  if (!ids.length) return {};
  const [rows] = await db.query(`SELECT si.id, si.suscripcion_id, si.integracion_id, si.precio_mensual, si.activo,
      DATE_FORMAT(si.fecha_alta, '%Y-%m-%d') AS fecha_alta, DATE_FORMAT(si.fecha_baja, '%Y-%m-%d') AS fecha_baja, i.nombre
    FROM suscripcion_integraciones si JOIN saas_integraciones i ON i.id = si.integracion_id
    WHERE si.suscripcion_id IN (?) ORDER BY si.activo DESC, i.nombre`, [ids]);
  const out = {};
  rows.forEach(r => { (out[r.suscripcion_id] = out[r.suscripcion_id] || []).push(r); });
  return out;
}

async function pagosDe(ids) {
  if (!ids.length) return {};
  const [rows] = await db.query(`SELECT suscripcion_id, DATE_FORMAT(periodo_inicio, '%Y-%m-%d') AS periodo_inicio, monto
    FROM suscripcion_pagos WHERE suscripcion_id IN (?)`, [ids]);
  const out = {};
  rows.forEach(r => { (out[r.suscripcion_id] = out[r.suscripcion_id] || []).push(r); });
  return out;
}

// Monto de referencia del ciclo, periodos y resumen de pagos; oculta montos si no hay permiso
function enriquecer(s, ints, pagos, req) {
  const activas = (ints || []).filter(i => Number(i.activo));
  const plan = { nombre: s.plan_nombre, precio_mensual: s.precio_mensual, precio_trimestral: s.precio_trimestral, precio_anual: s.precio_anual };
  const c = S.calcular(s, plan, activas);
  const { periodos, sueltos } = S.periodos(s, pagos || [], c.total);
  const hoy = fechaLima();
  Object.assign(s, {
    monto_ciclo: c.total, mensual: c.mensual, lineas: c.lineas, periodos, pagos_sueltos: sueltos,
    // Solo informativo: periodos ya iniciados sin pago completo (no cambia ningún estado)
    periodos_sin_pago: periodos.filter(p => p.inicio <= hoy && p.estado !== 'pagado').length,
    total_pagado: r2(s.total_pagado),
    integraciones: (ints || []).map(i => ({ ...i })),
  });
  if (!montos(req)) {
    for (const k of ['monto_ciclo', 'mensual', 'lineas', 'total_pagado', 'precio_especial', 'descuento_pct', 'precio_mensual', 'precio_trimestral', 'precio_anual', 'pagos_sueltos'])
      delete s[k];
    s.periodos.forEach(p => { delete p.monto; delete p.pagado; });
    s.integraciones.forEach(i => { delete i.precio_mensual; });
  }
  return s;
}

async function cargar(req, id) {
  const w = ['s.id = ?'], v = [id];
  alcance(req, w, v);
  const [[s]] = await db.query(`${SELECT} WHERE ${w.join(' AND ')}`, v);
  if (!s) throw new HttpError(404, 'Suscripción no encontrada');
  return s;
}

router.get('/', requirePerm('suscripciones.ver'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  alcance(req, w, v);
  if (req.query.negocio_id) { w.push('s.negocio_id = ?'); v.push(parseInt(req.query.negocio_id, 10)); }
  if (req.query.estado) { w.push('s.estado = ?'); v.push(req.query.estado); }
  if (req.query.producto_id) { w.push('pr.id = ?'); v.push(parseInt(req.query.producto_id, 10)); }
  if (req.query.q) { const q = `%${req.query.q}%`; w.push('(s.codigo LIKE ? OR n.nombre LIKE ? OR p.nombre LIKE ?)'); v.push(q, q, q); }
  const [rows] = await db.query(`${SELECT} WHERE ${w.join(' AND ')}
    ORDER BY FIELD(s.estado,'activa','suspendida','cancelada'), n.nombre LIMIT 1000`, v);
  const ids = rows.map(r => r.id);
  const [ints, pagos] = await Promise.all([integracionesDe(ids), pagosDe(ids)]);
  rows.forEach(s => { enriquecer(s, ints[s.id], pagos[s.id], req); delete s.periodos; });

  const resumen = {
    activas: rows.filter(s => s.estado === 'activa').length,
    con_periodos_sin_pago: rows.filter(s => s.estado === 'activa' && s.periodos_sin_pago).length,
  };
  if (montos(req)) {
    resumen.mrr = rows.filter(s => s.estado === 'activa').reduce((a, s) => { a[s.moneda] = r2((a[s.moneda] || 0) + s.mensual); return a; }, {});
    const [mes] = await db.query(`SELECT s.moneda, SUM(x.monto) AS total FROM suscripcion_pagos x JOIN suscripciones s ON s.id = x.suscripcion_id
      JOIN negocios n ON n.id = s.negocio_id WHERE x.fecha >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      ${req.user.can('contactos.ver_todos') ? '' : 'AND (n.asignado_a = ? OR s.responsable_id = ?)'} GROUP BY s.moneda`,
    req.user.can('contactos.ver_todos') ? [] : [req.user.id, req.user.id]);
    resumen.cobrado_mes = Object.fromEntries(mes.map(m => [m.moneda, r2(m.total)]));
  }
  res.json({ ok: true, rows, resumen, estados: ESTADOS, ciclos: CICLOS });
}));

// Historial de pagos de todas las suscripciones (trazabilidad)
router.get('/pagos', requirePerm('suscripciones.cobros'), ah(async (req, res) => {
  const w = ['1=1'], v = [];
  alcance(req, w, v);
  if (fechaOk(req.query.desde)) { w.push('x.fecha >= ?'); v.push(req.query.desde); }
  if (fechaOk(req.query.hasta)) { w.push('x.fecha <= ?'); v.push(req.query.hasta); }
  const [rows] = await db.query(`SELECT x.id, x.suscripcion_id, x.monto, x.metodo, x.referencia, x.comprobante_url, x.notas,
      DATE_FORMAT(x.fecha, '%Y-%m-%d') AS fecha, DATE_FORMAT(x.periodo_inicio, '%Y-%m-%d') AS periodo_inicio,
      DATE_FORMAT(x.periodo_fin, '%Y-%m-%d') AS periodo_fin, s.codigo, s.moneda, n.nombre AS cliente, p.nombre AS plan_nombre,
      u.nombre AS registrado_por_nombre
    FROM suscripcion_pagos x JOIN suscripciones s ON s.id = x.suscripcion_id JOIN negocios n ON n.id = s.negocio_id
    JOIN saas_planes p ON p.id = s.plan_id LEFT JOIN usuarios u ON u.id = x.registrado_por
    WHERE ${w.join(' AND ')} ORDER BY x.fecha DESC, x.id DESC LIMIT 1000`, v);
  rows.forEach(x => { x.monto = r2(x.monto); });
  res.json({ ok: true, rows });
}));

router.get('/:id', requirePerm('suscripciones.ver'), ah(async (req, res) => {
  const s = await cargar(req, parseInt(req.params.id, 10));
  const ints = (await integracionesDe([s.id]))[s.id] || [];
  const pagosPeriodo = (await pagosDe([s.id]))[s.id] || [];
  enriquecer(s, ints, pagosPeriodo, req);
  let pagos = [];
  if (montos(req)) {
    [pagos] = await db.query(`SELECT x.id, x.monto, DATE_FORMAT(x.fecha, '%Y-%m-%d') AS fecha, x.metodo, x.referencia, x.comprobante_url, x.notas,
        DATE_FORMAT(x.periodo_inicio, '%Y-%m-%d') AS periodo_inicio, DATE_FORMAT(x.periodo_fin, '%Y-%m-%d') AS periodo_fin,
        u.nombre AS registrado_por_nombre FROM suscripcion_pagos x LEFT JOIN usuarios u ON u.id = x.registrado_por
      WHERE x.suscripcion_id = ? ORDER BY x.periodo_inicio DESC, x.id DESC LIMIT 300`, [s.id]);
    pagos.forEach(x => { x.monto = r2(x.monto); });
  }
  const [historial] = await db.query(`SELECT id, contenido, usuario, created_at FROM crm_historial
    WHERE suscripcion_id = ? ORDER BY id DESC LIMIT 100`, [s.id]);
  res.json({ ok: true, suscripcion: s, pagos, historial });
}));

// ── Crear / editar ────────────────────────────────────────────────────────
async function planValido(id) {
  const [[p]] = await db.query('SELECT p.*, pr.activo AS producto_activo FROM saas_planes p JOIN saas_productos pr ON pr.id = p.producto_id WHERE p.id = ?', [id]);
  if (!p) throw new HttpError(422, 'Elige un plan.');
  return p;
}

function leer(b, req, previo = {}) {
  const val = (k, f) => (b[k] !== undefined ? f(b[k]) : previo[k]);
  const d = {
    ciclo: val('ciclo', x => (MESES[x] ? x : 'mensual')),
    fecha_inicio: val('fecha_inicio', x => fechaOk(x) || previo.fecha_inicio || fechaLima()),
    responsable_id: val('responsable_id', x => parseInt(x, 10) || null),
    proyecto_id: val('proyecto_id', x => parseInt(x, 10) || null),
    notas: val('notas', x => texto(x, 5000)),
  };
  if (montos(req)) {
    d.precio_especial = val('precio_especial', x => dec(x, { nulo: true }));
    d.descuento_pct = val('descuento_pct', x => Math.min(100, dec(x)));
    d.incluye_igv = val('incluye_igv', x => (x === true || x === '1' || x === 1 ? 1 : 0));
  }
  Object.keys(d).forEach(k => d[k] === undefined && delete d[k]);
  return d;
}

async function siguienteCodigo() {
  const anio = fechaLima().slice(0, 4);
  const [[r]] = await db.query("SELECT MAX(CAST(SUBSTRING_INDEX(codigo, '-', -1) AS UNSIGNED)) AS n FROM suscripciones WHERE codigo LIKE ?", [`SUS-${anio}-%`]);
  return `SUS-${anio}-${String((r.n || 0) + 1).padStart(3, '0')}`;
}

// Integración: { integracion_id, precio_mensual? } (precio propio para este cliente)
async function agregarIntegracion(sid, item, req) {
  const intId = parseInt(item.integracion_id ?? item, 10);
  const [[i]] = await db.query('SELECT * FROM saas_integraciones WHERE id = ?', [intId]);
  if (!i) throw new HttpError(422, 'Integración no encontrada.');
  const precio = montos(req) && item.precio_mensual !== undefined && item.precio_mensual !== '' ? dec(item.precio_mensual) : r2(i.precio_mensual);
  await db.query(`INSERT INTO suscripcion_integraciones (suscripcion_id, integracion_id, precio_mensual, activo, fecha_alta, fecha_baja)
    VALUES (?,?,?,1,?,NULL)
    ON DUPLICATE KEY UPDATE activo = 1, fecha_baja = NULL, fecha_alta = VALUES(fecha_alta), precio_mensual = VALUES(precio_mensual)`,
  [sid, i.id, precio, fechaOk(item.fecha_alta) || fechaLima()]);
  return i;
}

router.post('/', gestionar, ah(async (req, res) => {
  const negocioId = parseInt(req.body.negocio_id, 10);
  if (!negocioId) throw new HttpError(422, 'Elige el cliente.');
  await asegurarAcceso(req, negocioId);
  const plan = await planValido(parseInt(req.body.plan_id, 10));
  if (!Number(plan.activo) || !Number(plan.producto_activo)) throw new HttpError(422, 'Ese plan está desactivado.');
  const d = leer(req.body, req);
  Object.assign(d, { negocio_id: negocioId, plan_id: plan.id, moneda: plan.moneda, creado_por: req.user.id, responsable_id: d.responsable_id || req.user.id, estado: 'activa' });

  let id;
  for (let intento = 0; intento < 3 && !id; intento++) {
    try { d.codigo = await siguienteCodigo(); [{ insertId: id }] = await db.query('INSERT INTO suscripciones SET ?', [d]); }
    catch (e) { if (e.code !== 'ER_DUP_ENTRY' || intento === 2) throw e; }
  }
  for (const it of Array.isArray(req.body.integraciones) ? req.body.integraciones : []) await agregarIntegracion(id, { ...it, fecha_alta: d.fecha_inicio }, req);
  await S.registrarHistorial({ id, codigo: d.codigo, negocio_id: negocioId }, `Suscripción registrada: plan ${plan.nombre}, ciclo ${CICLOS[d.ciclo].toLowerCase()}, desde ${d.fecha_inicio}`, req.user);
  await audit(req, 'suscripcion_creada', { entidad: 'suscripcion', entidadId: id, detalle: { codigo: d.codigo, cliente: negocioId, plan: plan.id } });
  res.status(201).json({ ok: true, id, codigo: d.codigo });
}));

router.put('/:id', gestionar, ah(async (req, res) => {
  const previo = await cargar(req, parseInt(req.params.id, 10));
  const d = leer(req.body, req, previo);
  const cambios = [];
  if (req.body.plan_id && Number(req.body.plan_id) !== Number(previo.plan_id)) {
    const plan = await planValido(parseInt(req.body.plan_id, 10));
    if (plan.moneda !== previo.moneda) throw new HttpError(422, 'El plan nuevo usa otra moneda: cancela esta suscripción y registra una nueva.');
    d.plan_id = plan.id;
    cambios.push(`plan ${previo.plan_nombre} → ${plan.nombre}`);
  }
  if (d.ciclo !== previo.ciclo) cambios.push(`ciclo ${CICLOS[previo.ciclo].toLowerCase()} → ${CICLOS[d.ciclo].toLowerCase()}`);
  if (d.fecha_inicio !== previo.fecha_inicio) cambios.push(`fecha de inicio ${previo.fecha_inicio} → ${d.fecha_inicio}`);
  if (montos(req) && (Number(d.precio_especial ?? -1) !== Number(previo.precio_especial ?? -1) || Number(d.descuento_pct) !== Number(previo.descuento_pct)))
    cambios.push('precio o descuento');
  await db.query('UPDATE suscripciones SET ? WHERE id = ?', [d, previo.id]);
  if (cambios.length) await S.registrarHistorial(previo, `Cambios: ${cambios.join(', ')}`, req.user);
  res.json({ ok: true });
}));

// ── Estado manual: suspender / reactivar / cancelar ──────────────────────
router.post('/:id/estado', gestionar, ah(async (req, res) => {
  const s = await cargar(req, parseInt(req.params.id, 10));
  const accion = String(req.body.accion || '');
  const motivo = texto(req.body.motivo, 300);
  if (accion === 'suspender') {
    if (s.estado !== 'activa') throw new HttpError(422, 'Solo se puede suspender una suscripción activa.');
    await db.query("UPDATE suscripciones SET estado = 'suspendida' WHERE id = ?", [s.id]);
    await S.registrarHistorial(s, `Suspendida${motivo ? ` — ${motivo}` : ''}`, req.user);
  } else if (accion === 'reactivar') {
    if (s.estado === 'activa') throw new HttpError(422, 'La suscripción ya está activa.');
    await db.query("UPDATE suscripciones SET estado = 'activa', cancelada_at = NULL, motivo_cancelacion = NULL WHERE id = ?", [s.id]);
    await S.registrarHistorial(s, 'Reactivada', req.user);
  } else if (accion === 'cancelar') {
    if (s.estado === 'cancelada') throw new HttpError(422, 'La suscripción ya está cancelada.');
    const fecha = fechaOk(req.body.fecha) || fechaLima();
    await db.query("UPDATE suscripciones SET estado = 'cancelada', cancelada_at = ?, motivo_cancelacion = ? WHERE id = ?", [fecha, motivo, s.id]);
    await S.registrarHistorial(s, `Cancelada el ${fecha}${motivo ? ` — ${motivo}` : ''}`, req.user);
  } else throw new HttpError(422, 'Acción no válida.');
  await audit(req, 'suscripcion_estado', { entidad: 'suscripcion', entidadId: s.id, detalle: { de: s.estado, accion } });
  res.json({ ok: true });
}));

// ── Integraciones de la suscripción ──────────────────────────────────────
router.post('/:id/integraciones', gestionar, ah(async (req, res) => {
  const s = await cargar(req, parseInt(req.params.id, 10));
  if (s.estado === 'cancelada') throw new HttpError(422, 'La suscripción está cancelada.');
  const i = await agregarIntegracion(s.id, req.body, req);
  await S.registrarHistorial(s, `Integración agregada: ${i.nombre}`, req.user);
  res.status(201).json({ ok: true });
}));

router.delete('/integraciones/item/:iid', gestionar, ah(async (req, res) => {
  const [[x]] = await db.query('SELECT si.suscripcion_id, i.nombre FROM suscripcion_integraciones si JOIN saas_integraciones i ON i.id = si.integracion_id WHERE si.id = ?', [req.params.iid]);
  if (!x) throw new HttpError(404, 'Integración no encontrada');
  const s = await cargar(req, x.suscripcion_id);
  await db.query('UPDATE suscripcion_integraciones SET activo = 0, fecha_baja = ? WHERE id = ?', [fechaLima(), req.params.iid]);
  await S.registrarHistorial(s, `Integración retirada: ${x.nombre}`, req.user);
  res.json({ ok: true });
}));

// ── Pagos ─────────────────────────────────────────────────────────────────
router.post('/:id/pagos', requirePerm('suscripciones.cobros'), upload.single('comprobante'), ah(async (req, res) => {
  if (!req.user.can('suscripciones.gestionar')) throw new HttpError(403, 'No tienes permiso para registrar pagos.');
  const s = await cargar(req, parseInt(req.params.id, 10));
  const monto = r2(parseFloat(req.body.monto));
  if (!(monto > 0)) throw new HttpError(422, 'Escribe el monto pagado.');
  const inicio = fechaOk(req.body.periodo_inicio);
  if (!inicio) throw new HttpError(422, 'Indica el periodo que cubre el pago.');
  const fin = fechaOk(req.body.periodo_fin) || S.sumarDias(S.sumarMeses(inicio, MESES[s.ciclo] || 1), -1);
  if (fin < inicio) throw new HttpError(422, 'El fin del periodo no puede ser anterior al inicio.');
  const fecha = fechaOk(req.body.fecha) || fechaLima();
  const [r] = await db.query('INSERT INTO suscripcion_pagos SET ?', [{
    suscripcion_id: s.id, periodo_inicio: inicio, periodo_fin: fin, monto, fecha,
    metodo: METODOS.includes(req.body.metodo) ? req.body.metodo : 'otro', referencia: texto(req.body.referencia, 150),
    notas: texto(req.body.notas, 300), comprobante_url: req.file ? `/uploads/${req.file.filename}` : null, registrado_por: req.user.id,
  }]);
  await S.registrarHistorial(s, `Pago registrado del periodo ${inicio} al ${fin} (${req.body.metodo || 'pago'})`, req.user);
  await audit(req, 'suscripcion_pago', { entidad: 'suscripcion', entidadId: s.id, detalle: { monto, fecha, periodo: inicio } });
  res.status(201).json({ ok: true, id: r.insertId });
}));

router.delete('/pagos/:pid', requirePerm('suscripciones.cobros'), ah(async (req, res) => {
  if (!req.user.can('suscripciones.gestionar')) throw new HttpError(403, 'No tienes permiso para anular pagos.');
  const [[x]] = await db.query("SELECT suscripcion_id, monto, DATE_FORMAT(periodo_inicio, '%Y-%m-%d') AS periodo_inicio FROM suscripcion_pagos WHERE id = ?", [req.params.pid]);
  if (!x) throw new HttpError(404, 'Pago no encontrado');
  const s = await cargar(req, x.suscripcion_id);
  await db.query('DELETE FROM suscripcion_pagos WHERE id = ?', [req.params.pid]);
  await S.registrarHistorial(s, `Se anuló el pago del periodo ${x.periodo_inicio}`, req.user);
  await audit(req, 'suscripcion_pago_eliminado', { entidad: 'suscripcion', entidadId: s.id, detalle: { monto: x.monto, periodo: x.periodo_inicio } });
  res.json({ ok: true });
}));

router.delete('/:id', gestionar, ah(async (req, res) => {
  const s = await cargar(req, parseInt(req.params.id, 10));
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM suscripcion_pagos WHERE suscripcion_id = ?', [s.id]);
  if (n) throw new HttpError(422, 'La suscripción tiene pagos registrados: cancélala en lugar de eliminarla.');
  await db.query('DELETE FROM suscripciones WHERE id = ?', [s.id]);
  await audit(req, 'suscripcion_eliminada', { entidad: 'suscripcion', entidadId: s.id, detalle: { codigo: s.codigo } });
  res.json({ ok: true });
}));

module.exports = router;
