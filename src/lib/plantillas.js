// Plantillas de WhatsApp: validación, etiquetas [dato] → {{n}}, copia local del estado en Meta
// y plantillas del sistema (recordatorios y alertas).
const db     = require('../db');
const meta   = require('../meta');
const config = require('./config');
const { HttpError, VARIABLES } = require('./utils');

const ESTADO_DESDE_META = {
  APPROVED: 'aprobada', PENDING: 'pendiente', IN_APPEAL: 'pendiente', REJECTED: 'rechazada',
  PAUSED: 'pausada', DISABLED: 'deshabilitada', FLAGGED: 'pausada', LIMIT_EXCEEDED: 'deshabilitada',
  PENDING_DELETION: 'deshabilitada', DELETED: 'deshabilitada', REINSTATED: 'aprobada',
};

// Ejemplos que Meta exige para cada variable al revisar una plantilla
const EJEMPLOS = {
  nombre: 'Ferretería San Martín', contacto: 'María', telefono: '987654321', distrito: 'Miraflores',
  provincia: 'Lima', departamento: 'Lima', rubro: 'ferreterías', responsable: 'Carlos',
  fecha: 'jueves 30 de octubre', hora: '10:30 a. m.', lead: 'Juan Pérez', empresa_lead: 'Clínica Huellitas',
  whatsapp: '51987654321', plan: 'Profesional',
  proyecto: 'Sistema de citas', concepto: 'Adelanto (50 %)', monto: 'S/ 1,500', dias: '30',
};

/**
 * Revisa la plantilla con las reglas que más rechaza Meta.
 * Devuelve la lista de problemas (vacía = OK).
 */
function validarPlantilla({ nombre, categoria, cuerpo, ejemplos, pie, encabezado, boton }) {
  const p = [];
  if (!/^[a-z0-9_]{1,512}$/.test(nombre || '')) p.push('El nombre solo puede tener minúsculas, números y guion bajo (ej. promo_octubre).');
  if (!['UTILITY', 'MARKETING'].includes(categoria)) p.push('Elige la categoría: Utilidad o Marketing.');
  const txt = String(cuerpo || '').trim();
  if (!txt) p.push('Escribe el texto del mensaje.');
  if (txt.length > 1024) p.push('El mensaje no puede pasar de 1024 caracteres.');

  // Meta solo acepta variables numeradas {{1}}, {{2}}… (otro contenido entre llaves = INVALID_FORMAT)
  if (/\{\{(?!\s*\d+\s*\}\})/.test(txt)) p.push('Hay un dato con formato inválido entre llaves {{ }}. Usa los botones de datos.');
  const unicas = [...new Set(meta.variablesDe(txt))].sort((a, b) => a - b);
  unicas.forEach((n, i) => { if (n !== i + 1) p.push('Las variables deben ir en orden: {{1}}, {{2}}, {{3}}…'); });
  if (/^\{\{\s*\d+\s*\}\}/.test(txt)) p.push('El mensaje no puede empezar con un dato variable.');
  if (/\{\{\s*\d+\s*\}\}[\s.!?¡¿]*$/.test(txt)) p.push('El mensaje no puede terminar con un dato variable (agrega texto después).');
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(txt)) p.push('No pongas dos datos seguidos: escribe texto entre ellos.');
  const palabras = txt.replace(/\{\{\s*\d+\s*\}\}/g, ' ').split(/\s+/).filter(Boolean).length;
  if (unicas.length && palabras < unicas.length * 2 + 1) p.push('Hay demasiados datos variables para tan poco texto.');
  if ((ejemplos || []).length < unicas.length || (ejemplos || []).slice(0, unicas.length).some(e => !String(e || '').trim()))
    p.push('Falta un ejemplo para cada dato variable (Meta lo exige).');
  if (pie && String(pie).length > 60) p.push('El pie de mensaje no puede pasar de 60 caracteres.');
  if (encabezado && String(encabezado).length > 60) p.push('El encabezado no puede pasar de 60 caracteres.');
  if (encabezado && meta.variablesDe(encabezado).length) p.push('El encabezado no puede tener datos variables.');
  if (boton) {
    if (!boton.texto || boton.texto.length > 25) p.push('El texto del botón es obligatorio y puede tener hasta 25 caracteres.');
    if (!/^https:\/\/[^\s{}]+\.[^\s{}]+$/i.test(boton.url || '') || boton.url.length > 2000) p.push('El enlace del botón debe empezar con https:// (ej. https://tuerkapp.com/registro).');
  }
  return [...new Set(p)];
}

/**
 * Texto con etiquetas [contacto], [distrito]… → {{1}}, {{2}}… en orden de aparición.
 * [empresa] se escribe fijo (nombre de la empresa). Devuelve { cuerpo, nombres, ejemplos }.
 */
async function convertirEtiquetas(texto, permitidas = Object.keys(VARIABLES)) {
  let t = String(texto || '').replace(/\r/g, '').trim();
  if (/\{\{\s*\d+\s*\}\}/.test(t)) throw new HttpError(422, 'Usa los botones de datos ([contacto], [distrito]…) en lugar de {{1}}, {{2}}.');
  // Formato de las campañas antiguas ({{nombre}}, {{distrito}}): se trata igual que [nombre], [distrito]
  t = t.replace(/\{\{\s*([a-z_]{1,30})\s*\}\}/gi, '[$1]');
  if (/\{\{|\}\}/.test(t)) throw new HttpError(422, 'Hay llaves {{ }} que Meta no acepta. Para insertar datos usa los botones [contacto], [distrito]…');
  const empresa = (await config.get('empresa_nombre')) || 'nuestra empresa';
  t = t.replace(/\[empresa\]/gi, empresa);
  const nombres = [];
  t = t.replace(/\[([a-z_]{1,30})\]/gi, (m, k) => {
    k = k.toLowerCase();
    if (!permitidas.includes(k)) throw new HttpError(422, `El dato [${k}] no existe. Usa: ${permitidas.map(x => `[${x}]`).join(', ')}, [empresa].`);
    let i = nombres.indexOf(k);
    if (i === -1) { nombres.push(k); i = nombres.length - 1; }
    return `{{${i + 1}}}`;
  });
  return { cuerpo: t, nombres, ejemplos: nombres.map(n => EJEMPLOS[n] || n) };
}

function componentes({ encabezado, cuerpo, pie, ejemplos, imagenHandle, boton }) {
  const nVars = [...new Set(meta.variablesDe(cuerpo))].length;
  const c = [];
  if (imagenHandle) c.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [imagenHandle] } });
  else if (encabezado) c.push({ type: 'HEADER', format: 'TEXT', text: encabezado });
  const body = { type: 'BODY', text: cuerpo };
  if (nVars) body.example = { body_text: [ejemplos.slice(0, nVars)] };
  c.push(body);
  if (pie) c.push({ type: 'FOOTER', text: pie });
  // Botón de enlace fijo (no necesita parámetros al enviar)
  if (boton) c.push({ type: 'BUTTONS', buttons: [{ type: 'URL', text: boton.texto, url: boton.url }] });
  return c;
}

// Crea la plantilla en Meta (queda en revisión) y la registra localmente
async function crear({ nombre, categoria, idioma = 'es', cuerpoEtiquetas, encabezado, pie, imagen, boton = null, uso = 'manual', esSistema = 0, permitidas, usuarioId = null }) {
  const conv = await convertirEtiquetas(cuerpoEtiquetas, permitidas);
  const datos = {
    nombre: String(nombre || '').trim().toLowerCase(),
    categoria: String(categoria || '').toUpperCase(),
    idioma,
    encabezado: imagen ? '' : String(encabezado || '').trim(),
    cuerpo: conv.cuerpo,
    pie: String(pie || '').trim(),
    ejemplos: conv.ejemplos,
    boton: boton && (boton.texto || boton.url) ? { texto: String(boton.texto || '').trim(), url: String(boton.url || '').trim() } : null,
  };
  const problemas = validarPlantilla(datos);
  if (problemas.length) { const e = new HttpError(422, problemas[0]); e.problemas = problemas; throw e; }

  if (imagen) datos.imagenHandle = await meta.subirImagenEjemplo(imagen.ruta, imagen.mime);
  const { token, wabaId } = await meta.credenciales();
  const d = await meta.graph('POST', `${wabaId}/message_templates`, {
    token, body: { name: datos.nombre, language: datos.idioma, category: datos.categoria, components: componentes(datos) },
  });
  await db.query(`
    INSERT INTO wa_plantillas (nombre_meta, idioma, categoria, uso, encabezado_tipo, encabezado_texto, cuerpo, variables, pie,
      meta_template_id, estado, es_sistema, activo, creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
    ON DUPLICATE KEY UPDATE categoria=VALUES(categoria), uso=VALUES(uso), encabezado_tipo=VALUES(encabezado_tipo),
      encabezado_texto=VALUES(encabezado_texto), cuerpo=VALUES(cuerpo), variables=VALUES(variables), pie=VALUES(pie),
      meta_template_id=VALUES(meta_template_id), estado=VALUES(estado), es_sistema=VALUES(es_sistema), activo=1`,
    [datos.nombre, datos.idioma, datos.categoria, uso, imagen ? 'imagen' : (datos.encabezado ? 'texto' : 'ninguno'),
     datos.encabezado || null, datos.cuerpo, JSON.stringify(conv.nombres), datos.pie || null,
     d.id || null, ESTADO_DESDE_META[d.status] || 'pendiente', esSistema, usuarioId]);
  meta.invalidarPlantillas();
  return { id: d.id, estado: d.status || 'PENDING', categoria: d.category || datos.categoria };
}

async function eliminar(nombre) {
  if (!/^[a-z0-9_]{1,512}$/.test(nombre)) throw new HttpError(422, 'Nombre inválido.');
  const { token, wabaId } = await meta.credenciales();
  await meta.graph('DELETE', `${wabaId}/message_templates`, { token, query: { name: nombre } });
  await db.query("UPDATE wa_plantillas SET estado='deshabilitada', activo=0 WHERE nombre_meta=?", [nombre]);
  meta.invalidarPlantillas();
}

// Copia el estado que tiene Meta (aprobada, rechazada…) en wa_plantillas
async function sincronizar(lista) {
  const [filas] = await db.query('SELECT id, nombre_meta, idioma, meta_template_id FROM wa_plantillas');
  for (const f of filas) {
    const t = lista.find(x => x.name === f.nombre_meta && x.language === f.idioma);
    if (t) {
      await db.query('UPDATE wa_plantillas SET estado=?, categoria=?, motivo_rechazo=?, meta_template_id=?, activo=1 WHERE id=?',
        [ESTADO_DESDE_META[t.status] || 'pendiente', ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(t.category) ? t.category : 'UTILITY',
         t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason).slice(0, 255) : null, t.id, f.id]);
    } else if (f.meta_template_id) {
      await db.query("UPDATE wa_plantillas SET estado='deshabilitada', activo=0 WHERE id=?", [f.id]);
    }
  }
}

// Lista de Meta + datos locales (uso, nombres de variables). Sincroniza de paso.
async function listar() {
  const lista = await meta.plantillasMeta();
  await sincronizar(lista);
  meta.invalidarPlantillas();
  const [locales] = await db.query('SELECT nombre_meta, idioma, uso, es_sistema, variables FROM wa_plantillas WHERE activo = 1');
  return lista.map(t => {
    const v = meta.vistaPlantilla(t);
    const u = locales.find(x => x.nombre_meta === t.name && x.idioma === t.language);
    let nombres = null;
    try { nombres = u?.variables ? JSON.parse(u.variables) : null; } catch { nombres = null; }
    if (!Array.isArray(nombres) || nombres.length !== v.variables) nombres = null;
    return { ...v, uso: u?.uso || null, es_sistema: !!(u && Number(u.es_sistema)) || /^crm_/.test(t.name), variables_nombres: nombres };
  });
}

// ── Plantillas del sistema ────────────────────────────────────────────────
const SISTEMA = [
  { uso: 'recordatorio_reunion', nombre: 'crm_recordatorio_reunion', categoria: 'UTILITY', titulo: 'Recordatorio de reunión',
    descripcion: 'Se envía 24 h y 1 h antes de cada reunión agendada.',
    datos: ['contacto', 'fecha', 'hora'],
    texto: 'Hola [contacto], te recordamos tu reunión con [empresa] el [fecha] a las [hora]. Si necesitas reprogramarla, responde este mensaje.' },
  { uso: 'alerta_lead', nombre: 'crm_alerta_lead', categoria: 'UTILITY', titulo: 'Aviso de nuevo lead',
    descripcion: 'Avisa al número configurado cada vez que llega un lead desde el formulario web.',
    datos: ['lead', 'empresa_lead', 'whatsapp', 'plan'],
    texto: 'Nuevo lead en el CRM: [lead] de [empresa_lead], WhatsApp [whatsapp], interesado en el plan [plan]. Revísalo en el panel.' },
  { uso: 'proyecto_cuota', nombre: 'crm_proyecto_cuota', categoria: 'UTILITY', titulo: 'Cuota de proyecto por vencer',
    descripcion: 'Recuerda al cliente una cuota de su proyecto 3 días antes del vencimiento (si lo activas en Configuración → Proyectos).',
    datos: ['contacto', 'concepto', 'proyecto', 'monto', 'fecha'],
    texto: 'Hola [contacto], te recordamos que la cuota "[concepto]" del proyecto [proyecto] por [monto] vence el [fecha]. Si ya realizaste el pago, envíanos el comprobante por aquí. ¡Gracias!' },
  { uso: 'proyecto_entrega', nombre: 'crm_proyecto_entrega', categoria: 'UTILITY', titulo: 'Proyecto entregado',
    descripcion: 'Avisa al cliente que su proyecto fue entregado y cuántos días de soporte tiene (si lo activas en Configuración → Proyectos).',
    datos: ['contacto', 'proyecto', 'dias'],
    texto: 'Hola [contacto], tu proyecto [proyecto] ya fue entregado por [empresa]. Desde hoy cuentas con [dias] días de soporte: escríbenos por aquí ante cualquier consulta.' },
];

async function estadoSistema() {
  const [filas] = await db.query("SELECT * FROM wa_plantillas WHERE es_sistema = 1 AND activo = 1");
  return SISTEMA.map(s => {
    const f = filas.find(x => x.uso === s.uso);
    return { ...s, estado: f?.estado || 'sin_crear', motivo_rechazo: f?.motivo_rechazo || null, nombre_meta: f?.nombre_meta || s.nombre };
  });
}

async function crearSistema(uso, usuarioId) {
  const s = SISTEMA.find(x => x.uso === uso);
  if (!s) throw new HttpError(404, 'Plantilla del sistema desconocida.');
  return crear({ nombre: s.nombre, categoria: s.categoria, cuerpoEtiquetas: s.texto, uso: s.uso, esSistema: 1, permitidas: s.datos, usuarioId });
}

// Plantilla aprobada para un uso del sistema (o null)
async function aprobadaPara(uso) {
  const [[f]] = await db.query("SELECT * FROM wa_plantillas WHERE uso = ? AND estado = 'aprobada' AND activo = 1 ORDER BY id DESC LIMIT 1", [uso]);
  if (!f) return null;
  try { f.variables = JSON.parse(f.variables || '[]'); } catch { f.variables = []; }
  return f;
}

module.exports = {
  ESTADO_DESDE_META, EJEMPLOS, SISTEMA, validarPlantilla, convertirEtiquetas, crear, eliminar,
  sincronizar, listar, estadoSistema, crearSistema, aprobadaPara,
};
