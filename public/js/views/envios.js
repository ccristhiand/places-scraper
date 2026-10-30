// Historial de mensajes de campañas + estado del procesador
import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toastError, $, cargando, bus, opciones, debounce } from '../core.js';
import { pager } from '../ui.js';

let subs = [], st;
export function destroy() { subs.forEach(f => f()); subs = []; }

const LIM = 30;
const ESTADO = { pendiente: ['warning', 'En cola'], procesando: ['warning', 'Enviando'], enviado: ['info', 'Enviado'], entregado: ['primary', 'Entregado'], leido: ['success', 'Leído'], fallido: ['danger', 'Fallido'], cancelado: ['', 'Cancelado'] };

export async function render(el, params) {
  if (params[0] === 'nuevo') { location.hash = '#/campanas/nueva'; return; }
  st = { f: {}, offset: 0 };
  dibujar(el, html`
    <div class="page-head"><div><h1>Envíos</h1><p>Estado de las campañas en curso e historial de cada mensaje.</p></div>
      <div class="actions"><a class="btn" href="#/campanas">${icon('megaphone', 'sm')} Campañas</a>
      ${can('campanas.gestionar') ? html`<a class="btn btn-primary" href="#/campanas/nueva">${icon('plus', 'sm')} Nueva campaña</a>` : ''}</div></div>
    <div data-estado class="mb">${cargando()}</div>
    <div class="card"><div class="card-head"><h3>Historial</h3>
      <div class="row wrap"><select class="select sm" data-camp style="width:auto"><option value="">Todas las campañas</option></select>
      <select class="select sm" data-est style="width:auto">${opciones(Object.entries(ESTADO).map(([k, v]) => [k, v[1]]), '', { vacio: 'Todos los estados' })}</select>
      <input class="input sm" data-q placeholder="Buscar contacto…" style="width:180px"></div></div>
      <div class="table-wrap" data-tabla>${cargando()}</div><div data-pager></div></div>`);

  $('[data-camp]', el).addEventListener('change', e => { st.f.campana_id = e.target.value; st.offset = 0; cargarHistorial(el); });
  $('[data-est]', el).addEventListener('change', e => { st.f.estado = e.target.value; st.offset = 0; cargarHistorial(el); });
  $('[data-q]', el).addEventListener('input', debounce(e => { st.f.q = e.target.value; st.offset = 0; cargarHistorial(el); }, 300));
  acciones(el, {
    prev: () => { st.offset = Math.max(0, st.offset - LIM); cargarHistorial(el); },
    next: () => { st.offset += LIM; cargarHistorial(el); },
  });
  const refrescar = debounce(() => { pintarEstado(el); cargarHistorial(el); }, 1200);
  ['envio:progreso', 'envio:control', 'envio:estado', 'campana:estado'].forEach(ev => subs.push(bus.on(ev, refrescar)));

  try {
    const { rows } = await api.get('/api/campanas');
    $('[data-camp]', el).insertAdjacentHTML('beforeend', String(html`${rows.map(c => html`<option value="${c.id}">${c.nombre}</option>`)}`));
  } catch { /* sin permiso de campañas */ }
  await Promise.all([pintarEstado(el), cargarHistorial(el)]);
}

async function pintarEstado(el) {
  try {
    const s = await api.get('/api/envios/estado');
    const enviando = s.campanas.filter(c => c.estado === 'enviando');
    const activo = enviando.length && !s.bloqueo;
    dibujar($('[data-estado]', el), html`<div class="grid c4">
      <div class="card kpi"><div class="grow"><div class="kpi-label">Estado</div><div class="kpi-value" style="font-size:18px">${activo ? 'Enviando' : enviando.length ? 'En espera' : 'Inactivo'}</div>
        <div class="kpi-sub">${enviando.length ? enviando.map(c => c.nombre).join(', ') : 'Sin campañas en curso'}</div></div></div>
      <div class="card kpi"><div><div class="kpi-label">En cola</div><div class="kpi-value">${fmt.num(s.pendientes)}</div></div></div>
      <div class="card kpi"><div class="grow"><div class="kpi-label">Enviados hoy</div><div class="kpi-value">${fmt.num(s.hoy)} <span class="small muted">/ ${fmt.num(s.limite)}</span></div>
        <div class="progress" style="margin-top:6px"><div style="width:${raw(Math.min(100, (s.hoy / Math.max(1, s.limite)) * 100))}%"></div></div></div></div>
      <div class="card kpi"><div><div class="kpi-label">Fallidos hoy</div><div class="kpi-value">${fmt.num(s.fallidos_hoy)}</div></div></div>
    </div>
    ${enviando.length && s.bloqueo ? html`<div class="alert warning mt">${icon('clock', 'sm')}<div>${s.bloqueo.msg}</div></div>` : ''}`);
  } catch (e) { toastError(e); }
}

async function cargarHistorial(el) {
  try {
    const r = await api.get('/api/envios', { ...st.f, limit: LIM, offset: st.offset });
    dibujar($('[data-tabla]', el), r.rows.length ? html`<table class="table"><thead><tr><th>Contacto</th><th>Campaña</th><th>Número</th><th>Estado</th><th>Enviado</th><th>Detalle</th></tr></thead><tbody>
      ${r.rows.map(e => { const [tone, txt] = ESTADO[e.estado] || ['', e.estado];
        return html`<tr><td class="strong">${e.nombre}</td><td class="small">${e.campana_nombre || '—'}</td><td class="small nowrap">${e.numero || '—'}</td>
          <td><span class="badge ${tone}">${txt}</span></td><td class="small nowrap">${e.enviado_at ? fmt.fechaHora(e.enviado_at) : '—'}</td>
          <td class="xs muted" style="max-width:320px">${e.error_msg || (e.leido_at ? `Leído ${fmt.relativo(e.leido_at)}` : e.entregado_at ? `Entregado ${fmt.relativo(e.entregado_at)}` : '')}</td></tr>`; })}
      </tbody></table>` : vacio({ icono: 'send', titulo: 'Sin envíos', texto: 'Cuando lances una campaña, cada mensaje aparecerá aquí con su estado de entrega.' }));
    dibujar($('[data-pager]', el), r.total > LIM ? pager(r.total, st.offset, LIM) : '');
  } catch (e) { toastError(e); }
}
