// Componentes compartidos entre vistas
import { html, raw, icon, api, $, $$, render, debounce, fmt, opciones, usuarios, etapas, can, inputFecha, formModal, esc, session } from './core.js';

// ── Paginación ─────────────────────────────────────────────────────────────
export function pager(total, offset, limit) {
  const desde = total ? offset + 1 : 0, hasta = Math.min(offset + limit, total);
  return html`<div class="pager"><span>${fmt.num(desde)}–${fmt.num(hasta)} de ${fmt.num(total)}</span>
    <div class="row"><button class="btn btn-sm" data-act="prev" ${offset <= 0 ? raw('disabled') : ''}>${icon('chevronLeft', 'sm')} Anterior</button>
    <button class="btn btn-sm" data-act="next" ${hasta >= total ? raw('disabled') : ''}>Siguiente ${icon('chevronRight', 'sm')}</button></div></div>`;
}

// ── Selector de contacto con autocompletado ────────────────────────────────
export function campoContacto(nombre = 'negocio_id', previo = null, etiqueta = 'Contacto') {
  return html`<label class="field span-2 ac" data-ac="${nombre}"><span>${etiqueta}</span>
    <input type="hidden" name="${nombre}" value="${previo?.id || ''}">
    <div style="position:relative"><input class="input" data-ac-input placeholder="Busca por nombre o teléfono…" value="${previo?.nombre || ''}" autocomplete="off" ${previo?.fijo ? raw('disabled') : ''}>
    <div class="search-results hidden" data-ac-list></div></div></label>`;
}
export function enlazarContacto(form, nombre = 'negocio_id') {
  const wrap = $(`[data-ac="${nombre}"]`, form);
  if (!wrap) return;
  const hidden = form.elements[nombre], inp = $('[data-ac-input]', wrap), list = $('[data-ac-list]', wrap);
  const buscar = debounce(async q => {
    if (q.length < 2) { list.classList.add('hidden'); return; }
    const r = await api.get('/api/contactos', { q, limit: 8 });
    render(list, r.rows.length ? html`${r.rows.map(c => html`<a href="#" data-id="${c.id}" data-nombre="${c.nombre}">
      <div class="grow"><div class="strong truncate">${c.nombre}</div><div class="xs muted">${[c.distrito, c.whatsapp || c.telefono].filter(Boolean).join(' · ')}</div></div></a>`)}`
      : html`<div class="list-item muted small">Sin resultados</div>`);
    list.classList.remove('hidden');
  }, 250);
  inp.addEventListener('input', () => { hidden.value = ''; buscar(inp.value.trim()); });
  list.addEventListener('mousedown', e => {
    const a = e.target.closest('[data-id]'); if (!a) return;
    e.preventDefault();
    hidden.value = a.dataset.id; inp.value = a.dataset.nombre; list.classList.add('hidden');
  });
  inp.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
}

// ── Ubigeo encadenado (departamento → provincia → distrito) ───────────────
export function camposUbigeo(prev = {}, { clase = 'select', nombres = ['departamento', 'provincia', 'distrito'], vacio = 'Todos' } = {}) {
  return html`${nombres.map((n, i) => html`<select class="${clase}" name="${n}" data-ubi="${i}" aria-label="${n}"><option value="">${i === 0 ? `Departamento: ${vacio}` : i === 1 ? `Provincia: ${vacio}` : `Distrito: ${vacio}`}</option>${prev[n] ? html`<option selected>${prev[n]}</option>` : ''}</select>`)}`;
}
export async function enlazarUbigeo(root, onChange) {
  const [dep, prov, dist] = $$('[data-ubi]', root).sort((a, b) => a.dataset.ubi - b.dataset.ubi);
  const llenar = (sel, lista, etiqueta) => {
    const actual = sel.value;
    render(sel, html`<option value="">${etiqueta}</option>${lista.map(x => html`<option ${x === actual ? raw('selected') : ''}>${x}</option>`)}`);
  };
  const r = await api.get('/api/ubigeo');
  llenar(dep, r.departamentos, 'Departamento: Todos');
  const cargarProv = async () => {
    if (!dep.value) { llenar(prov, [], 'Provincia: Todas'); llenar(dist, [], 'Distrito: Todos'); return; }
    llenar(prov, (await api.get('/api/ubigeo', { dep: dep.value })).provincias || [], 'Provincia: Todas');
  };
  const cargarDist = async () => {
    if (!dep.value || !prov.value) { llenar(dist, [], 'Distrito: Todos'); return; }
    llenar(dist, (await api.get('/api/ubigeo', { dep: dep.value, prov: prov.value })).distritos || [], 'Distrito: Todos');
  };
  if (dep.value) { await cargarProv(); if (prov.value) await cargarDist(); }
  dep.addEventListener('change', async () => { prov.value = ''; dist.value = ''; await cargarProv(); await cargarDist(); onChange?.(); });
  prov.addEventListener('change', async () => { dist.value = ''; await cargarDist(); onChange?.(); });
  dist.addEventListener('change', () => onChange?.());
}

// ── Formularios reutilizables ──────────────────────────────────────────────
export async function formContacto(c = null, { onGuardado } = {}) {
  const [ets, us] = await Promise.all([etapas(), can('contactos.asignar') ? usuarios() : []]);
  const v = c || {};
  return formModal({
    title: c ? 'Editar contacto' : 'Nuevo contacto', size: 'lg', submit: c ? 'Guardar cambios' : 'Crear contacto',
    fields: html`
      <label class="field"><span>Nombre del negocio *</span><input class="input" name="nombre" required maxlength="500" value="${v.nombre || ''}"></label>
      <label class="field"><span>Persona de contacto</span><input class="input" name="contacto_nombre" maxlength="200" value="${v.contacto_nombre || ''}"></label>
      <label class="field"><span>WhatsApp</span><input class="input" name="whatsapp" maxlength="50" placeholder="51987654321" value="${v.whatsapp || ''}"></label>
      <label class="field"><span>Teléfono</span><input class="input" name="telefono" maxlength="100" value="${v.telefono || ''}"></label>
      <label class="field"><span>Correo</span><input class="input" type="email" name="email" maxlength="190" value="${v.email || ''}"></label>
      <label class="field"><span>Sitio web</span><input class="input" name="website" maxlength="500" value="${v.website || ''}"></label>
      <label class="field span-2"><span>Dirección</span><input class="input" name="direccion" value="${v.direccion || ''}"></label>
      <label class="field"><span>Distrito</span><input class="input" name="distrito" value="${v.distrito || ''}"></label>
      <label class="field"><span>Provincia / Departamento</span><div class="row"><input class="input" name="provincia" placeholder="Provincia" value="${v.provincia || ''}"><input class="input" name="departamento" placeholder="Departamento" value="${v.departamento || ''}"></div></label>
      <label class="field"><span>Rubro</span><input class="input" name="rubro_busqueda" value="${v.rubro_busqueda || ''}"></label>
      <label class="field"><span>Valor estimado</span><input class="input" type="number" min="0" step="0.01" name="valor_estimado" value="${v.valor_estimado ?? ''}"></label>
      ${c ? '' : html`<label class="field"><span>Etapa</span><select class="select" name="estado_crm">${opciones(ets.map(e => [e.clave, e.nombre]), ets[0]?.clave)}</select></label>`}
      ${can('contactos.asignar') ? html`<label class="field"><span>Vendedor asignado</span><select class="select" name="asignado_a">${opciones(us, v.asignado_a ?? (c ? '' : undefined), { vacio: 'Sin asignar' })}</select></label>` : ''}
      <label class="field span-2"><span>Etiquetas <span class="hint">separadas por coma</span></span><input class="input" name="etiquetas" value="${v.etiquetas || ''}" placeholder="vip, lima-sur"></label>`,
    onSubmit: async d => {
      const r = c ? await api.put(`/api/contactos/${c.id}`, d) : await api.post('/api/contactos', d);
      onGuardado?.(c ? c.id : r.id);
      return r;
    },
  }).done;
}

export async function formTarea(t = null, { negocio = null, onGuardado } = {}) {
  const us = can('contactos.asignar') ? await usuarios() : [];
  const v = t || {};
  const prevNeg = negocio ? { ...negocio, fijo: true } : (v.negocio_id ? { id: v.negocio_id, nombre: v.negocio_nombre } : null);
  return formModal({
    title: t ? 'Editar tarea' : 'Nueva tarea', submit: t ? 'Guardar' : 'Crear tarea',
    fields: html`
      <label class="field span-2"><span>¿Qué hay que hacer? *</span><input class="input" name="titulo" required maxlength="255" value="${v.titulo || ''}" placeholder="Llamar para confirmar la propuesta"></label>
      <label class="field"><span>Vence</span><input class="input" type="datetime-local" name="vence_at" value="${inputFecha(v.vence_at)}"></label>
      <label class="field"><span>Prioridad</span><select class="select" name="prioridad">${opciones([['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta']], v.prioridad || 'media')}</select></label>
      ${campoContacto('negocio_id', prevNeg, 'Contacto relacionado (opcional)')}
      ${us.length ? html`<label class="field span-2"><span>Asignar a</span><select class="select" name="asignado_a">${opciones(us, v.asignado_a)}</select></label>` : ''}
      <label class="field span-2"><span>Notas</span><textarea class="input" name="descripcion" rows="3">${v.descripcion || ''}</textarea></label>`,
    onMount: (m, form) => {
      enlazarContacto(form);
      if (us.length && !t) form.asignado_a.value = String(session.user?.id || '');
      if (negocio) form.negocio_id.value = negocio.id;
    },
    onSubmit: async d => {
      if (!d.vence_at) d.vence_at = null;
      const r = t ? await api.put(`/api/tareas/${t.id}`, d) : await api.post('/api/tareas', d);
      onGuardado?.(); return r;
    },
  }).done;
}

export async function formReunion(r = null, { negocio = null, fecha = null, onGuardado } = {}) {
  const us = await usuarios();
  const v = r || {};
  const prevNeg = negocio ? { ...negocio, fijo: true } : (v.negocio_id ? { id: v.negocio_id, nombre: v.nombre, fijo: !!r } : null);
  const inicio = v.fecha_hora || fecha || (() => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(10, 0, 0, 0); return x; })();
  return formModal({
    title: r ? 'Editar reunión' : 'Agendar reunión', submit: r ? 'Guardar' : 'Agendar',
    fields: html`
      ${campoContacto('negocio_id', prevNeg)}
      <label class="field span-2"><span>Título</span><input class="input" name="titulo" maxlength="300" value="${v.titulo || 'Demo del producto'}"></label>
      <label class="field"><span>Fecha y hora *</span><input class="input" type="datetime-local" name="fecha_hora" required value="${inputFecha(inicio)}"></label>
      <label class="field"><span>Duración (min)</span><input class="input" type="number" min="5" max="600" step="5" name="duracion_min" value="${v.duracion_min || 60}"></label>
      <label class="field"><span>Modalidad</span><select class="select" name="tipo">${opciones([['virtual', 'Virtual'], ['presencial', 'Presencial'], ['telefonica', 'Telefónica']], v.tipo || 'virtual')}</select></label>
      <label class="field"><span>Responsable</span><select class="select" name="asignado_a">${opciones(us, v.asignado_a)}</select></label>
      <label class="field span-2"><span>Enlace (Meet, Zoom…)</span><input class="input" name="enlace" type="url" placeholder="https://" value="${v.enlace || ''}"></label>
      ${r ? html`<label class="field span-2"><span>Estado</span><select class="select" name="estado">${opciones([['agendada', 'Agendada'], ['realizada', 'Realizada'], ['reprogramada', 'Reprogramada'], ['no_asistio', 'No asistió'], ['cancelada', 'Cancelada']], v.estado)}</select></label>` : ''}
      <label class="field span-2"><span>Notas</span><textarea class="input" name="notas" rows="3">${v.notas || ''}</textarea></label>
      <div class="alert info span-2 small">${icon('info', 'sm')}<div>Se enviará un recordatorio por WhatsApp 24 h y 1 h antes (configurable).</div></div>`,
    onMount: (m, form) => {
      enlazarContacto(form);
      if (!r) form.asignado_a.value = String(session.user?.id || '');
      if (negocio) form.negocio_id.value = negocio.id;
    },
    onSubmit: async d => {
      if (!d.negocio_id) throw new Error('Selecciona un contacto de la lista.');
      const x = r ? await api.put(`/api/agenda/${r.id}`, d) : await api.post('/api/agenda', d);
      onGuardado?.(); return x;
    },
  }).done;
}

// ── Gráficos ───────────────────────────────────────────────────────────────
// series: [{ clave, nombre, color }]; datos: [{ etiqueta, [clave]: n }]
export function barras(datos, series) {
  const max = Math.max(1, ...datos.map(d => series.reduce((s, x) => s + Number(d[x.clave] || 0), 0)));
  return html`<div class="bars">${datos.map(d => html`<div class="bar-col" title="${d.etiqueta}: ${series.map(s => `${s.nombre} ${d[s.clave] || 0}`).join(' · ')}">
      <div class="bar-stack">${series.map(s => html`<div class="bar" style="height:${raw((Number(d[s.clave] || 0) / max) * 100)}%;background:${raw(s.color)}"></div>`)}</div>
      <div class="bar-label">${d.etiqueta}</div></div>`)}</div>
    <div class="legend mt">${series.map(s => html`<span><i style="background:${raw(s.color)}"></i>${s.nombre}</span>`)}</div>`;
}
export function hbarras(items, { color = 'var(--primary)', formato = fmt.num, etiqueta = 'nombre', valor = 'total' } = {}) {
  const max = Math.max(1, ...items.map(i => Number(i[valor] || 0)));
  if (!items.length) return html`<p class="muted small">Sin datos en el período.</p>`;
  return html`${items.map(i => html`<div class="hbar"><div class="hbar-label truncate" title="${i[etiqueta]}">${i[etiqueta]}</div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${raw((Number(i[valor] || 0) / max) * 100)}%;background:${raw(i.color || color)}"></div></div>
    <div class="hbar-val">${formato(i[valor])}</div></div>`)}`;
}
// Serie diaria completa (rellena días sin datos)
export function serieDias(filas, dias, campos) {
  const mapa = Object.fromEntries(filas.map(f => [String(f.dia).slice(0, 10), f]));
  const out = [];
  for (let i = dias - 1; i >= 0; i--) {
    const x = new Date(); x.setDate(x.getDate() - i);
    const k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const f = mapa[k] || {};
    out.push({ etiqueta: x.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' }).replace('.', ''), ...Object.fromEntries(campos.map(c => [c, Number(f[c] || 0)])) });
  }
  return out;
}

export function enlaceWa(numero) {
  const n = String(numero || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}` : null;
}

export const TIPO_ACTIVIDAD = {
  comentario: ['note', 'Nota', 'tone-muted'], llamada: ['phone', 'Llamada', 'tone-info'], reunion: ['calendar', 'Reunión', 'tone-primary'],
  email: ['mail', 'Correo', 'tone-info'], whatsapp: ['whatsapp', 'WhatsApp', 'tone-success'], visita: ['pin', 'Visita', 'tone-warning'],
  estado: ['kanban', 'Cambio de etapa', 'tone-primary'], tarea: ['checkSquare', 'Tarea', 'tone-success'], sistema: ['zap', 'Sistema', 'tone-muted'],
  mensaje: ['whatsapp', 'Mensaje', 'tone-success'], demo: ['calendar', 'Reunión', 'tone-primary'],
  proyecto: ['layers', 'Proyecto', 'tone-primary'],
};
export { esc };
