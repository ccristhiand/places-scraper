import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, etapas, etapaBadge, usuarios, opciones, debounce, $, $$, qs, cargando, menu, formModal } from '../core.js';
import { pager, camposUbigeo, enlazarUbigeo, formContacto, enlaceWa } from '../ui.js';
import { abrirContacto } from '../contacto.js';

const LIM = 25;
let st;

const WA = [['', 'WhatsApp: todos'], ['aptos', 'Con número apto'], ['wa_ok', 'WhatsApp activo'], ['no_wa', 'Sin WhatsApp'], ['sin_numero', 'Sin número'], ['ventana', 'Ventana 24 h abierta']];

export async function render(el, params) {
  st = { f: { sort: 'created_at', dir: 'desc' }, offset: 0, sel: new Set(), total: 0 };
  const [ets, us] = await Promise.all([etapas(true), can('contactos.ver_todos') ? usuarios() : []]);

  dibujar(el, html`
    <div class="page-head"><div><h1>Contactos</h1><p>Tu base de clientes y prospectos.</p></div>
      <div class="actions">
        ${can('contactos.exportar') ? html`<button class="btn" data-act="exportar">${icon('download', 'sm')} Exportar CSV</button>` : ''}
        ${can('prospeccion.buscar') ? html`<a class="btn" href="#/prospeccion">${icon('search', 'sm')} Prospectar</a>` : ''}
        ${can('contactos.crear') ? html`<button class="btn btn-primary" data-act="nuevo">${icon('plus', 'sm')} Nuevo contacto</button>` : ''}
      </div></div>
    <div class="toolbar" data-filtros>
      <div class="search">${icon('search', 'sm')}<input class="input" name="q" placeholder="Buscar por nombre, teléfono, correo o dirección…"></div>
      <select class="select" name="etapa">${opciones(ets.map(e => [e.clave, e.nombre]), '', { vacio: 'Todas las etapas' })}</select>
      ${us.length ? html`<select class="select" name="asignado">${opciones([['yo', 'Mis contactos'], ['sin', 'Sin asignar'], ...us.map(u => [u.id, u.nombre])], '', { vacio: 'Todos los vendedores' })}</select>` : ''}
      <select class="select" name="wa">${opciones(WA, '')}</select>
      <button class="btn" data-act="mas-filtros">${icon('filter', 'sm')} Más filtros</button>
    </div>
    <div class="toolbar hidden" data-extra>
      ${camposUbigeo()}
      <input class="input" name="rubro" placeholder="Rubro">
      <input class="input" name="etiqueta" placeholder="Etiqueta">
      <select class="select" name="origen">${opciones([['google', 'Google Places'], ['manual', 'Manual'], ['whatsapp', 'WhatsApp entrante'], ['lead', 'Lead web']], '', { vacio: 'Cualquier origen' })}</select>
      <button class="btn btn-ghost" data-act="limpiar">Limpiar filtros</button>
    </div>
    <div data-bulk></div>
    <div class="card"><div class="table-wrap" data-tabla>${cargando()}</div><div data-pager></div></div>`);

  const filtros = $('[data-filtros]', el), extra = $('[data-extra]', el);
  const leer = () => {
    const f = { sort: st.f.sort, dir: st.f.dir };
    $$('input[name],select[name]', filtros).concat($$('input[name],select[name]', extra)).forEach(i => { if (i.value) f[i.name === 'departamento' ? 'dep' : i.name === 'provincia' ? 'prov' : i.name === 'distrito' ? 'dist' : i.name] = i.value; });
    st.f = f; st.offset = 0; st.sel.clear(); cargar(el);
  };
  const leerD = debounce(leer, 300);
  filtros.addEventListener('input', e => e.target.name === 'q' ? leerD() : null);
  filtros.addEventListener('change', e => e.target.name !== 'q' && leer());
  extra.addEventListener('change', e => !e.target.dataset.ubi && leer());
  extra.addEventListener('input', e => ['rubro', 'etiqueta'].includes(e.target.name) && leerD());
  enlazarUbigeo(extra, leer);

  acciones(el, {
    nuevo: async () => { if (await formContacto(null, { onGuardado: id => abrirContacto(id, { onCambio: () => cargar(el) }) })) { toast('Contacto creado'); cargar(el); } },
    exportar: () => { location.href = `/api/contactos/export.csv?${qs(st.f)}`; },
    'mas-filtros': () => extra.classList.toggle('hidden'),
    limpiar: () => { $$('input,select', extra).forEach(i => { i.value = ''; }); $$('input,select', filtros).forEach(i => { i.value = ''; }); leer(); },
    abrir: a => abrirContacto(a.dataset.id, { onCambio: () => cargar(el) }),
    orden: th => { const c = th.dataset.col; st.f.dir = st.f.sort === c && st.f.dir === 'desc' ? 'asc' : 'desc'; st.f.sort = c; cargar(el); },
    prev: () => { st.offset = Math.max(0, st.offset - LIM); cargar(el); },
    next: () => { st.offset += LIM; cargar(el); },
    'sel-todos-filtro': async () => { const r = await api.get('/api/contactos/ids', st.f); r.ids.forEach(i => st.sel.add(i)); pintarBulk(el); $$('[data-sel]', el).forEach(c => { c.checked = true; }); },
    'sel-limpiar': () => { st.sel.clear(); $$('[data-sel],[data-sel-all]', el).forEach(c => { c.checked = false; }); pintarBulk(el); },
    'bulk-etapa': b => menu(b, ets.map(e => ({ label: e.nombre, onClick: () => masivo(el, 'etapa', e.clave, `mover a "${e.nombre}"`) })), { align: 'left' }),
    'bulk-asignar': async b => { const lista = await usuarios(); menu(b, [{ label: 'Sin asignar', onClick: () => masivo(el, 'asignar', '', 'quitar la asignación de') }, '-', ...lista.map(u => ({ label: u.nombre, onClick: () => masivo(el, 'asignar', u.id, `asignar a ${u.nombre}`) }))], { align: 'left' }); },
    'bulk-etiqueta': () => formModal({ title: 'Agregar etiqueta', size: 'sm', submit: 'Agregar',
      fields: html`<label class="field span-2"><span>Etiqueta</span><input class="input" name="valor" required maxlength="40" placeholder="ej. vip"></label>`,
      onSubmit: d => masivo(el, 'etiqueta', d.valor, `etiquetar como "${d.valor}"`, false) }),
    'bulk-eliminar': () => masivo(el, 'eliminar', null, 'ELIMINAR', true),
    'bulk-enviar': () => { sessionStorage.setItem('envio_ids', JSON.stringify([...st.sel])); location.hash = '#/campanas/nueva'; },
  });
  el.addEventListener('change', e => {
    if (e.target.matches('[data-sel]')) { const id = +e.target.dataset.sel; e.target.checked ? st.sel.add(id) : st.sel.delete(id); pintarBulk(el); }
    if (e.target.matches('[data-sel-all]')) { $$('[data-sel]', el).forEach(c => { c.checked = e.target.checked; const id = +c.dataset.sel; c.checked ? st.sel.add(id) : st.sel.delete(id); }); pintarBulk(el); }
  });

  await cargar(el);
  if (params[0]) abrirContacto(params[0], { onCambio: () => cargar(el) });
}

async function masivo(el, accion, valor, texto, peligro = false) {
  const n = st.sel.size;
  if (!(await confirmar(`Vas a ${texto} ${fmt.num(n)} contacto(s).${accion === 'eliminar' ? ' Esta acción no se puede deshacer.' : ''}`, { titulo: 'Acción masiva', ok: 'Continuar', peligro }))) return false;
  try {
    const r = await api.post('/api/contactos/masivo', { ids: [...st.sel], accion, valor });
    toast(`${fmt.num(r.afectados)} contacto(s) actualizados`);
    st.sel.clear(); cargar(el);
  } catch (e) { toastError(e); return false; }
}

function pintarBulk(el) {
  const n = st.sel.size;
  dibujar($('[data-bulk]', el), n ? html`<div class="bulkbar">${fmt.num(n)} seleccionado(s)
    ${st.total > n ? html`<button class="btn btn-xs btn-ghost" data-act="sel-todos-filtro">Seleccionar los ${fmt.num(st.total)} filtrados</button>` : ''}
    <div class="row wrap right">
      ${can('campanas.gestionar') ? html`<button class="btn btn-sm btn-success" data-act="bulk-enviar">${icon('send', 'sm')} Enviar campaña</button>` : ''}
      ${can('pipeline.mover') ? html`<button class="btn btn-sm" data-act="bulk-etapa">${icon('kanban', 'sm')} Mover etapa</button>` : ''}
      ${can('contactos.asignar') ? html`<button class="btn btn-sm" data-act="bulk-asignar">${icon('user', 'sm')} Asignar</button>` : ''}
      ${can('contactos.editar') ? html`<button class="btn btn-sm" data-act="bulk-etiqueta">${icon('tag', 'sm')} Etiquetar</button>` : ''}
      ${can('contactos.eliminar') ? html`<button class="btn btn-sm btn-danger" data-act="bulk-eliminar">${icon('trash', 'sm')}</button>` : ''}
      <button class="btn btn-sm btn-ghost" data-act="sel-limpiar">${icon('x', 'sm')}</button></div></div>` : '');
}

async function cargar(el) {
  const tabla = $('[data-tabla]', el);
  try {
    const r = await api.get('/api/contactos', { ...st.f, limit: LIM, offset: st.offset });
    st.total = r.total;
    const th = (col, t) => html`<th class="sortable" data-act="orden" data-col="${col}">${t}${st.f.sort === col ? (st.f.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`;
    dibujar(tabla, r.rows.length ? html`<table class="table"><thead><tr>
        <th class="w-check"><input type="checkbox" class="check" data-sel-all aria-label="Seleccionar página"></th>
        ${th('nombre', 'Contacto')}<th>WhatsApp / Teléfono</th>${th('distrito', 'Ubicación')}${th('estado_crm', 'Etapa')}
        <th class="hide-mobile">Vendedor</th>${th('valor', 'Valor')}${th('actividad', 'Actividad')}</tr></thead>
      <tbody>${r.rows.map(c => {
        const wa = c.whatsapp || c.telefono_int;
        return html`<tr class="clickable" data-act="abrir" data-id="${c.id}">
          <td class="w-check" data-act="noop"><input type="checkbox" data-sel="${c.id}" ${st.sel.has(c.id) ? raw('checked') : ''} aria-label="Seleccionar"></td>
          <td style="min-width:220px"><div class="strong">${c.nombre}</div><div class="xs muted">${[c.contacto_nombre, c.rubro_busqueda].filter(Boolean).join(' · ')}${c.etiquetas ? html` ${c.etiquetas.split(',').slice(0, 3).map(t => html`<span class="tag">${t}</span> `)}` : ''}</div></td>
          <td class="nowrap">${wa ? html`<a href="${enlaceWa(wa)}" target="_blank" rel="noopener noreferrer" data-act="noop">${wa}</a>` : html`<span class="muted">${c.telefono || '—'}</span>`}
            ${c.wa_verificado === 0 ? html` <span class="badge danger" title="El número no tiene WhatsApp">sin WA</span>` : ''}</td>
          <td class="small">${c.distrito || '—'}<div class="xs muted">${c.provincia || ''}</div></td>
          <td>${etapaBadge(c.estado_crm)}</td>
          <td class="small hide-mobile">${c.asignado_nombre || html`<span class="muted">—</span>`}</td>
          <td class="nowrap small">${c.valor_estimado ? fmt.moneda(c.valor_estimado) : '—'}</td>
          <td class="small muted nowrap">${fmt.relativo(c.ultima_actividad_at || c.created_at)}</td></tr>`;
      })}</tbody></table>`
      : vacio({ icono: 'users', titulo: 'No hay contactos', texto: 'Prueba con otros filtros, importa negocios desde Prospección o crea uno manualmente.',
          accion: can('prospeccion.buscar') ? html`<a class="btn btn-primary" href="#/prospeccion">${icon('search', 'sm')} Ir a Prospección</a>` : '' }));
    dibujar($('[data-pager]', el), r.total > LIM ? pager(r.total, st.offset, LIM) : '');
    pintarBulk(el);
  } catch (e) { toastError(e); }
}
