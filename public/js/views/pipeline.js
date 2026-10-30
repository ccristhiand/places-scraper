import { html, raw, icon, api, render as dibujar, acciones, fmt, can, toast, toastError, etapas, usuarios, opciones, debounce, $, $$, avatar, cargando, formModal } from '../core.js';
import { abrirContacto } from '../contacto.js';
import { formContacto } from '../ui.js';

let st;

export async function render(el) {
  st = { q: '', asignado: '', columnas: [] };
  const us = can('contactos.ver_todos') ? await usuarios() : [];
  dibujar(el, html`
    <div class="page-head"><div><h1>Pipeline</h1><p>Arrastra las tarjetas para mover las oportunidades entre etapas.</p></div>
      <div class="actions">${can('config.editar') ? html`<a class="btn" href="#/config/pipeline">${icon('settings', 'sm')} Etapas</a>` : ''}
      ${can('contactos.crear') ? html`<button class="btn btn-primary" data-act="nuevo">${icon('plus', 'sm')} Nueva oportunidad</button>` : ''}</div></div>
    <div class="toolbar">
      <div class="search">${icon('search', 'sm')}<input class="input" data-q placeholder="Filtrar oportunidades…"></div>
      ${us.length ? html`<select class="select" data-asig>${opciones([['yo', 'Mis oportunidades'], ['sin', 'Sin asignar'], ...us.map(u => [u.id, u.nombre])], '', { vacio: 'Todo el equipo' })}</select>` : ''}
      <div class="small muted right" data-resumen></div>
    </div>
    <div class="kanban" data-kanban>${cargando()}</div>`);

  $('[data-q]', el).addEventListener('input', debounce(e => { st.q = e.target.value; cargar(el); }, 300));
  $('[data-asig]', el)?.addEventListener('change', e => { st.asignado = e.target.value; cargar(el); });
  acciones(el, {
    abrir: c => abrirContacto(c.dataset.id, { onCambio: () => cargar(el) }),
    nuevo: async () => { if (await formContacto()) { toast('Oportunidad creada'); cargar(el); } },
  });
  enlazarDrag(el);
  await cargar(el);
}

async function cargar(el) {
  try {
    const { columnas } = await api.get('/api/crm/pipeline', { q: st.q, asignado: st.asignado, limite: 100 });
    st.columnas = columnas;
    const abiertas = columnas.filter(c => c.tipo === 'abierta');
    $('[data-resumen]', el).textContent = `${fmt.num(abiertas.reduce((s, c) => s + c.total, 0))} abiertas · ${fmt.moneda(abiertas.reduce((s, c) => s + c.valor, 0))}`;
    dibujar($('[data-kanban]', el), html`${columnas.map(col => html`<div class="kcol" data-col="${col.clave}" style="--stage:${raw(col.color)}">
      <div class="kcol-head"><div class="row between"><span>${col.nombre} <span class="muted small">${fmt.num(col.total)}</span></span>
        ${col.tipo === 'ganada' ? icon('trophy', 'sm') : col.tipo === 'perdida' ? icon('x', 'sm') : ''}</div>
        <div class="xs muted">${col.valor ? fmt.moneda(col.valor) : ' '}</div>
        <div class="kcol-bar" style="background:${raw(col.color)}"></div></div>
      <div class="kcol-body">${col.cards.map(c => tarjeta(c))}${col.total > col.cards.length ? html`<a class="small center" href="#/contactos" style="padding:6px">+ ${fmt.num(col.total - col.cards.length)} más en Contactos</a>` : ''}</div></div>`)}`);
  } catch (e) { toastError(e); }
}

function tarjeta(c) {
  const dias = Math.floor((Date.now() - new Date(c.ultima_actividad_at || c.updated_at).getTime()) / 864e5);
  return html`<div class="kcard" draggable="${can('pipeline.mover') ? 'true' : 'false'}" data-card="${c.id}" data-act="abrir" data-id="${c.id}">
    <div class="kcard-title">${c.nombre}</div>
    ${c.valor_estimado ? html`<div class="small strong" style="color:var(--success)">${fmt.moneda(c.valor_estimado)}</div>` : ''}
    <div class="kcard-meta" style="margin-top:6px">
      ${c.distrito ? html`<span>${icon('pin', 'sm')} ${c.distrito}</span>` : ''}
      ${c.tareas ? html`<span title="Tareas pendientes">${icon('checkSquare', 'sm')} ${c.tareas}</span>` : ''}
      ${c.ultimo_entrante_at && Date.now() - new Date(c.ultimo_entrante_at) < 864e5 ? html`<span title="Ventana de WhatsApp abierta" style="color:var(--wa)">${icon('whatsapp', 'sm')}</span>` : ''}
      <span title="Días sin actividad" style="${dias > 14 ? 'color:var(--danger)' : ''}">${icon('clock', 'sm')} ${dias}d</span>
      ${c.asignado_nombre ? html`<span class="right">${avatar(c.asignado_nombre, 'sm')}</span>` : ''}
    </div></div>`;
}

function enlazarDrag(el) {
  let arrastrando = null;
  el.addEventListener('dragstart', e => {
    const card = e.target.closest('[data-card]'); if (!card) return;
    arrastrando = card; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.dataset.card);
  });
  el.addEventListener('dragend', () => { arrastrando?.classList.remove('dragging'); arrastrando = null; $$('.kcol.over', el).forEach(c => c.classList.remove('over')); });
  el.addEventListener('dragover', e => {
    const col = e.target.closest('[data-col]'); if (!col || !arrastrando) return;
    e.preventDefault();
    $$('.kcol.over', el).forEach(c => c !== col && c.classList.remove('over'));
    col.classList.add('over');
  });
  el.addEventListener('drop', async e => {
    const col = e.target.closest('[data-col]'); if (!col || !arrastrando) return;
    e.preventDefault(); col.classList.remove('over');
    const id = arrastrando.dataset.card;
    const origen = arrastrando.closest('[data-col]').dataset.col;
    const destino = col.dataset.col;
    if (origen === destino) return;
    const et = st.columnas.find(c => c.clave === destino);
    let motivo;
    if (et.tipo === 'perdida') {
      motivo = await formModal({ title: `Mover a ${et.nombre}`, size: 'sm', submit: 'Mover',
        fields: html`<label class="field span-2"><span>¿Por qué se perdió?</span><select class="select" name="m">${opciones(['Precio', 'Eligió a la competencia', 'No responde', 'No le interesa', 'Sin presupuesto', 'Otro'].map(x => [x, x]), '')}</select></label>`,
        onSubmit: d => d.m || 'Sin motivo' }).done;
      if (!motivo) return;
    }
    $('.kcol-body', col).prepend(arrastrando);
    try {
      await api.patch(`/api/contactos/${id}/etapa`, { etapa: destino, motivo });
      toast(et.tipo === 'ganada' ? 'Oportunidad marcada como ganada' : `Movido a ${et.nombre}`);
      cargar(el);
    } catch (ex) { toastError(ex); cargar(el); }
  });
}
