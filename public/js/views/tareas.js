import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, usuarios, opciones, $, $$, cargando } from '../core.js';
import { formTarea } from '../ui.js';
import { abrirContacto } from '../contacto.js';

let st;
const RANGOS = [['', 'Todas'], ['vencidas', 'Vencidas'], ['hoy', 'Hoy'], ['semana', 'Próximos 7 días'], ['sin_fecha', 'Sin fecha']];

export async function render(el) {
  st = { estado: 'pendiente', rango: '', asignado: '', rows: [] };
  const us = can('contactos.ver_todos') ? await usuarios() : [];
  dibujar(el, html`
    <div class="page-head"><div><h1>Tareas</h1><p>Seguimientos y pendientes del equipo comercial.</p></div>
      <div class="actions">${can('tareas.gestionar') ? html`<button class="btn btn-primary" data-act="nueva">${icon('plus', 'sm')} Nueva tarea</button>` : ''}</div></div>
    <div class="toolbar">
      <div class="seg"><button class="active" data-act="estado" data-e="pendiente">Pendientes</button><button data-act="estado" data-e="completada">Completadas</button></div>
      <div class="seg" data-rangos>${RANGOS.map(([k, t], i) => html`<button class="${i === 0 ? 'active' : ''}" data-act="rango" data-r="${k}">${t}</button>`)}</div>
      ${us.length ? html`<select class="select right" data-asig>${opciones([['yo', 'Mis tareas'], ...us.map(u => [u.id, u.nombre])], '', { vacio: 'Todo el equipo' })}</select>` : ''}
    </div>
    <div class="card" data-lista>${cargando()}</div>`);
  $('[data-asig]', el)?.addEventListener('change', e => { st.asignado = e.target.value; cargar(el); });
  acciones(el, {
    estado: b => { st.estado = b.dataset.e; $$('[data-act=estado]', el).forEach(x => x.classList.toggle('active', x === b)); cargar(el); },
    rango: b => { st.rango = b.dataset.r; $$('[data-act=rango]', el).forEach(x => x.classList.toggle('active', x === b)); cargar(el); },
    nueva: async () => { if (await formTarea()) { toast('Tarea creada'); cargar(el); } },
    editar: async b => { const t = st.rows.find(x => x.id === +b.dataset.id); if (await formTarea(t)) { toast('Tarea actualizada'); cargar(el); } },
    borrar: async b => {
      if (!(await confirmar('¿Eliminar esta tarea?', { ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/tareas/${b.dataset.id}`); cargar(el); } catch (e) { toastError(e); }
    },
    contacto: a => abrirContacto(a.dataset.id, { onCambio: () => cargar(el) }),
  });
  el.addEventListener('change', async e => {
    if (!e.target.matches('[data-toggle]')) return;
    try {
      await api.post(`/api/tareas/${e.target.dataset.toggle}/estado`, { estado: e.target.checked ? 'completada' : 'pendiente' });
      toast(e.target.checked ? 'Tarea completada' : 'Tarea reabierta');
      setTimeout(() => cargar(el), 300);
    } catch (ex) { toastError(ex); e.target.checked = !e.target.checked; }
  });
  await cargar(el);
}

async function cargar(el) {
  try {
    const { rows } = await api.get('/api/tareas', { estado: st.estado, rango: st.rango, asignado: st.asignado || (can('contactos.ver_todos') ? 'todos' : 'yo') });
    st.rows = rows;
    const ahora = new Date();
    dibujar($('[data-lista]', el), rows.length ? html`${rows.map(t => {
      const vencida = t.estado === 'pendiente' && t.vence_at && new Date(t.vence_at) < ahora;
      return html`<div class="list-item">
        <label class="check" style="margin-top:2px"><input type="checkbox" data-toggle="${t.id}" ${t.estado === 'completada' ? raw('checked') : ''} ${can('tareas.gestionar') ? '' : raw('disabled')} aria-label="Completar"></label>
        <div class="grow">
          <div class="strong" style="${t.estado === 'completada' ? 'text-decoration:line-through;opacity:.6' : ''}">${t.titulo}</div>
          ${t.descripcion ? html`<div class="small muted" style="white-space:pre-wrap">${t.descripcion}</div>` : ''}
          <div class="row wrap xs muted" style="margin-top:4px">
            <span style="${vencida ? 'color:var(--danger);font-weight:600' : ''}">${icon('clock', 'sm')} ${t.vence_at ? (vencida ? 'Vencida · ' : '') + fmt.fechaHora(t.vence_at) : 'Sin fecha'}</span>
            ${t.negocio_id ? html`<a href="#" data-act="contacto" data-id="${t.negocio_id}">${icon('user', 'sm')} ${t.negocio_nombre}</a>` : ''}
            ${t.asignado_nombre ? html`<span>· ${t.asignado_nombre}</span>` : ''}
          </div></div>
        <span class="badge ${t.prioridad === 'alta' ? 'danger' : t.prioridad === 'media' ? 'warning' : ''}">${t.prioridad}</span>
        ${can('tareas.gestionar') ? html`<button class="btn btn-ghost btn-sm btn-icon" data-act="editar" data-id="${t.id}" aria-label="Editar">${icon('edit', 'sm')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="borrar" data-id="${t.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}
      </div>`;
    })}` : vacio({ icono: 'checkSquare', titulo: st.estado === 'pendiente' ? '¡Nada pendiente!' : 'Sin tareas completadas', texto: 'Las tareas te ayudan a no olvidar ningún seguimiento.' }));
  } catch (e) { toastError(e); }
}
