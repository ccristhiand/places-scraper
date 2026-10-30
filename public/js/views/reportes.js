import { html, raw, icon, api, render as dibujar, acciones, fmt, toastError, $, cargando, vacio, avatar } from '../core.js';
import { barras, hbarras } from '../ui.js';
import { TIPOS, dinero } from '../proyecto.js';

const hoyISO = () => new Date().toISOString().slice(0, 10);
const haceISO = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

export async function render(el) {
  dibujar(el, html`
    <div class="page-head"><div><h1>Reportes</h1><p>Rendimiento comercial, campañas y equipo.</p></div>
      <div class="actions row wrap">
        <div class="seg">${[[7, '7 días'], [30, '30 días'], [90, '90 días']].map(([d, t]) => html`<button data-act="rango" data-d="${d}" class="${d === 30 ? 'active' : ''}">${t}</button>`)}</div>
        <input class="input sm" type="date" data-desde value="${haceISO(29)}" style="width:150px" aria-label="Desde">
        <input class="input sm" type="date" data-hasta value="${hoyISO()}" style="width:150px" aria-label="Hasta">
      </div></div>
    <div data-cont>${cargando()}</div>`);
  const cargarR = () => cargar(el);
  $('[data-desde]', el).addEventListener('change', cargarR);
  $('[data-hasta]', el).addEventListener('change', cargarR);
  acciones(el, {
    rango: b => {
      el.querySelectorAll('[data-act=rango]').forEach(x => x.classList.toggle('active', x === b));
      $('[data-desde]', el).value = haceISO(+b.dataset.d - 1); $('[data-hasta]', el).value = hoyISO(); cargar(el);
    },
  });
  await cargar(el);
}

async function cargar(el) {
  const cont = $('[data-cont]', el);
  try {
    const r = await api.get('/api/reportes', { desde: $('[data-desde]', el).value, hasta: $('[data-hasta]', el).value });
    const tot = r.envios.reduce((a, d) => ({ e: a.e + +d.enviados, en: a.en + +d.entregados, l: a.l + +d.leidos }), { e: 0, en: 0, l: 0 });
    const resp = r.campanas.reduce((s, c) => s + Number(c.respondieron || 0), 0);
    const totalContactos = r.etapas.reduce((s, e) => s + e.total, 0);
    const ganados = r.etapas.filter(e => e.tipo === 'ganada').reduce((s, e) => s + e.total, 0);
    const k = (ic, tone, label, val, sub) => html`<div class="card kpi"><div class="kpi-icon ${tone}">${icon(ic)}</div><div><div class="kpi-label">${label}</div><div class="kpi-value">${val}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div></div>`;

    dibujar(cont, html`
      <div class="grid c4 mb">
        ${k('send', 'tone-primary', 'Mensajes de campaña', fmt.num(tot.e), 'en el período')}
        ${k('check', 'tone-info', 'Tasa de entrega', fmt.pct(tot.en, tot.e), `${fmt.num(tot.en)} entregados`)}
        ${k('eye', 'tone-success', 'Tasa de lectura', fmt.pct(tot.l, tot.e), `${fmt.num(tot.l)} leídos`)}
        ${k('trophy', 'tone-warning', 'Conversión total', fmt.pct(ganados, totalContactos), `${fmt.num(ganados)} ganados de ${fmt.num(totalContactos)}`)}
      </div>
      <div class="grid side mb">
        <div class="card"><div class="card-head"><h3>Envíos por día</h3></div><div class="card-body">
          ${r.envios.length ? barras(r.envios.map(d => ({ etiqueta: new Date(d.dia).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
            leidos: +d.leidos, entregados: +d.entregados - +d.leidos, enviados: +d.enviados - +d.entregados })),
            [{ clave: 'leidos', nombre: 'Leídos', color: '#2459c6' }, { clave: 'entregados', nombre: 'Entregados', color: '#8fa9e3' }, { clave: 'enviados', nombre: 'Solo enviados', color: '#d4d4d8' }])
            : vacio({ icono: 'chart', titulo: 'Sin envíos en el período' })}</div></div>
        <div class="card"><div class="card-head"><h3>Pipeline actual</h3></div><div class="card-body">${hbarras(r.etapas)}</div></div>
      </div>
      <div class="card mb"><div class="card-head"><h3>Campañas</h3><span class="small muted">${fmt.num(resp)} contactos respondieron</span></div>
        <div class="table-wrap">${r.campanas.length ? html`<table class="table"><thead><tr><th>Campaña</th><th>Enviados</th><th>Entregados</th><th>Leídos</th><th>Respondieron</th><th>Fallidos</th></tr></thead><tbody>
          ${r.campanas.map(c => html`<tr><td class="strong">${c.nombre}</td><td>${fmt.num(c.enviados)}</td>
            <td>${fmt.num(c.entregados)} <span class="xs muted">${fmt.pct(c.entregados, c.enviados)}</span></td>
            <td>${fmt.num(c.leidos)} <span class="xs muted">${fmt.pct(c.leidos, c.enviados)}</span></td>
            <td><b>${fmt.num(c.respondieron)}</b> <span class="xs muted">${fmt.pct(c.respondieron, c.enviados)}</span></td>
            <td>${Number(c.fallidos) ? html`<span class="badge danger">${fmt.num(c.fallidos)}</span>` : '0'}</td></tr>`)}</tbody></table>`
          : vacio({ icono: 'megaphone', titulo: 'Sin campañas en el período' })}</div></div>
      <div class="card mb"><div class="card-head"><h3>Equipo comercial</h3></div><div class="table-wrap"><table class="table">
        <thead><tr><th>Vendedor</th><th>Contactos</th><th>Ganados</th><th>Valor ganado</th><th>Actividades</th><th>Mensajes</th><th>Tareas hechas</th></tr></thead><tbody>
        ${r.vendedores.map(v => html`<tr><td><div class="row">${avatar(v.nombre, 'sm')}<b>${v.nombre}</b></div></td><td>${fmt.num(v.contactos)}</td>
          <td>${fmt.num(v.ganados)} <span class="xs muted">${fmt.pct(v.ganados, v.contactos)}</span></td><td>${fmt.moneda(v.valor_ganado)}</td>
          <td>${fmt.num(v.actividades)}</td><td>${fmt.num(v.mensajes)}</td><td>${fmt.num(v.tareas)}</td></tr>`)}</tbody></table></div></div>
      <div class="grid c3">
        <div class="card"><div class="card-head"><h3>Rubros con más contactos</h3></div><div class="card-body">${hbarras(r.rubros, { color: 'var(--text-2)' })}</div></div>
        <div class="card"><div class="card-head"><h3>Distritos con más contactos</h3></div><div class="card-body">${hbarras(r.distritos, { color: 'var(--text-2)' })}</div></div>
        <div class="card"><div class="card-head"><h3>Origen de contactos</h3></div><div class="card-body">${hbarras(r.origenes, { color: 'var(--text-2)' })}</div></div>
      </div>
      ${r.proyectos ? reporteProyectos(r.proyectos) : ''}`);
  } catch (e) { toastError(e); }
}

// ── Proyectos: cobros por mes, facturación por tipo, clientes y rentabilidad ──
function reporteProyectos(p) {
  const monedas = [...new Set(p.cobros_por_mes.map(c => c.moneda))];
  const meses = [];
  for (let i = 11; i >= 0; i--) { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() - i); meses.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); }
  const colores = { PEN: '#2459c6', USD: '#17803d' };
  const datos = meses.map(m => ({
    etiqueta: new Date(`${m}-15T12:00:00`).toLocaleDateString('es-PE', { month: 'short' }).replace('.', ''),
    ...Object.fromEntries(monedas.map(mo => [mo, Number(p.cobros_por_mes.find(c => c.mes === m && c.moneda === mo)?.total || 0)])),
  }));
  const conv = p.conversion || {};
  return html`
    <h2 class="mt mb" style="margin-top:28px">Proyectos</h2>
    <div class="grid side mb">
      <div class="card"><div class="card-head"><h3>Cobrado por mes · 12 meses</h3></div><div class="card-body">
        ${monedas.length ? barras(datos, monedas.map(m => ({ clave: m, nombre: m === 'PEN' ? 'Soles' : 'Dólares', color: colores[m] || '#71717a' })))
          : vacio({ icono: 'dollar', titulo: 'Aún no hay cobros registrados' })}</div></div>
      <div class="card"><div class="card-head"><h3>Por tipo de proyecto</h3></div><div class="card-body">
        ${p.por_tipo.length ? p.por_tipo.map(t => html`<div class="row between small" style="padding:5px 0;border-bottom:1px solid var(--border)">
          <span>${TIPOS[t.tipo] || t.tipo} <span class="muted">· ${t.proyectos}</span></span><b>${dinero(t.total, t.moneda)}</b></div>`) : html`<p class="small muted">Sin proyectos aprobados.</p>`}
        ${Number(conv.total) ? html`<div class="xs muted mt">Propuestas del período: ${conv.total} · ganadas ${conv.ganadas || 0} · perdidas ${conv.perdidas || 0} (${fmt.pct(conv.ganadas, conv.total)} de cierre)</div>` : ''}
      </div></div>
    </div>
    <div class="grid c2">
      <div class="card"><div class="card-head"><h3>Clientes que más compran</h3></div><div class="table-wrap"><table class="table">
        <thead><tr><th>Cliente</th><th>Proyectos</th><th>Total</th><th>Saldo</th></tr></thead><tbody>
        ${p.clientes.map(c => html`<tr><td class="strong small">${c.nombre}</td><td class="small">${c.proyectos}</td><td class="small num">${dinero(c.total, c.moneda)}</td>
          <td class="small num" style="${Number(c.saldo) > 0 ? 'color:var(--warning)' : ''}">${dinero(c.saldo, c.moneda)}</td></tr>`)}
        ${p.clientes.length ? '' : html`<tr><td colspan="4" class="muted small center">Sin datos</td></tr>`}</tbody></table></div></div>
      <div class="card"><div class="card-head"><h3>Rentabilidad por proyecto</h3><span class="xs muted">con horas registradas</span></div><div class="table-wrap"><table class="table">
        <thead><tr><th>Proyecto</th><th>Horas</th><th>Ingreso</th><th>Costo</th><th>Margen</th></tr></thead><tbody>
        ${p.rentabilidad.map(x => html`<tr><td class="small"><b>${x.nombre}</b><div class="xs muted mono">${x.codigo}</div></td>
          <td class="small num">${Number(x.horas)}${x.horas_estimadas ? html`<span class="xs muted"> / ${Number(x.horas_estimadas)}</span>` : ''}</td>
          <td class="small num">${dinero(x.ingreso, x.moneda)}</td><td class="small num">${dinero(x.costo, x.moneda)}</td>
          <td class="small num" style="color:${raw(x.margen_pct !== null && x.margen_pct < 20 ? 'var(--danger)' : 'var(--success)')}">${x.margen_pct !== null ? `${x.margen_pct} %` : '—'}</td></tr>`)}
        ${p.rentabilidad.length ? '' : html`<tr><td colspan="5" class="muted small center">Registra horas en los proyectos para ver su rentabilidad.</td></tr>`}</tbody></table></div></div>
    </div>`;
}
