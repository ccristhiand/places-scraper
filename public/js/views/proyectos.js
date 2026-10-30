import { html, raw, icon, api, render as dibujar, acciones, can, vacio, toastError, $, $$, cargando, opciones, usuarios, debounce } from '../core.js';
import { TIPOS, ESTADOS, dinero, fechaCorta, estadoBadge, formProyecto, abrirProyecto } from '../proyecto.js';

let st;
const COLUMNAS = ['propuesta', 'aprobado', 'desarrollo', 'pruebas', 'soporte'];

export async function render(el, params) {
  st = { f: { estado: '' }, vista: localStorage.getItem('proyectos_vista') || 'tabla', rows: [] };
  const us = can('contactos.ver_todos') ? await usuarios() : [];
  dibujar(el, html`
    <div class="page-head"><div><h1>Proyectos</h1><p>Desarrollos por cliente: monto, tiempos, cobros y soporte.</p></div>
      <div class="actions"><div class="seg"><button data-act="vista" data-v="tabla">${icon('list', 'sm')} Tabla</button><button data-act="vista" data-v="tablero">${icon('kanban', 'sm')} Tablero</button></div>
      ${can('proyectos.gestionar') ? html`<button class="btn btn-primary" data-act="nuevo">${icon('plus', 'sm')} Nuevo proyecto</button>` : ''}</div></div>
    <div class="grid c4 mb" data-kpis></div>
    <div class="toolbar">
      <div class="search">${icon('search', 'sm')}<input class="input" data-q placeholder="Buscar por proyecto, código o cliente…"></div>
      <select class="select" data-f="estado">${opciones([['activos', 'En curso'], ...Object.entries(ESTADOS).map(([k, v]) => [k, v[1]])], '', { vacio: 'Todos los estados' })}</select>
      <select class="select" data-f="tipo">${opciones(Object.entries(TIPOS), '', { vacio: 'Todos los tipos' })}</select>
      ${us.length ? html`<select class="select" data-f="responsable">${opciones([['yo', 'Mis proyectos'], ...us.map(u => [u.id, u.nombre])], '', { vacio: 'Todos los responsables' })}</select>` : ''}
    </div>
    <div data-lista>${cargando()}</div>`);

  $('[data-q]', el).addEventListener('input', debounce(e => { st.f.q = e.target.value; cargar(el); }, 300));
  el.addEventListener('change', e => { if (e.target.dataset.f) { st.f[e.target.dataset.f] = e.target.value; st.filtroLocal = null; cargar(el); } });
  const nuevo = () => formProyecto(null, { onGuardado: id => { cargar(el); abrirProyecto(id, { onCambio: () => cargar(el) }); } });
  acciones(el, {
    nuevo,
    abrir: b => abrirProyecto(b.dataset.id, { onCambio: () => cargar(el) }),
    vista: b => { st.vista = b.dataset.v; try { localStorage.setItem('proyectos_vista', st.vista); } catch { /* sin storage */ } pintar(el); },
    kpi: b => { st.f.estado = b.dataset.estado || ''; $('[data-f="estado"]', el).value = st.f.estado; st.filtroLocal = b.dataset.local || null; cargar(el); },
  });
  await cargar(el);
  if (params[0] === 'nuevo' && can('proyectos.gestionar')) nuevo();
  else if (params[0]) abrirProyecto(params[0], { onCambio: () => cargar(el) });
}

async function cargar(el) {
  try {
    const r = await api.get('/api/proyectos', st.f);
    st.rows = st.filtroLocal === 'atrasados' ? r.rows.filter(p => p.atrasado)
      : st.filtroLocal === 'soporte_vence' ? r.rows.filter(p => p.estado === 'soporte' && p.dias_soporte_restantes <= 7)
      : st.filtroLocal === 'por_cobrar' ? r.rows.filter(p => p.saldo > 0 && !['propuesta', 'cancelado'].includes(p.estado)) : r.rows;
    const k = r.resumen;
    const porCobrar = k.por_cobrar ? Object.entries(k.por_cobrar).map(([m, v]) => dinero(v, m)).join(' + ') || dinero(0) : null;
    const kpi = (label, valor, sub, data, tono = '') => html`<a href="#" class="card kpi" data-act="kpi" ${raw(data)} style="color:inherit;text-decoration:none">
      <div><div class="kpi-label">${label}</div><div class="kpi-value" style="${tono}">${valor}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div></a>`;
    dibujar($('[data-kpis]', el), html`
      ${kpi('En curso', k.activos, 'Aprobados, en desarrollo o en pruebas', 'data-estado="activos"')}
      ${porCobrar !== null ? kpi('Por cobrar', porCobrar, k.cuotas_vencidas ? `${k.cuotas_vencidas} cuota(s) vencida(s)` : 'Sin cuotas vencidas', 'data-local="por_cobrar"', k.cuotas_vencidas ? 'color:var(--warning)' : '') : kpi('En soporte', k.en_soporte, null, 'data-estado="soporte"')}
      ${kpi('Atrasados', k.atrasados, 'Pasaron su fecha de entrega', 'data-local="atrasados"', k.atrasados ? 'color:var(--danger)' : '')}
      ${kpi('Soporte por vencer', k.soporte_por_vencer, 'En los próximos 7 días', 'data-local="soporte_vence"')}`);
    pintar(el);
  } catch (e) { toastError(e); }
}

function pintar(el) {
  $$('[data-act="vista"]', el).forEach(b => b.classList.toggle('active', b.dataset.v === st.vista));
  const lista = $('[data-lista]', el);
  const montos = can('proyectos.montos');
  if (!st.rows.length) {
    dibujar(lista, html`<div class="card">${vacio({ icono: 'layers', titulo: 'Sin proyectos', texto: 'Registra los desarrollos que vendes a cada cliente para controlar entregas, cobros y soporte.',
      accion: can('proyectos.gestionar') ? html`<button class="btn btn-primary" data-act="nuevo">${icon('plus', 'sm')} Nuevo proyecto</button>` : '' })}</div>`);
    return;
  }
  if (st.vista === 'tablero') {
    dibujar(lista, html`<div class="kanban">${COLUMNAS.map(est => {
      const items = st.rows.filter(p => p.estado === est);
      return html`<div class="kcol"><div class="kcol-head"><div class="row between"><span>${ESTADOS[est][1]} <span class="muted small">${items.length}</span></span></div></div>
        <div class="kcol-body">${items.map(p => html`<div class="kcard" data-act="abrir" data-id="${p.id}" style="cursor:pointer">
          <div class="xs muted mono">${p.codigo}</div><div class="kcard-title">${p.nombre}</div><div class="small muted truncate">${p.cliente}</div>
          ${montos ? html`<div class="small strong" style="margin-top:4px">${dinero(p.monto, p.moneda)}${p.saldo > 0 ? html` <span class="xs muted">· saldo ${dinero(p.saldo, p.moneda)}</span>` : ''}</div>` : ''}
          ${p.avance !== null ? html`<div class="progress" style="margin-top:6px" title="Avance ${p.avance} %"><div style="width:${raw(p.avance)}%"></div></div>` : ''}
          <div class="kcard-meta" style="margin-top:6px">${entregaInfo(p)}${p.tickets_abiertos ? html`<span style="color:var(--danger)">${icon('alert', 'sm')} ${p.tickets_abiertos}</span>` : ''}</div></div>`)}</div></div>`;
    })}</div>`);
    return;
  }
  dibujar(lista, html`<div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>Proyecto</th><th>Cliente</th><th>Estado</th><th style="min-width:110px">Avance</th><th>Entrega</th><th>Soporte</th>${montos ? html`<th>Monto</th><th style="min-width:130px">Cobrado</th>` : ''}<th class="hide-mobile">Responsable</th></tr></thead><tbody>
    ${st.rows.map(p => html`<tr class="clickable" data-act="abrir" data-id="${p.id}">
      <td><div class="strong">${p.nombre}</div><div class="xs muted"><span class="mono">${p.codigo}</span> · ${TIPOS[p.tipo] || p.tipo}
        ${p.tickets_abiertos ? html` <span class="badge danger">${p.tickets_abiertos} incidencia(s)</span>` : ''}</div></td>
      <td class="small">${p.cliente}</td>
      <td>${estadoBadge(p.estado)}</td>
      <td>${p.avance !== null ? html`<div class="xs num">${p.avance} %</div><div class="progress" style="margin-top:4px"><div style="width:${raw(p.avance)}%"></div></div>` : html`<span class="xs muted">Sin hitos</span>`}</td>
      <td class="small nowrap">${entregaInfo(p)}</td>
      <td class="small nowrap">${soporteInfo(p)}</td>
      ${montos ? html`<td class="small num nowrap">${dinero(p.monto, p.moneda)}</td>
        <td><div class="xs num">${dinero(p.pagado, p.moneda)}${p.cuotas_vencidas ? html` <span class="badge danger">vencida</span>` : ''}</div>
          <div class="progress" style="margin-top:4px"><div style="width:${raw(p.monto ? Math.min(100, (p.pagado / p.monto) * 100) : 0)}%;background:var(--success)"></div></div></td>` : ''}
      <td class="small hide-mobile">${p.responsable_nombre || '—'}</td></tr>`)}
  </tbody></table></div></div>`);
}

function entregaInfo(p) {
  if (p.fecha_entrega_real) return html`<span class="muted">Entregado ${fechaCorta(p.fecha_entrega_real)}</span>`;
  if (!p.fecha_entrega_estimada) return html`<span class="muted">Sin fecha</span>`;
  if (p.atrasado) return html`<span style="color:var(--danger)">${icon('alert', 'sm')} ${fechaCorta(p.fecha_entrega_estimada)} · ${-p.dias_para_entrega} d tarde</span>`;
  const enCurso = ['aprobado', 'desarrollo', 'pruebas'].includes(p.estado);
  return html`${icon('calendar', 'sm')} ${fechaCorta(p.fecha_entrega_estimada)}${enCurso && p.dias_para_entrega !== null ? html` <span class="muted">· ${p.dias_para_entrega} d</span>` : ''}`;
}

function soporteInfo(p) {
  if (p.estado === 'soporte' && p.dias_soporte_restantes !== null) {
    const d = p.dias_soporte_restantes;
    return html`<span style="${d <= 7 ? 'color:var(--warning)' : ''}">${d >= 0 ? `${d} d restantes` : 'Vencido'}</span><div class="xs muted">hasta ${fechaCorta(p.fecha_fin_soporte)}</div>`;
  }
  if (p.fecha_fin_soporte) return html`<span class="muted">Hasta ${fechaCorta(p.fecha_fin_soporte)}</span>`;
  return html`<span class="muted">${p.dias_soporte} días</span>`;
}
