// Suscripciones SaaS: registro manual para trazabilidad. No hay nada automático
// (ni cobros generados, ni cambios de estado, ni avisos).
//
// Los PERIODOS se calculan al consultar: desde la fecha de inicio, un periodo por ciclo
// (mensual / trimestral / anual) hasta el periodo actual. Cada periodo muestra si tiene pagos
// registrados; el usuario registra el pago del periodo que corresponda.
const db = require('../db');

const MESES = { mensual: 1, trimestral: 3, anual: 12 };
const CICLOS = { mensual: 'Mensual', trimestral: 'Trimestral', anual: 'Anual' };

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const fechaLima = (dias = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(Date.now() + dias * 864e5));

// "YYYY-MM-DD" + n meses, respetando el día de la fecha base (31 ene + 1 → 28/29 feb, + 2 → 31 mar)
function sumarMeses(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + n;
  const anio = y + Math.floor(total / 12), mes = ((total % 12) + 12) % 12;
  const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  return `${anio}-${String(mes + 1).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}
function sumarDias(iso, n) {
  const x = new Date(`${iso}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

// Precio del plan para un ciclo: el precio propio del ciclo o el mensual × meses
function precioPlan(plan, ciclo) {
  const m = MESES[ciclo] || 1;
  if (ciclo === 'trimestral' && plan.precio_trimestral !== null && plan.precio_trimestral !== undefined) return r2(plan.precio_trimestral);
  if (ciclo === 'anual' && plan.precio_anual !== null && plan.precio_anual !== undefined) return r2(plan.precio_anual);
  return r2(Number(plan.precio_mensual) * m);
}

/**
 * Monto de referencia de un periodo (plan + integraciones activas − descuento).
 * Devuelve { lineas: [{concepto, monto}], total, mensual }
 */
function calcular(s, plan, ints = []) {
  const m = MESES[s.ciclo] || 1;
  const especial = s.precio_especial !== null && s.precio_especial !== undefined && s.precio_especial !== '';
  const base = especial ? r2(s.precio_especial) : precioPlan(plan, s.ciclo);
  const lineas = [{ concepto: `Plan ${plan.nombre} (${CICLOS[s.ciclo].toLowerCase()})`, monto: base }];
  for (const i of ints) lineas.push({ concepto: `${i.nombre}${m > 1 ? ` × ${m} meses` : ''}`, monto: r2(Number(i.precio_mensual) * m) });
  const bruto = r2(lineas.reduce((t, l) => t + l.monto, 0));
  const pct = Math.min(100, Math.max(0, Number(s.descuento_pct) || 0));
  const descuento = r2(bruto * pct / 100);
  if (descuento) lineas.push({ concepto: `Descuento ${pct} %`, monto: -descuento });
  const total = r2(bruto - descuento);
  return { lineas, total, mensual: r2(total / m) };
}

/**
 * Periodos por fecha desde el inicio hasta el periodo actual (+ el siguiente, para adelantos).
 * Una suscripción cancelada solo muestra periodos hasta su fecha de cancelación.
 * pagos: [{ periodo_inicio, monto }] → cada periodo indica cuánto se pagó.
 */
function periodos(s, pagos = [], monto = 0, { extra = 1, max = 120 } = {}) {
  const m = MESES[s.ciclo] || 1;
  const hoy = fechaLima();
  const tope = s.estado === 'cancelada' && s.cancelada_at ? s.cancelada_at : hoy;
  const pagadoPor = {};
  for (const p of pagos) pagadoPor[p.periodo_inicio] = r2((pagadoPor[p.periodo_inicio] || 0) + Number(p.monto));
  const out = [];
  let futuros = 0;
  for (let n = 0; n < max; n++) {
    const inicio = sumarMeses(s.fecha_inicio, n * m);
    if (inicio > tope) {
      if (s.estado !== 'activa' || futuros >= extra) break;
      futuros++;
    }
    const fin = sumarDias(sumarMeses(s.fecha_inicio, (n + 1) * m), -1);
    const pagado = pagadoPor[inicio] || 0;
    const estado = pagado <= 0 ? (inicio > hoy ? 'futuro' : 'sin_pago') : pagado + 0.009 >= monto ? 'pagado' : 'parcial';
    out.push({ numero: n + 1, inicio, fin, monto, pagado, estado });
  }
  // Pagos de periodos que no calzan con las fechas (p. ej. tras cambiar el ciclo) se listan aparte
  const fechas = new Set(out.map(p => p.inicio));
  const sueltos = Object.entries(pagadoPor).filter(([f]) => !fechas.has(f)).map(([f, v]) => ({ inicio: f, pagado: v }));
  return { periodos: out.reverse(), sueltos };
}

async function registrarHistorial(s, contenido, usuario = null) {
  await db.query('INSERT INTO crm_historial (negocio_id, suscripcion_id, tipo, contenido, usuario, usuario_id) VALUES (?,?,?,?,?,?)',
    [s.negocio_id, s.id, 'suscripcion', `${s.codigo} · ${contenido}`, usuario?.nombre || 'Sistema', usuario?.id || null]);
}

module.exports = { MESES, CICLOS, r2, fechaLima, sumarMeses, sumarDias, precioPlan, calcular, periodos, registrarHistorial };
