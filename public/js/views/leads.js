import { html, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, opciones, debounce, $, cargando, formModal } from '../core.js';
import { pager, enlaceWa } from '../ui.js';
import { abrirContacto } from '../contacto.js';

const ESTADOS = [['nuevo', 'Nuevo', 'primary'], ['contactado', 'Contactado', 'info'], ['interesado', 'Interesado', 'warning'], ['cerrado', 'Cerrado', 'success'], ['descartado', 'Descartado', '']];
const LIM = 25;
let st;

export async function render(el) {
  st = { estado: '', q: '', offset: 0, rows: [] };
  dibujar(el, html`
    <div class="page-head"><div><h1>Leads web</h1><p>Solicitudes recibidas desde el formulario de tu landing.</p></div></div>
    <div class="grid c4 mb" data-kpis></div>
    <div class="toolbar">
      <div class="search">${icon('search', 'sm')}<input class="input" data-q placeholder="Buscar por nombre, empresa, WhatsApp o correo…"></div>
      <select class="select" data-estado>${opciones(ESTADOS.map(e => [e[0], e[1]]), '', { vacio: 'Todos los estados' })}</select>
    </div>
    <div class="card"><div class="table-wrap" data-tabla>${cargando()}</div><div data-pager></div></div>`);
  $('[data-q]', el).addEventListener('input', debounce(e => { st.q = e.target.value; st.offset = 0; cargar(el); }, 300));
  $('[data-estado]', el).addEventListener('change', e => { st.estado = e.target.value; st.offset = 0; cargar(el); });
  el.addEventListener('change', async e => {
    if (!e.target.matches('[data-cambiar]')) return;
    try { await api.put(`/api/leads/${e.target.dataset.cambiar}`, { estado: e.target.value }); toast('Estado actualizado'); cargar(el); } catch (ex) { toastError(ex); }
  });
  acciones(el, {
    prev: () => { st.offset = Math.max(0, st.offset - LIM); cargar(el); },
    next: () => { st.offset += LIM; cargar(el); },
    ver: b => verLead(el, st.rows.find(l => l.id === +b.dataset.id)),
    convertir: b => convertir(el, +b.dataset.id),
    contacto: b => abrirContacto(b.dataset.id),
    borrar: async b => {
      if (!(await confirmar('¿Eliminar este lead? No se puede deshacer.', { ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/leads/${b.dataset.id}`); cargar(el); } catch (e) { toastError(e); }
    },
  });
  await cargar(el);
}

async function convertir(el, id) {
  try {
    const r = await api.post(`/api/leads/${id}/convertir`);
    toast('Lead convertido en contacto');
    cargar(el); abrirContacto(r.negocio_id);
  } catch (e) { toastError(e); }
}

function verLead(el, l) {
  formModal({
    title: l.clinica, subtitle: `${l.nombre} · recibido ${fmt.fechaHora(l.fecha_registro)}`, submit: 'Guardar notas',
    fields: html`<div class="span-2 stack sm small">
      <div class="row between"><span class="muted">WhatsApp</span><a href="${enlaceWa(l.whatsapp)}" target="_blank" rel="noopener noreferrer">${l.whatsapp}</a></div>
      <div class="row between"><span class="muted">Correo</span><span>${l.email || '—'}</span></div>
      <div class="row between"><span class="muted">País</span><span>${l.pais || '—'}</span></div>
      <div class="row between"><span class="muted">Plan</span><span class="badge primary">${l.plan} · ${l.ciclo}</span></div>
      ${l.mensaje ? html`<div class="card"><div class="card-body" style="white-space:pre-wrap">${l.mensaje}</div></div>` : ''}</div>
      <label class="field span-2"><span>Notas internas</span><textarea class="input" name="notas" rows="4">${l.notas || ''}</textarea></label>`,
    onSubmit: async d => { if (!can('leads.gestionar')) return; await api.put(`/api/leads/${l.id}`, { notas: d.notas }); toast('Notas guardadas'); cargar(el); },
  });
}

async function cargar(el) {
  try {
    const r = await api.get('/api/leads', { estado: st.estado, q: st.q, limit: LIM, offset: st.offset });
    st.rows = r.rows;
    const cuenta = Object.fromEntries(r.por_estado.map(x => [x.estado, x.n]));
    dibujar($('[data-kpis]', el), html`${ESTADOS.slice(0, 4).map(([k, t, tone]) => html`<div class="card kpi"><div class="kpi-icon tone-${tone || 'muted'}">${icon(k === 'cerrado' ? 'trophy' : 'inbox')}</div>
      <div><div class="kpi-label">${t}</div><div class="kpi-value">${fmt.num(cuenta[k] || 0)}</div></div></div>`)}`);
    dibujar($('[data-tabla]', el), r.rows.length ? html`<table class="table"><thead><tr><th>Empresa</th><th>Contacto</th><th>Plan</th><th>Recibido</th><th>Estado</th><th></th></tr></thead><tbody>
      ${r.rows.map(l => html`<tr>
        <td><a href="#" data-act="ver" data-id="${l.id}" class="strong">${l.clinica}</a>${l.mensaje ? html`<div class="xs muted truncate" style="max-width:280px">${l.mensaje}</div>` : ''}</td>
        <td class="small">${l.nombre}<div class="xs"><a href="${enlaceWa(l.whatsapp)}" target="_blank" rel="noopener noreferrer">${l.whatsapp}</a>${l.email ? ` · ${l.email}` : ''}</div></td>
        <td><span class="badge primary">${l.plan}</span><div class="xs muted">${l.ciclo}</div></td>
        <td class="small nowrap">${fmt.relativo(l.fecha_registro)}</td>
        <td>${can('leads.gestionar') ? html`<select class="select sm" data-cambiar="${l.id}" style="width:auto">${opciones(ESTADOS.map(e => [e[0], e[1]]), l.estado)}</select>` : html`<span class="badge">${l.estado}</span>`}</td>
        <td class="actions">${l.negocio_id ? html`<button class="btn btn-xs" data-act="contacto" data-id="${l.negocio_id}">${icon('user', 'sm')} Ver contacto</button>`
          : can('leads.gestionar') && can('contactos.crear') ? html`<button class="btn btn-xs btn-primary" data-act="convertir" data-id="${l.id}">${icon('userPlus', 'sm')} Convertir</button>` : ''}
          ${can('leads.gestionar') ? html`<button class="btn btn-xs btn-ghost" data-act="borrar" data-id="${l.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</td></tr>`)}
      </tbody></table>` : vacio({ icono: 'inbox', titulo: 'Sin leads', texto: 'Cuando alguien complete el formulario de tu landing aparecerá aquí al instante.' }));
    dibujar($('[data-pager]', el), r.total > LIM ? pager(r.total, st.offset, LIM) : '');
  } catch (e) { toastError(e); }
}
