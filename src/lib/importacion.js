// Carga masiva de contactos desde Excel (.xlsx)
// 1) plantilla(): Excel con la hoja "Contactos", instrucciones, ejemplo y listas desplegables
// 2) analizar(): lee el archivo, valida fila por fila y detecta duplicados (en el archivo y en el CRM)
// 3) importar(): crea los nuevos y, si se pide, completa los datos vacíos de los duplicados
const ExcelJS = require('exceljs');
const crypto  = require('crypto');
const db      = require('../db');
const config  = require('./config');
const UBIGEO  = require('../../data/ubigeo');
const { HttpError, limpiarNumero, normalizarEtiquetas } = require('./utils');

const MAX_FILAS = 5000;

// Columnas de la plantilla: clave interna, encabezado, ancho, ayuda y otros nombres aceptados
const COLUMNAS = [
  { k: 'nombre',          t: 'Nombre del negocio *', w: 32, max: 500,  ayuda: 'Obligatorio. Razón social o nombre comercial.', alias: ['nombre', 'negocio', 'empresa', 'razon social', 'nombre comercial', 'cliente'] },
  { k: 'contacto_nombre', t: 'Persona de contacto',  w: 24, max: 200,  ayuda: 'Nombre de quien atiende. Se usa en los mensajes como [contacto].', alias: ['contacto', 'persona', 'nombre contacto', 'encargado', 'representante'] },
  { k: 'whatsapp',        t: 'WhatsApp',             w: 18, max: 50,   ayuda: 'Celular con o sin código de país. Ej: 987654321 o 51987654321.', alias: ['whatsapp', 'wsp', 'celular', 'movil', 'cel'] },
  { k: 'telefono',        t: 'Teléfono',             w: 16, max: 100,  ayuda: 'Fijo u otro número (opcional).', alias: ['telefono', 'fono', 'telefono fijo', 'tel'] },
  { k: 'email',           t: 'Correo',               w: 28, max: 190,  ayuda: 'Correo electrónico válido.', alias: ['correo', 'email', 'e-mail', 'mail', 'correo electronico'] },
  { k: 'website',         t: 'Sitio web',            w: 26, max: 500,  ayuda: 'Ej: www.miempresa.com', alias: ['web', 'sitio web', 'pagina web', 'website', 'url'] },
  { k: 'direccion',       t: 'Dirección',            w: 34, max: 2000, ayuda: 'Calle, número, referencia.', alias: ['direccion', 'domicilio'] },
  { k: 'departamento',    t: 'Departamento',         w: 16, max: 100,  ayuda: 'Elige de la lista. Ej: Lima.', alias: ['departamento', 'region'] },
  { k: 'provincia',       t: 'Provincia',            w: 16, max: 100,  ayuda: 'Ej: Lima.', alias: ['provincia'] },
  { k: 'distrito',        t: 'Distrito',             w: 18, max: 100,  ayuda: 'Ej: Miraflores.', alias: ['distrito'] },
  { k: 'rubro_busqueda',  t: 'Rubro',                w: 20, max: 200,  ayuda: 'Giro del negocio. Ej: ferreterías.', alias: ['rubro', 'giro', 'categoria', 'sector'] },
  { k: 'etapa',           t: 'Etapa',                w: 18,            ayuda: 'Etapa del pipeline. Si la dejas vacía se usa la etapa elegida al importar.', alias: ['etapa', 'estado', 'etapa crm', 'estado crm'] },
  { k: 'valor_estimado',  t: 'Valor estimado',       w: 14,            ayuda: 'Monto en números, sin símbolo. Ej: 1500.50', alias: ['valor', 'valor estimado', 'monto', 'presupuesto'] },
  { k: 'etiquetas',       t: 'Etiquetas',            w: 22,            ayuda: 'Separadas por coma. Ej: vip, feria-2026', alias: ['etiquetas', 'tags', 'etiqueta'] },
  { k: 'responsable',     t: 'Responsable',          w: 26,            ayuda: 'Correo o nombre del vendedor del CRM. Vacío = quien importa.', alias: ['responsable', 'vendedor', 'asignado', 'asesor', 'asignado a'] },
  { k: 'descripcion',     t: 'Notas',                w: 34, max: 2000, ayuda: 'Observaciones internas.', alias: ['notas', 'nota', 'observaciones', 'descripcion', 'comentarios'] },
];

// ── Normalización ──────────────────────────────────────────────────────────
const sinTildes = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = s => sinTildes(s).toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Índice de ubigeo sin tildes ni mayúsculas → nombre oficial
const UBI = (() => {
  const dep = new Map(), prov = new Map(), dist = new Map();
  for (const [d, provs] of Object.entries(UBIGEO)) {
    dep.set(clave(d), d);
    for (const [p, dists] of Object.entries(provs)) {
      prov.set(`${clave(d)}|${clave(p)}`, p);
      for (const x of dists) dist.set(`${clave(d)}|${clave(p)}|${clave(x)}`, x);
    }
  }
  return { dep, prov, dist };
})();

// Valor de una celda de exceljs como texto plano (números largos sin notación científica)
function valorCelda(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(Math.round(v)).toString() : String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.text !== undefined) return String(v.text);           // hipervínculos
    if (v.result !== undefined) return valorCelda(v.result);   // fórmulas
    if (v.error) return '';
  }
  return String(v);
}
const limpio = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t ? (max ? t.slice(0, max) : t) : null; };

// ── Plantilla ──────────────────────────────────────────────────────────────
async function plantilla({ usuarios = [], etapas = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CRM';
  wb.created = new Date();
  const empresa = await config.get('empresa_nombre').catch(() => '') || 'CRM';

  // Hoja de listas (oculta) para los desplegables
  const listas = wb.addWorksheet('Listas', { state: 'veryHidden' });
  const deps = Object.keys(UBIGEO).sort();
  deps.forEach((d, i) => { listas.getCell(i + 1, 1).value = d; });
  etapas.forEach((e, i) => { listas.getCell(i + 1, 2).value = e.nombre; });
  usuarios.forEach((u, i) => { listas.getCell(i + 1, 3).value = u.email; });

  // Hoja principal
  const ws = wb.addWorksheet('Contactos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNAS.map(c => ({ header: c.t, key: c.k, width: c.w }));
  const head = ws.getRow(1);
  head.height = 30;
  head.eachCell((cell, n) => {
    const obligatoria = COLUMNAS[n - 1].k === 'nombre';
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: obligatoria ? 'FF1F2937' : 'FF4B5563' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.note = COLUMNAS[n - 1].ayuda;
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNAS.length } };

  // Validaciones de Excel (ayudan al llenar; el sistema vuelve a validar todo al importar)
  const col = k => ws.getColumn(COLUMNAS.findIndex(c => c.k === k) + 1).letter;
  const rango = (k, fn) => { for (let r = 2; r <= MAX_FILAS + 1; r++) fn(ws.getCell(`${col(k)}${r}`)); };
  rango('whatsapp', c => { c.numFmt = '@'; });
  rango('telefono', c => { c.numFmt = '@'; });
  rango('departamento', c => { c.dataValidation = { type: 'list', allowBlank: true, formulae: [`Listas!$A$1:$A$${deps.length}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Departamento', error: 'Elige un departamento de la lista.' }; });
  if (etapas.length) rango('etapa', c => { c.dataValidation = { type: 'list', allowBlank: true, formulae: [`Listas!$B$1:$B$${etapas.length}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Etapa', error: 'Elige una etapa de la lista.' }; });
  if (usuarios.length) rango('responsable', c => { c.dataValidation = { type: 'list', allowBlank: true, formulae: [`Listas!$C$1:$C$${usuarios.length}`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Responsable', error: 'Elige un usuario del CRM.' }; });
  rango('valor_estimado', c => { c.numFmt = '#,##0.00'; c.dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, errorTitle: 'Valor estimado', error: 'Escribe un número mayor o igual a 0.' }; });
  rango('email', c => { c.dataValidation = { type: 'custom', allowBlank: true, formulae: [`ISNUMBER(MATCH("*@*.*",${c.address},0))`], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Correo', error: 'El correo no parece válido.' }; });

  // Ejemplo
  const ej = wb.addWorksheet('Ejemplo');
  ej.columns = COLUMNAS.map(c => ({ header: c.t, key: c.k, width: c.w }));
  ej.getRow(1).font = { bold: true };
  ej.addRow({ nombre: 'Ferretería San Martín', contacto_nombre: 'María Torres', whatsapp: '987654321', telefono: '014456789', email: 'ventas@ferreteriasanmartin.pe', website: 'www.ferreteriasanmartin.pe', direccion: 'Av. Larco 123', departamento: 'Lima', provincia: 'Lima', distrito: 'Miraflores', rubro_busqueda: 'ferreterías', etapa: etapas[0]?.nombre || '', valor_estimado: 1500, etiquetas: 'feria-2026, mayorista', responsable: usuarios[0]?.email || '', descripcion: 'Pidió cotización por correo' });
  ej.addRow({ nombre: 'Bodega Don Lucho', contacto_nombre: 'Luis', whatsapp: '+51 912 345 678', departamento: 'Arequipa', provincia: 'Arequipa', distrito: 'Cayma', rubro_busqueda: 'bodegas' });

  // Instrucciones
  const ins = wb.addWorksheet('Instrucciones');
  ins.getColumn(1).width = 26; ins.getColumn(2).width = 90;
  ins.addRow([`Carga masiva de contactos · ${empresa}`]).font = { bold: true, size: 14 };
  ins.addRow([]);
  [
    ['1. Llena la hoja "Contactos"', 'Una fila por negocio. No cambies los títulos de la fila 1 ni el orden de las columnas.'],
    ['2. Obligatorio', 'Solo "Nombre del negocio". Recomendado: WhatsApp o Teléfono o Correo para poder contactarlo.'],
    ['3. Números', 'Escribe el WhatsApp con o sin 51. Se aceptan espacios, guiones y el signo +. Celulares de Perú: 9 dígitos que empiezan con 9.'],
    ['4. Ubicación', 'Departamento, provincia y distrito se comparan con la lista oficial (no importan tildes ni mayúsculas).'],
    ['5. Duplicados', 'Se detectan por WhatsApp, correo o mismo nombre en el mismo distrito, tanto dentro del archivo como contra los contactos que ya existen.'],
    ['6. Límite', `Hasta ${MAX_FILAS.toLocaleString('es-PE')} filas y 5 MB por archivo. Formato .xlsx.`],
    ['7. Sube el archivo', 'En Contactos → Importar Excel. Verás una revisión fila por fila antes de confirmar; nada se guarda hasta que pulses "Importar".'],
    [],
    ['Columna', 'Qué escribir'],
    ...COLUMNAS.map(c => [c.t, c.ayuda]),
    [],
    ['Mira la hoja "Ejemplo"', 'para ver dos filas llenadas correctamente. Esa hoja no se importa.'],
  ].forEach(r => { const row = ins.addRow(r); row.getCell(1).font = { bold: true }; row.alignment = { wrapText: true, vertical: 'top' }; });

  // La hoja de contactos queda como la primera que se abre
  wb.views = [{ activeTab: wb.worksheets.indexOf(ws) }];
  return wb.xlsx.writeBuffer();
}

// ── Lectura y validación ───────────────────────────────────────────────────
async function leerFilas(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); }
  catch { throw new HttpError(422, 'No se pudo leer el archivo. Asegúrate de que sea un Excel .xlsx (si es .xls o .csv, ábrelo en Excel y guárdalo como "Libro de Excel .xlsx").'); }

  // Hoja "Contactos"; si no existe, la primera visible que no sea de ayuda
  const ws = wb.getWorksheet('Contactos')
    || wb.worksheets.find(w => w.state === 'visible' && !['instrucciones', 'ejemplo', 'listas'].includes(clave(w.name)));
  if (!ws) throw new HttpError(422, 'El archivo no tiene una hoja con contactos.');

  // Encabezados: se reconocen por nombre (con o sin tildes) o por sus alias
  const mapa = {};
  const desconocidas = [];
  ws.getRow(1).eachCell((cell, n) => {
    const h = clave(valorCelda(cell.value));
    if (!h) return;
    const c = COLUMNAS.find(x => clave(x.t) === h || x.alias.some(a => clave(a) === h));
    if (c && !Object.values(mapa).includes(c.k)) mapa[n] = c.k;
    else if (!c) desconocidas.push(valorCelda(cell.value));
  });
  if (!Object.values(mapa).includes('nombre'))
    throw new HttpError(422, 'No se encontró la columna "Nombre del negocio" en la fila 1. Descarga la plantilla y copia tus datos en ella.');

  const filas = [];
  let total = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const datos = {};
    let vacia = true;
    for (const [n, k] of Object.entries(mapa)) {
      const v = valorCelda(row.getCell(+n).value).trim();
      if (v) vacia = false;
      datos[k] = v;
    }
    if (vacia) continue;
    total++;
    if (filas.length >= MAX_FILAS) continue;
    filas.push({ fila: r, datos });
  }
  if (!total) throw new HttpError(422, 'La hoja no tiene filas con datos debajo de los encabezados.');
  if (total > MAX_FILAS) throw new HttpError(422, `El archivo tiene ${total.toLocaleString('es-PE')} filas; el máximo por carga es ${MAX_FILAS.toLocaleString('es-PE')}. Divídelo en varios archivos.`);
  return { filas, columnas: Object.values(mapa), desconocidas };
}

function validarFila(d, ctx) {
  const errores = [], avisos = [];
  const c = {};
  for (const col of COLUMNAS) if (col.max && d[col.k] !== undefined) c[col.k] = limpio(d[col.k], col.max);

  if (!c.nombre) errores.push('Falta el nombre del negocio.');
  else if (c.nombre.length < 2) errores.push('El nombre es demasiado corto.');

  // WhatsApp: se normaliza al formato internacional sin "+"
  if (c.whatsapp) {
    const digitos = c.whatsapp.replace(/\D/g, '');
    const n = limpiarNumero(c.whatsapp, ctx.codigoPais);
    if (/[a-z]/i.test(c.whatsapp.replace(/^(\+|cel|wsp|whatsapp)/i, ''))) errores.push(`WhatsApp con letras: "${c.whatsapp}".`);
    else if (ctx.codigoPais === '51' && digitos.length === 9 && !digitos.startsWith('9')) errores.push(`"${c.whatsapp}" no es un celular de Perú (debe empezar con 9).`);
    else if (!n || n.length < 10 || n.length > 15) errores.push(`WhatsApp inválido: "${c.whatsapp}" (${digitos.length} dígitos).`);
    else if (ctx.codigoPais === '51' && n.startsWith('51') && n.length === 11 && !n.startsWith('519')) errores.push(`"${c.whatsapp}" no es un celular de Perú (debe empezar con 9).`);
    else c.whatsapp = n;
  }
  if (c.telefono) {
    const dig = c.telefono.replace(/\D/g, '');
    if (dig.length < 6 || dig.length > 15) avisos.push(`Teléfono "${c.telefono}" con ${dig.length} dígitos; revisa que esté completo.`);
    // Si no dieron WhatsApp y el teléfono es un celular, se usa como WhatsApp
    if (!c.whatsapp && !errores.length) {
      const n = limpiarNumero(c.telefono, ctx.codigoPais);
      if (n && ctx.codigoPais === '51' && /^519\d{8}$/.test(n)) { c.whatsapp = n; avisos.push('Se usó el teléfono como WhatsApp (es un celular).'); }
    }
  }
  if (c.email) {
    c.email = c.email.toLowerCase().replace(/^mailto:/, '');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(c.email)) errores.push(`Correo inválido: "${c.email}".`);
  }
  if (c.website) {
    let w = c.website;
    if (!/^https?:\/\//i.test(w)) w = `https://${w}`;
    try { const u = new URL(w); if (!u.hostname.includes('.')) throw 0; c.website = u.href.replace(/\/$/, ''); }
    catch { avisos.push(`Sitio web no válido ("${c.website}"); no se guardará.`); c.website = null; }
  }
  if (!c.whatsapp && !c.telefono && !c.email && !errores.length) avisos.push('Sin WhatsApp, teléfono ni correo: no podrás contactarlo desde el CRM.');

  // Ubigeo con nombres oficiales
  if (c.departamento) {
    const dep = UBI.dep.get(clave(c.departamento));
    if (!dep) avisos.push(`Departamento "${c.departamento}" no reconocido; se guarda tal cual.`);
    else {
      c.departamento = dep;
      if (c.provincia) {
        const prov = UBI.prov.get(`${clave(dep)}|${clave(c.provincia)}`);
        if (!prov) avisos.push(`La provincia "${c.provincia}" no pertenece a ${dep}.`);
        else {
          c.provincia = prov;
          if (c.distrito) {
            const dist = UBI.dist.get(`${clave(dep)}|${clave(prov)}|${clave(c.distrito)}`);
            if (!dist) avisos.push(`El distrito "${c.distrito}" no pertenece a ${prov}.`); else c.distrito = dist;
          }
        }
      }
    }
  } else if (c.provincia || c.distrito) avisos.push('Falta el departamento: la ubicación no se pudo comprobar.');

  // Etapa por nombre o clave
  if (d.etapa) {
    const e = ctx.etapas.get(clave(d.etapa));
    if (e) c.estado_crm = e; else avisos.push(`Etapa "${d.etapa}" no existe; se usará la etapa por defecto.`);
  }
  // Valor estimado (acepta 1,500.50 · 1500,50 · S/ 1500)
  if (d.valor_estimado) {
    let v = String(d.valor_estimado).replace(/[^\d.,-]/g, '');
    if (/,\d{1,2}$/.test(v) && !/\.\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.'); else v = v.replace(/,/g, '');
    const num = parseFloat(v);
    if (!Number.isFinite(num) || num < 0) errores.push(`Valor estimado inválido: "${d.valor_estimado}".`);
    else if (num > 9999999999) errores.push('Valor estimado demasiado grande.');
    else c.valor_estimado = Math.round(num * 100) / 100;
  }
  if (d.etiquetas) c.etiquetas = normalizarEtiquetas(d.etiquetas.replace(/;/g, ',')) || null;
  // Responsable por correo o nombre
  if (d.responsable) {
    const u = ctx.usuarios.get(clave(d.responsable));
    if (!u) avisos.push(`Responsable "${d.responsable}" no es un usuario activo; se asigna según lo elegido al importar.`);
    else if (!ctx.puedeAsignar && u !== ctx.usuarioId) avisos.push('No tienes permiso para asignar a otros vendedores; quedará a tu nombre.');
    else c.asignado_a = u;
  }
  return { c, errores, avisos };
}

// Claves para detectar duplicados
const claveNombre = c => (c.nombre ? `${clave(c.nombre)}|${clave(c.distrito || '')}` : null);

async function existentes(codigoPais) {
  const [rows] = await db.query('SELECT id, nombre, whatsapp, telefono_int, telefono, email, distrito FROM negocios');
  const porNumero = new Map(), porEmail = new Map(), porNombre = new Map();
  for (const n of rows) {
    for (const t of [n.whatsapp, n.telefono_int, n.telefono]) {
      const num = limpiarNumero(t, codigoPais);
      if (num && num.length >= 10 && !porNumero.has(num)) porNumero.set(num, n);
    }
    if (n.email) porEmail.set(String(n.email).toLowerCase().trim(), n);
    const k = claveNombre(n);
    if (k && !porNombre.has(k)) porNombre.set(k, n);
  }
  return { porNumero, porEmail, porNombre };
}

// ── Análisis (no guarda nada) ──────────────────────────────────────────────
const sesiones = new Map(); // token → { usuarioId, expira, filas, archivo }
setInterval(() => { const ahora = Date.now(); for (const [t, s] of sesiones) if (s.expira < ahora) sesiones.delete(t); }, 5 * 60e3).unref();

async function analizar(buffer, { usuario, archivo }) {
  const { filas, columnas, desconocidas } = await leerFilas(buffer);
  const codigoPais = (await config.get('empresa_codigo_pais')) || '51';
  const [ets] = await db.query('SELECT clave, nombre FROM etapas ORDER BY orden');
  const [us] = await db.query('SELECT id, nombre, email FROM usuarios WHERE activo = 1');
  const ctx = {
    codigoPais,
    etapas: new Map(ets.flatMap(e => [[clave(e.nombre), e.clave], [clave(e.clave), e.clave]])),
    usuarios: new Map(us.flatMap(u => [[clave(u.email), u.id], [clave(u.nombre), u.id]])),
    puedeAsignar: usuario.can('contactos.asignar'), usuarioId: usuario.id,
  };
  const bd = await existentes(codigoPais);
  const vistos = { numero: new Map(), email: new Map(), nombre: new Map() };

  const res = filas.map(({ fila, datos }) => {
    const { c, errores, avisos } = validarFila(datos, ctx);
    const r = { fila, datos: c, errores, avisos, estado: errores.length ? 'error' : 'nuevo' };
    if (errores.length) return r;

    // Duplicado dentro del mismo archivo
    const kNum = c.whatsapp, kMail = c.email, kNom = claveNombre(c);
    const previa = (kNum && vistos.numero.get(kNum)) || (kMail && vistos.email.get(kMail)) || (kNom && vistos.nombre.get(kNom));
    if (previa) {
      r.estado = 'repetido';
      r.motivo = `Repite la fila ${previa} del archivo (${kNum && vistos.numero.get(kNum) ? 'mismo WhatsApp' : kMail && vistos.email.get(kMail) ? 'mismo correo' : 'mismo nombre y distrito'}).`;
      return r;
    }
    if (kNum) vistos.numero.set(kNum, fila);
    if (kMail) vistos.email.set(kMail, fila);
    if (kNom) vistos.nombre.set(kNom, fila);

    // Duplicado contra el CRM
    let ex = null, por = '';
    if (kNum && bd.porNumero.has(kNum)) { ex = bd.porNumero.get(kNum); por = 'mismo WhatsApp'; }
    else if (kMail && bd.porEmail.has(kMail)) { ex = bd.porEmail.get(kMail); por = 'mismo correo'; }
    else if (kNom && bd.porNombre.has(kNom)) { ex = bd.porNombre.get(kNom); por = 'mismo nombre y distrito'; }
    if (ex) { r.estado = 'duplicado'; r.existente = { id: ex.id, nombre: ex.nombre }; r.motivo = `Ya existe en el CRM: "${ex.nombre}" (${por}).`; }
    return r;
  });

  const cuenta = e => res.filter(r => r.estado === e).length;
  const resumen = {
    total: res.length, nuevos: cuenta('nuevo'), duplicados: cuenta('duplicado'), repetidos: cuenta('repetido'), errores: cuenta('error'),
    con_avisos: res.filter(r => r.avisos.length && r.estado !== 'error').length,
    columnas, desconocidas,
  };
  const token = crypto.randomBytes(18).toString('hex');
  sesiones.set(token, { usuarioId: usuario.id, expira: Date.now() + 30 * 60e3, filas: res, archivo });
  return { token, resumen, filas: res };
}

function sesion(token, usuario) {
  const s = sesiones.get(String(token || ''));
  if (!s || s.usuarioId !== usuario.id || s.expira < Date.now())
    throw new HttpError(410, 'La revisión expiró (30 min). Vuelve a subir el archivo.');
  return s;
}

// Excel con las filas que no se importarán y el motivo, para corregirlas y volver a subirlas
async function excelPendientes(token, usuario) {
  const s = sesion(token, usuario);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contactos');
  ws.columns = [...COLUMNAS.map(c => ({ header: c.t, key: c.k, width: c.w })), { header: 'Fila original', key: '_fila', width: 12 }, { header: 'Motivo', key: '_motivo', width: 60 }];
  ws.getRow(1).font = { bold: true };
  for (const r of s.filas.filter(x => x.estado !== 'nuevo')) {
    ws.addRow({ ...r.datos, etapa: r.datos.estado_crm || '', _fila: r.fila, _motivo: [...r.errores, r.motivo].filter(Boolean).join(' ') });
  }
  return wb.xlsx.writeBuffer();
}

// ── Importación (bulk) ─────────────────────────────────────────────────────
// Todo va en una transacción y por lotes: INSERT multi-fila para los nuevos, una sola consulta
// para leer/bloquear los duplicados y INSERT … ON DUPLICATE KEY UPDATE para completarlos.
const LOTE = 500;
const COLS_NUEVO = ['nombre', 'contacto_nombre', 'whatsapp', 'telefono', 'email', 'website', 'direccion', 'departamento', 'provincia',
  'distrito', 'rubro_busqueda', 'descripcion', 'valor_estimado', 'etiquetas', 'estado_crm', 'asignado_a', 'place_id', 'origen'];
// Campos que se completan en un contacto existente (solo si están vacíos)
const COLS_COMPLETAR = ['contacto_nombre', 'whatsapp', 'telefono', 'email', 'website', 'direccion', 'departamento', 'provincia',
  'distrito', 'rubro_busqueda', 'descripcion', 'valor_estimado', 'etiquetas'];
const trozos = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function historial(conn, filas) {
  for (const t of trozos(filas, LOTE)) {
    await conn.query('INSERT INTO crm_historial (negocio_id, tipo, contenido, usuario, usuario_id) VALUES ?', [t]);
  }
}

// Escribe en la BD usando la conexión dada (la transacción la maneja quien llama)
async function guardar(conn, filas, usuario, { etapaDef, asignadoDef, etiquetaLote, actualizar, archivo }) {
  const unirEtiquetas = (...xs) => normalizarEtiquetas(xs.filter(Boolean).join(',')) || null;
  const nota = `Importado desde Excel${archivo ? ` (${archivo})` : ''} por ${usuario.nombre}`;

  // 1) Nuevos: INSERT de 500 filas por consulta
  const nuevos = filas.filter(r => r.estado === 'nuevo').map(r => {
    const c = r.datos;
    const fila = {
      ...c, place_id: `import:${crypto.randomUUID()}`, origen: 'importacion',
      estado_crm: c.estado_crm || etapaDef,
      asignado_a: c.asignado_a !== undefined ? c.asignado_a : asignadoDef,
      etiquetas: unirEtiquetas(c.etiquetas, etiquetaLote),
    };
    return COLS_NUEVO.map(k => (fila[k] === undefined ? null : fila[k]));
  });
  const iPlace = COLS_NUEVO.indexOf('place_id');
  for (const t of trozos(nuevos, LOTE)) {
    await conn.query(`INSERT INTO negocios (${COLS_NUEVO.join(', ')}) VALUES ?`, [t]);
    // Los IDs se recuperan por place_id (con innodb_autoinc_lock_mode=2 no siempre son consecutivos)
    const [ids] = await conn.query('SELECT id FROM negocios WHERE place_id IN (?)', [t.map(f => f[iPlace])]);
    await historial(conn, ids.map(x => [x.id, 'sistema', nota, usuario.nombre, usuario.id]));
  }

  // 2) Duplicados a completar: se leen y bloquean de una vez, se calcula el resultado y se escribe por lotes
  let actualizados = 0;
  const dups = actualizar ? filas.filter(r => r.estado === 'duplicado') : [];
  if (dups.length) {
    const existentes = new Map();
    for (const t of trozos([...new Set(dups.map(r => r.existente.id))], LOTE)) {
      const [rows] = await conn.query(`SELECT id, place_id, ${COLS_COMPLETAR.join(', ')} FROM negocios WHERE id IN (?) FOR UPDATE`, [t]);
      rows.forEach(x => existentes.set(x.id, x));
    }
    const cambios = [], notas = [];
    for (const r of dups) {
      const ex = existentes.get(r.existente.id);
      if (!ex) continue;
      const nuevo = { ...ex }, campos = [];
      for (const k of COLS_COMPLETAR) {
        if (k === 'etiquetas') continue;
        if ((ex[k] === null || ex[k] === '') && r.datos[k] !== undefined && r.datos[k] !== null) { nuevo[k] = r.datos[k]; campos.push(k); }
      }
      const et = unirEtiquetas(ex.etiquetas, r.datos.etiquetas, etiquetaLote);
      if (et !== (ex.etiquetas || null)) { nuevo.etiquetas = et; campos.push('etiquetas'); }
      if (!campos.length) continue;
      existentes.set(ex.id, nuevo); // si el archivo trae dos filas para el mismo contacto, la segunda parte de lo ya completado
      cambios.push(nuevo);
      notas.push([ex.id, 'sistema', `Datos completados desde Excel: ${campos.join(', ')}`, usuario.nombre, usuario.id]);
    }
    // Un mismo contacto puede aparecer varias veces: se escribe su versión final una sola vez
    const finales = [...new Map(cambios.map(c => [c.id, c])).values()];
    const cols = ['id', 'place_id', ...COLS_COMPLETAR];
    for (const t of trozos(finales, LOTE)) {
      // Las filas ya existen (bloqueadas con FOR UPDATE): siempre entra por ON DUPLICATE KEY UPDATE
      await conn.query(`INSERT INTO negocios (${cols.join(', ')}) VALUES ? AS nv
        ON DUPLICATE KEY UPDATE ${COLS_COMPLETAR.map(k => `${k} = nv.${k}`).join(', ')}`,
        [t.map(c => cols.map(k => (c[k] === undefined ? null : c[k])))]);
    }
    await historial(conn, notas);
    actualizados = finales.length;
  }
  return { creados: nuevos.length, actualizados, omitidos: filas.length - nuevos.length - actualizados };
}

// opciones: { duplicados: 'omitir'|'actualizar', etapa, asignado_a, etiqueta }
async function importar(token, usuario, opciones = {}) {
  const s = sesion(token, usuario);
  const [[primera]] = await db.query('SELECT clave FROM etapas ORDER BY orden LIMIT 1');
  let etapaDef = primera?.clave || 'nuevo';
  if (opciones.etapa) { const [[e]] = await db.query('SELECT clave FROM etapas WHERE clave = ?', [opciones.etapa]); if (e) etapaDef = e.clave; }
  let asignadoDef = usuario.id;
  if (usuario.can('contactos.asignar') && opciones.asignado_a !== undefined) {
    if (opciones.asignado_a === '' || opciones.asignado_a === null) asignadoDef = null;
    else { const [[u]] = await db.query('SELECT id FROM usuarios WHERE id = ? AND activo = 1', [parseInt(opciones.asignado_a, 10) || 0]); if (u) asignadoDef = u.id; }
  }
  // Evita que dos clics o dos pestañas importen el mismo archivo dos veces
  if (s.importando) throw new HttpError(409, 'Esta importación ya se está procesando.');
  s.importando = true;

  const t0 = Date.now();
  const conn = await db.getConnection();
  let r;
  try {
    await conn.beginTransaction();
    r = await guardar(conn, s.filas, usuario, {
      etapaDef, asignadoDef, archivo: s.archivo,
      etiquetaLote: normalizarEtiquetas(opciones.etiqueta || ''),
      actualizar: opciones.duplicados === 'actualizar' && usuario.can('contactos.editar'),
    });
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    s.importando = false;
    throw e;
  } finally { conn.release(); }
  sesiones.delete(token);
  return { ...r, archivo: s.archivo, segundos: Math.round((Date.now() - t0) / 100) / 10 };
}

module.exports = { plantilla, analizar, importar, excelPendientes, guardar, MAX_FILAS, COLUMNAS };
