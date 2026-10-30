// Campañas por WhatsApp con plantillas aprobadas por Meta (las envía el procesador de queue.js)
// Estados: borrador → programada → enviando ⇄ pausada → completada | cancelada
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const meta    = require('../meta');
const config  = require('../lib/config');
const queue   = require('../queue');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { upload } = require('../lib/uploads');
const { filtroContactos } = require('../lib/filtros');
const { emitir } = require('../lib/notificar');
const { ah, HttpError, texto, entero, VARIABLES } = require('../lib/utils');

router.get('/variables', ah(async (req, res) => res.json({ ok: true, variables: VARIABLES })));

// Compatibilidad: lista de plantillas para la bandeja
router.get('/plantillas', requirePerm('campanas.ver', 'chat.enviar'), ah(async (req, res) => {
  res.json({ ok: true, rows: await meta.listarPlantillas({ forzar: req.query.forzar === '1' }) });
}));

const SELECT = `
  SELECT c.id, c.nombre, c.tipo, c.estado, c.mensaje, c.imagen_url, c.programada_at, c.iniciada_at, c.pausada_at, c.completada_at,
         c.total, c.enviados, c.fallidos, c.filtros, c.etapa_destino, c.meta_variables, c.ultimo_error, c.created_at, c.contactos_cargados,
         c.template_nombre, p.nombre_meta AS plantilla, p.idioma AS plantilla_idioma, p.estado AS plantilla_estado,
         u.nombre AS creado_por_nombre,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('pendiente','procesando')) AS pendientes,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado IN ('entregado','leido')) AS entregados,
         (SELECT COUNT(*) FROM envios e WHERE e.campana_id = c.id AND e.estado = 'leido') AS leidos
  FROM campanas c
  LEFT JOIN wa_plantillas p ON p.id = c.meta_plantilla_id
  LEFT JOIN usuarios u ON u.id = c.creado_por`;

router.get('/', requirePerm('campanas.ver'), ah(async (req, res) => {
  const [rows] = await db.query(`${SELECT} ORDER BY FIELD(c.estado,'enviando','programada','pausada','borrador','completada','cancelada'), c.id DESC LIMIT 200`);
  rows.forEach(r => {
    try { r.filtros = JSON.parse(r.filtros || '{}'); } catch { r.filtros = {}; }
    try { r.meta_variables = JSON.parse(r.meta_variables || '[]'); } catch { r.meta_variables = []; }
  });
  res.json({ ok: true, rows, procesador: queue.getEstado(), bloqueo: await queue.bloqueo() });
}));

router.get('/:id/envios', requirePerm('campanas.ver', 'envios.ver'), ah(async (req, res) => {
  const w = ['e.campana_id = ?'], v = [parseInt(req.params.id, 10)];
  if (req.query.estado) { w.push('e.estado = ?'); v.push(req.query.estado); }
  const lim = entero(req.query.limit, 50, 1, 500), off = entero(req.query.offset, 0, 0);
  const [rows] = await db.query(`SELECT e.id, e.negocio_id, e.numero, e.estado, e.error_msg, e.intentos, e.enviado_at, e.entregado_at, e.leido_at, n.nombre
    FROM envios e JOIN negocios n ON n.id = e.negocio_id WHERE ${w.join(' AND ')} ORDER BY e.id LIMIT ? OFFSET ?`, [...v, lim, off]);
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM envios e WHERE ${w.join(' AND ')}`, v);
  res.json({ ok: true, rows, total });
}));

// Cuántos contactos recibirían la campaña con estos filtros
function audienciaSQL(req, filtros = {}) {
  let where, vals;
  if (Array.isArray(filtros.ids) && filtros.ids.length) {
    const f = filtroContactos({}, req);
    where = `${f.where} AND n.id IN (?)`; vals = [...f.vals, filtros.ids.map(Number).filter(Boolean)];
  } else {
    ({ where, vals } = filtroContactos({ ...filtros, wa: filtros.wa || 'aptos' }, req));
  }
  return { where: `${where} AND COALESCE(n.wa_verificado, 1) = 1`, vals };
}

router.post('/audiencia', requirePerm('envios.ejecutar', 'campanas.gestionar'), ah(async (req, res) => {
  const { where, vals } = audienciaSQL(req, req.body.filtros || {});
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM negocios n WHERE ${where}`, vals);
  const [muestra] = await db.query(`SELECT n.id, n.nombre, n.contacto_nombre, n.distrito, n.rubro_busqueda FROM negocios n WHERE ${where} ORDER BY n.id LIMIT 5`, vals);
  res.json({ ok: true, total, muestra, limite_diario: await config.getInt('limite_diario'), hoy: await queue.enviadosHoy() });
}));

// body (multipart): nombre, plantilla 'nombre|idioma', variables JSON [{tipo:'dato'|'fijo', valor}],
//                   filtros JSON, etapa_destino, programada_at, iniciar ('1'), imagen (archivo)
router.post('/', requirePerm('campanas.gestionar'), upload.single('imagen'), ah(async (req, res) => {
  const b = req.body || {};
  const nombre = texto(b.nombre, 150);
  if (!nombre) throw new HttpError(422, 'Ponle un nombre a la campaña.');

  let filtros = {}, vars = [];
  try { filtros = typeof b.filtros === 'string' ? JSON.parse(b.filtros || '{}') : (b.filtros || {}); } catch { throw new HttpError(422, 'Filtros inválidos.'); }
  try { vars = typeof b.variables === 'string' ? JSON.parse(b.variables || '[]') : (b.variables || []); } catch { throw new HttpError(422, 'Variables inválidas.'); }

  let programada = null;
  if (b.programada_at) {
    programada = new Date(b.programada_at);
    if (Number.isNaN(programada.getTime())) throw new HttpError(422, 'Fecha de programación inválida.');
    if (programada < new Date(Date.now() - 5 * 60000)) throw new HttpError(422, 'La fecha programada ya pasó.');
  }

  const [pNombre, pIdioma] = String(b.plantilla || '').split('|');
  if (!/^[a-z0-9_]{1,512}$/.test(pNombre || '')) throw new HttpError(422, 'Elige una plantilla aprobada.');
  const t = (await meta.plantillasMeta(pNombre)).find(x => x.name === pNombre && (!pIdioma || x.language === pIdioma));
  if (!t) throw new HttpError(422, 'La plantilla ya no existe en Meta.');
  if (t.status !== 'APPROVED') throw new HttpError(422, 'La plantilla todavía no está aprobada por Meta.');
  const vt = meta.vistaPlantilla(t);
  if (vt.header && !['TEXT', 'IMAGE'].includes(vt.header)) throw new HttpError(422, 'Las campañas usan plantillas de texto o con imagen (no video ni documento).');
  if (vt.header === 'IMAGE' && !req.file) throw new HttpError(422, 'Esta plantilla lleva imagen en el encabezado: elige la imagen de la campaña.');

  if (vars.length < vt.variables) throw new HttpError(422, 'Indica qué va en cada dato variable de la plantilla.');
  const mapeo = [];
  for (let i = 0; i < vt.variables; i++) {
    const v = vars[i] || {};
    if (v.tipo === 'dato' && v.valor in VARIABLES) mapeo.push({ tipo: 'dato', valor: v.valor });
    else if (v.tipo === 'fijo' && String(v.valor || '').trim()) mapeo.push({ tipo: 'fijo', valor: String(v.valor).trim().replace(/\s+/g, ' ').slice(0, 200) });
    else throw new HttpError(422, `Completa el dato {{${i + 1}}}.`);
  }
  const vista = vt.cuerpo.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => { const m = mapeo[n - 1]; return !m ? '' : m.tipo === 'dato' ? `[${m.valor}]` : m.valor; });

  const destino = b.etapa_destino && b.etapa_destino !== 'sin_cambio' ? String(b.etapa_destino) : null;
  if (destino) { const [[e]] = await db.query('SELECT clave FROM etapas WHERE clave = ?', [destino]); if (!e) throw new HttpError(422, 'Etapa de destino inválida.'); }
  filtros.maximo = entero(filtros.maximo, 5000, 1, 20000);

  // Asegura la plantilla en la tabla local
  await db.query(`INSERT INTO wa_plantillas (nombre_meta, idioma, categoria, uso, encabezado_tipo, cuerpo, meta_template_id, estado, activo)
    VALUES (?,?,?, 'campana', ?, ?, ?, 'aprobada', 1)
    ON DUPLICATE KEY UPDATE categoria = VALUES(categoria), encabezado_tipo = VALUES(encabezado_tipo), cuerpo = VALUES(cuerpo),
      meta_template_id = VALUES(meta_template_id), estado = 'aprobada', activo = 1`,
    [t.name, t.language, ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(t.category) ? t.category : 'MARKETING',
     vt.header === 'IMAGE' ? 'imagen' : vt.header === 'TEXT' ? 'texto' : 'ninguno', vt.cuerpo, t.id]);
  const [[pl]] = await db.query('SELECT id FROM wa_plantillas WHERE nombre_meta = ? AND idioma = ?', [t.name, t.language]);

  const estado = programada ? 'programada' : (b.iniciar === '1' && req.user.can('envios.ejecutar') ? 'enviando' : 'borrador');
  const [r] = await db.query('INSERT INTO campanas SET ?', [{
    nombre, mensaje: vista, tipo: 'plantilla', estado, programada_at: programada,
    iniciada_at: estado === 'enviando' ? new Date() : null,
    imagen_url: req.file ? `/uploads/${req.file.filename}` : null,
    template_nombre: t.name, template_idioma: t.language, template_header: vt.header,
    filtros: JSON.stringify(filtros), etapa_destino: destino, meta_plantilla_id: pl.id,
    meta_variables: JSON.stringify(mapeo), creado_por: req.user.id, contactos_cargados: 0,
  }]);
  await audit(req, 'campana_creada', { entidad: 'campana', entidadId: r.insertId, detalle: { nombre, plantilla: t.name, estado } });
  emitir('campana:estado', { id: r.insertId, estado });
  res.status(201).json({ ok: true, id: r.insertId, estado });
}));

const ACCIONES = {
  iniciar:  { desde: ['borrador'], sql: "estado='enviando', iniciada_at=IFNULL(iniciada_at, NOW()), ultimo_error=NULL", msg: 'Campaña iniciada.' },
  pausar:   { desde: ['enviando', 'programada'], sql: "estado='pausada', pausada_at=NOW()", msg: 'Campaña pausada.' },
  reanudar: { desde: ['pausada'], sql: "estado='enviando', iniciada_at=IFNULL(iniciada_at, NOW()), ultimo_error=NULL", msg: 'Campaña reanudada.' },
  cancelar: { desde: ['borrador', 'programada', 'enviando', 'pausada'], sql: "estado='cancelada'", msg: 'Campaña cancelada.' },
};

router.post('/:id/reintentar', requirePerm('envios.ejecutar'), ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [r] = await db.query(`UPDATE envios e JOIN negocios n ON n.id = e.negocio_id
    SET e.estado = 'pendiente', e.intentos = 0, e.error_msg = NULL
    WHERE e.campana_id = ? AND e.estado = 'fallido' AND COALESCE(n.wa_verificado, 1) = 1`, [id]);
  if (r.affectedRows) {
    await db.query(`UPDATE campanas SET fallidos = GREATEST(fallidos - ?, 0),
      estado = IF(estado IN ('completada','pausada'), 'enviando', estado), completada_at = NULL WHERE id = ?`, [r.affectedRows, id]);
    emitir('campana:estado', { id, estado: 'enviando' });
  }
  res.json({ ok: true, reintentos: r.affectedRows });
}));

router.post('/:id/duplicar', requirePerm('campanas.gestionar'), ah(async (req, res) => {
  const [[c]] = await db.query('SELECT * FROM campanas WHERE id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Campaña no encontrada');
  for (const k of ['id', 'created_at', 'programada_at', 'iniciada_at', 'pausada_at', 'completada_at', 'ultimo_error']) delete c[k];
  Object.assign(c, { nombre: `${c.nombre} (copia)`.slice(0, 300), estado: 'borrador', total: 0, enviados: 0, fallidos: 0, contactos_cargados: 0, creado_por: req.user.id });
  if (c.variables && typeof c.variables === 'object') c.variables = JSON.stringify(c.variables);
  const [r] = await db.query('INSERT INTO campanas SET ?', [c]);
  res.json({ ok: true, id: r.insertId });
}));

router.post('/:id/:accion', requirePerm('envios.ejecutar'), ah(async (req, res) => {
  const a = ACCIONES[req.params.accion];
  if (!a) throw new HttpError(404, 'Acción no válida.');
  const [[c]] = await db.query('SELECT id, estado, tipo FROM campanas WHERE id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Campaña no encontrada.');
  if (c.tipo === 'texto') throw new HttpError(422, 'Esta campaña es del sistema anterior (texto libre) y solo queda como historial. Crea una nueva con una plantilla aprobada.');
  if (!a.desde.includes(c.estado)) throw new HttpError(422, `No se puede ${req.params.accion} una campaña ${c.estado}.`);
  if (['iniciar', 'reanudar'].includes(req.params.accion)) await meta.credenciales();
  await db.query(`UPDATE campanas SET ${a.sql} WHERE id = ?`, [c.id]);
  if (req.params.accion === 'cancelar')
    await db.query("UPDATE envios SET estado = 'cancelado', reserva = NULL, error_msg = ? WHERE campana_id = ? AND estado IN ('pendiente','procesando')",
      [`Cancelado por ${req.user.nombre}`, c.id]);
  await audit(req, `campana_${req.params.accion}`, { entidad: 'campana', entidadId: c.id });
  emitir('campana:estado', { id: c.id, estado: req.params.accion });
  res.json({ ok: true, msg: a.msg });
}));

router.delete('/:id', requirePerm('campanas.gestionar'), ah(async (req, res) => {
  const [[c]] = await db.query('SELECT id, estado FROM campanas WHERE id = ?', [req.params.id]);
  if (!c) throw new HttpError(404, 'Campaña no encontrada.');
  if (!['borrador', 'cancelada', 'completada'].includes(c.estado)) throw new HttpError(422, 'Pausa o cancela la campaña antes de eliminarla.');
  await db.query('DELETE FROM campanas WHERE id = ?', [c.id]);
  await audit(req, 'campana_eliminada', { entidad: 'campana', entidadId: c.id });
  res.json({ ok: true });
}));

module.exports = router;
