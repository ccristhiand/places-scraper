class HttpError extends Error {
  constructor(status, message, codigo) {
    super(message);
    this.status = status;
    this.codigo = codigo;
  }
}

// Envuelve handlers async para que los errores lleguen al error handler central
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function limpiarNumero(tel, codigoPais = '51') {
  if (!tel) return null;
  let n = String(tel).replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.length < 8) return null;
  if (n.startsWith(codigoPais) && n.length > 9) return n;
  if (codigoPais === '51' && n.length === 9 && n.startsWith('9')) return '51' + n;
  return n;
}

// Variables disponibles en mensajes y parámetros de plantillas
const VARIABLES = {
  nombre:       'Nombre del negocio',
  contacto:     'Nombre de la persona de contacto',
  telefono:     'Teléfono',
  distrito:     'Distrito',
  provincia:    'Provincia',
  departamento: 'Departamento',
  rubro:        'Rubro',
  responsable:  'Vendedor asignado',
};

function valorVariable(clave, negocio) {
  const mapa = {
    nombre:       negocio.nombre,
    contacto:     negocio.contacto_nombre || negocio.nombre,
    telefono:     negocio.telefono,
    distrito:     negocio.distrito,
    provincia:    negocio.provincia,
    departamento: negocio.departamento,
    rubro:        negocio.rubro_busqueda,
    responsable:  negocio.asignado_nombre || negocio.responsable,
  };
  return mapa[clave] ?? '';
}

function procesarVariables(texto, negocio) {
  return String(texto || '').replace(/{{\s*(\w+)\s*}}/g, (m, clave) => {
    const k = clave.toLowerCase();
    return k in VARIABLES ? (valorVariable(k, negocio) || '') : m;
  });
}

function entero(v, def, min = -Infinity, max = Infinity) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// Texto recortado y sin espacios extremos; null si queda vacío
function texto(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function normalizarEtiquetas(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map(e => String(e).trim().toLowerCase()).filter(Boolean))].slice(0, 20).join(',');
}

module.exports = {
  HttpError, ah, limpiarNumero, VARIABLES, valorVariable, procesarVariables,
  entero, texto, normalizarEtiquetas,
};
