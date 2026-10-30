import { html, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, $, cargando } from '../core.js';
import { formReunion } from '../ui.js';
import { abrirContacto } from '../contacto.js';

let st;
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ESTADO_BADGE = { agendada: 'primary', realizada: 'success', reprogramada: 'warning', cancelada: '', no_asistio: 'danger' };
const clave = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export async function render(el) {
  const hoy = new Date();
  st = { anio: hoy.getFullYear(), mes: hoy.getMonth(), vista: 'mes', rows: [] };
  dibujar(el, html`
    <div class="page-head"><div><h1>Agenda</h1><p>Reuniones y demos con recordatorios automáticos por WhatsApp.</p></div>
      <div class="actions"><div class="seg"><button class="active" data-act="vista" data-v="mes">${icon('grid', 'sm')} Mes</button><button data-act="vista" data-v="lista">${icon('list', 'sm')} Próximas</button></div>
      ${can('agenda.gestionar') ? html`<button class="btn btn-primary" data-act="nueva">${icon('plus', 'sm')} Agendar reunión</button>` : ''}</div></div>
    <div class="card"><div class="card-head" data-nav></div><div data-cuerpo>${cargando()}</div></div>`);
  acciones(el, {
    vista: b => { st.vista = b.dataset.v; el.querySelectorAll('[data-act=vista]').forEach(x => x.classList.toggle('active', x === b)); cargar(el); },
    prev: () => { st.mes--; if (st.mes < 0) { st.mes = 11; st.anio--; } cargar(el); },
    next: () => { st.mes++; if (st.mes > 11) { st.mes = 0; st.anio++; } cargar(el); },
    hoy: () => { const h = new Date(); st.anio = h.getFullYear(); st.mes = h.getMonth(); cargar(el); },
    nueva: async () => { if (await formReunion()) { toast('Reunión agendada'); cargar(el); } },
    dia: d => {
      if (!can('agenda.gestionar')) return;
      const f = new Date(+d.dataset.t); f.setHours(10, 0, 0, 0);
      formReunion(null, { fecha: f }).then(ok => ok && (toast('Reunión agendada'), cargar(el)));
    },
    evento: (e, ev) => { ev.stopPropagation(); editar(el, +e.dataset.id); },
    contacto: a => abrirContacto(a.dataset.id),
    editar: b => editar(el, +b.dataset.id),
    estado: async b => {
      try { await api.put(`/api/agenda/${b.dataset.id}`, { estado: b.dataset.e }); toast('Reunión actualizada'); cargar(el); } catch (e) { toastError(e); }
    },
  });
  await cargar(el);
}

async function editar(el, id) {
  const r = st.rows.find(x => x.id === id);
  if (!r || !can('agenda.gestionar')) return r && abrirContacto(r.negocio_id);
  const res = await formReunion(r);
  if (res) { toast('Reunión actualizada'); cargar(el); }
}

async function cargar(el) {
  const nav = $('[data-nav]', el), cuerpo = $('[data-cuerpo]', el);
  try {
    if (st.vista === 'lista') {
      dibujar(nav, html`<h3>Próximas reuniones</h3>`);
      const { rows } = await api.get('/api/agenda', { desde: new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ') });
      st.rows = rows;
      dibujar(cuerpo, rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Contacto</th><th>Reunión</th><th>Responsable</th><th>Estado</th><th></th></tr></thead><tbody>
        ${rows.map(r => html`<tr><td class="nowrap"><b>${fmt.fechaCorta(r.fecha_hora)}</b> <span class="muted">${fmt.hora(r.fecha_hora)}</span></td>
          <td><a href="#" data-act="contacto" data-id="${r.negocio_id}">${r.nombre}</a></td>
          <td>${r.titulo}<div class="xs muted">${r.tipo} · ${r.duracion_min} min${r.enlace ? html` · <a href="${r.enlace}" target="_blank" rel="noopener noreferrer">enlace</a>` : ''}</div></td>
          <td class="small">${r.asignado_nombre || '—'}</td><td><span class="badge ${ESTADO_BADGE[r.estado]}">${r.estado.replace('_', ' ')}</span></td>
          <td class="actions">${can('agenda.gestionar') && r.estado === 'agendada' ? html`<button class="btn btn-xs" data-act="estado" data-id="${r.id}" data-e="realizada">${icon('check', 'sm')} Realizada</button>` : ''}
            ${can('agenda.gestionar') ? html`<button class="btn btn-xs btn-ghost" data-act="editar" data-id="${r.id}">${icon('edit', 'sm')}</button>` : ''}</td></tr>`)}
        </tbody></table></div>` : vacio({ icono: 'calendar', titulo: 'No hay reuniones próximas', texto: 'Agenda demos con tus prospectos; recibirán recordatorios automáticos.' }));
      return;
    }

    dibujar(nav, html`<div class="row"><button class="btn btn-sm btn-icon" data-act="prev" aria-label="Mes anterior">${icon('chevronLeft', 'sm')}</button>
      <h3 style="min-width:160px;text-align:center">${MESES[st.mes]} ${st.anio}</h3>
      <button class="btn btn-sm btn-icon" data-act="next" aria-label="Mes siguiente">${icon('chevronRight', 'sm')}</button></div>
      <button class="btn btn-sm" data-act="hoy">Hoy</button>`);
    const primero = new Date(st.anio, st.mes, 1);
    const inicio = new Date(primero); inicio.setDate(1 - ((primero.getDay() + 6) % 7)); // lunes
    const fin = new Date(inicio); fin.setDate(fin.getDate() + 42);
    const p = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const { rows } = await api.get('/api/agenda', { desde: p(inicio), hasta: p(fin) });
    st.rows = rows;
    const porDia = {};
    rows.forEach(r => { const k = clave(new Date(r.fecha_hora)); (porDia[k] = porDia[k] || []).push(r); });
    const hoyK = clave(new Date());
    const dias = [];
    for (let i = 0; i < 42; i++) { const d = new Date(inicio); d.setDate(inicio.getDate() + i); dias.push(d); }
    dibujar(cuerpo, html`<div class="cal">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(d => html`<div class="cal-h">${d}</div>`)}
      ${dias.map(d => { const evs = porDia[clave(d)] || [];
        return html`<div class="cal-d ${d.getMonth() !== st.mes ? 'otro' : ''} ${clave(d) === hoyK ? 'hoy' : ''}" data-act="dia" data-t="${d.getTime()}">
          <div class="cal-n">${d.getDate()}</div>
          ${evs.slice(0, 3).map(r => html`<div class="cal-ev ${r.estado}" data-act="evento" data-id="${r.id}" title="${fmt.hora(r.fecha_hora)} ${r.nombre} — ${r.titulo}">${fmt.hora(r.fecha_hora)} ${r.nombre}</div>`)}
          ${evs.length > 3 ? html`<div class="xs muted">+${evs.length - 3} más</div>` : ''}</div>`; })}</div>`);
  } catch (e) { toastError(e); }
}

export { confirmar };
