// Suscripciones SaaS (registro manual para trazabilidad): clientes con plan mensual / trimestral / anual,
// integraciones adicionales y pagos por periodo. Nada se genera ni cambia solo: los periodos se calculan
// por fecha y cada uno tiene su botón para registrar el pago.
import { html, raw, icon, api, render as dibujar, acciones, can, vacio, toast, toastError, $, $$, cargando, opciones, usuarios, debounce,
  modal, formModal, confirmar, menu, fmt, session, conCarga } from '../core.js';
import { campoContacto, enlazarContacto } from '../ui.js';

const ESTADOS = { activa: ['success', 'Activa'], suspendida: ['warning', 'Suspendida'], cancelada: ['', 'Cancelada'] };
const CICLOS = { mensual: 'Mensual', trimestral: 'Trimestral', anual: 'Anual' };
const MESES = { mensual: 1, trimestral: 3, anual: 12 };
const METODOS = { transferencia: 'Transferencia', yape: 'Yape', plin: 'Plin', efectivo: 'Efectivo', tarjeta: 'Tarjeta', otro: 'Otro' };
const ESTADO_PERIODO = { pagado: ['success', 'Pagado'], parcial: ['warning', 'Pago parcial'], sin_pago: ['danger', 'Sin pago'], futuro: ['', 'Próximo'] };

const dinero = (v, moneda = 'PEN') => Number(v || 0).toLocaleString('es-PE', { style: 'currency', currency: moneda, maximumFractionDigits: 2, minimumFractionDigits: 0 });
const fechaCorta = s => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const mesAnio = s => new Date(`${s}T12:00:00`).toLocaleDateString('es-PE', { month: 'long', year: 'numeric' });
const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const estadoBadge = e => { const [t, n] = ESTADOS[e] || ['', e]; return html`<span class="badge ${t}">${n}</span>`; };
const porMoneda = obj => Object.entries(obj || {}).map(([m, v]) => dinero(v, m)).join(' + ') || dinero(0);
// "YYYY-MM-DD" + n meses respetando el día base (igual que el servidor)
function sumarMeses(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + n, anio = y + Math.floor(total / 12), mes = ((total % 12) + 12) % 12;
  const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  return `${anio}-${String(mes + 1).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}
const finPeriodo = (inicio, ciclo) => { const x = new Date(`${sumarMeses(inicio, MESES[ciclo] || 1)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
const nombrePeriodo = (p, ciclo) => (ciclo === 'mensual' ? mesAnio(p.inicio) : `${fechaCorta(p.inicio)} – ${fechaCorta(p.fin)}`);

let st;

export async function render(el, params) {
  st = { tab: 'lista', f: { estado: 'activa' }, rows: [], catalogo: null, pagosF: {} };
  const montos = can('suscripciones.cobros');
  dibujar(el, html`
    <div class="page-head"><div><h1>Suscripciones</h1><p>Registro de los clientes de tus productos SaaS: plan, integraciones y pagos por periodo.</p></div>
      <div class="actions"><div class="seg">
        <button data-act="tab" data-tab="lista">${icon('list', 'sm')} Suscripciones</button>
        ${montos ? html`<button data-act="tab" data-tab="pagos">${icon('dollar', 'sm')} Pagos</button>` : ''}
        <button data-act="tab" data-tab="catalogo">${icon('layers', 'sm')} Planes e integraciones</button></div>
      ${can('suscripciones.gestionar') ? html`<button class="btn btn-primary" data-act="nueva">${icon('plus', 'sm')} Nueva suscripción</button>` : ''}</div></div>
    <div data-cont>${cargando()}</div>`);

  const recargar = () => pintarTab(el);
  const nueva = () => formSuscripcion(null, { onGuardado: id => { recargar(); abrirSuscripcion(id, { onCambio: recargar }); } });
  acciones(el, {
    tab: b => { st.tab = b.dataset.tab; recargar(); },
    nueva,
    abrir: b => abrirSuscripcion(b.dataset.id, { onCambio: recargar }),
    kpi: b => { st.f.estado = b.dataset.estado; const s = $('[data-f="estado"]', el); if (s) s.value = st.f.estado; cargarLista(el); },
    'producto-nuevo': () => formProducto(null, recargar),
    'producto-editar': b => formProducto(st.catalogo.productos.find(p => p.id === +b.dataset.id), recargar),
    'producto-borrar': b => borrar(`/api/suscripciones/productos/${b.dataset.id}`, '¿Eliminar este producto y sus planes?', recargar),
    'plan-nuevo': b => formPlan(null, +b.dataset.producto, recargar),
    'plan-editar': b => formPlan(st.catalogo.planes.find(p => p.id === +b.dataset.id), null, recargar),
    'plan-borrar': b => borrar(`/api/suscripciones/planes/${b.dataset.id}`, '¿Eliminar este plan?', recargar),
    'int-nueva': () => formIntegracion(null, recargar),
    'int-editar': b => formIntegracion(st.catalogo.integraciones.find(i => i.id === +b.dataset.id), recargar),
    'int-borrar': b => borrar(`/api/suscripciones/integraciones/${b.dataset.id}`, '¿Eliminar esta integración?', recargar),
  });
  el.addEventListener('change', e => {
    if (e.target.dataset.f) { st.f[e.target.dataset.f] = e.target.value; cargarLista(el); }
    if (e.target.dataset.pf) { st.pagosF[e.target.dataset.pf] = e.target.value; cargarPagos(el); }
  });
  el.addEventListener('input', debounce(e => { if (e.target.matches('[data-q]')) { st.f.q = e.target.value; cargarLista(el); } }, 300));

  await pintarTab(el);
  if (params[0] === 'nueva' && can('suscripciones.gestionar')) nueva();
  else if (params[0]) abrirSuscripcion(params[0], { onCambio: recargar });
}

async function borrar(url, pregunta, despues) {
  if (!(await confirmar(pregunta, { ok: 'Eliminar', peligro: true }))) return;
  try {
    const r = await api.del(url);
    toast(r.desactivado ? 'Está en uso: se desactivó en lugar de eliminarse' : 'Eliminado', r.desactivado ? 'info' : 'success');
    despues();
  } catch (e) { toastError(e); }
}

async function catalogo(forzar = false) {
  if (!st?.catalogo || forzar) {
    const c = await api.get('/api/suscripciones/catalogo');
    if (!st) return c;
    st.catalogo = c;
  }
  return st.catalogo;
}

async function pintarTab(el) {
  $$('[data-act="tab"]', el).forEach(b => b.classList.toggle('active', b.dataset.tab === st.tab));
  const cont = $('[data-cont]', el);
  if (st.tab === 'lista') {
    const prods = (await catalogo(true).catch(() => ({ productos: [] }))).productos;
    dibujar(cont, html`<div class="grid c4 mb" data-kpis></div>
      <div class="toolbar">
        <div class="search">${icon('search', 'sm')}<input class="input" data-q placeholder="Buscar por cliente, código o plan…" value="${st.f.q || ''}"></div>
        <select class="select" data-f="estado">${opciones(Object.entries(ESTADOS).map(([k, v]) => [k, v[1]]), st.f.estado, { vacio: 'Todos los estados' })}</select>
        ${prods.length > 1 ? html`<select class="select" data-f="producto_id">${opciones(prods.map(p => [p.id, p.nombre]), st.f.producto_id, { vacio: 'Todos los productos' })}</select>` : ''}
      </div><div data-lista>${cargando()}</div>`);
    return cargarLista(el);
  }
  if (st.tab === 'pagos') {
    dibujar(cont, html`<div class="toolbar"><label class="row small">Desde <input class="input" type="date" data-pf="desde" value="${st.pagosF.desde || ''}"></label>
      <label class="row small">Hasta <input class="input" type="date" data-pf="hasta" value="${st.pagosF.hasta || ''}"></label></div><div data-lista>${cargando()}</div>`);
    return cargarPagos(el);
  }
  dibujar(cont, cargando());
  try { await catalogo(true); pintarCatalogo(cont); } catch (e) { toastError(e); }
}

// ── Lista ─────────────────────────────────────────────────────────────────
async function cargarLista(el) {
  try {
    const r = await api.get('/api/suscripciones', st.f);
    st.rows = r.rows;
    const k = r.resumen, montos = can('suscripciones.cobros');
    const kpi = (label, valor, sub, estado, tono = '') => html`<a href="#" class="card kpi" ${estado ? raw(`data-act="kpi" data-estado="${estado}"`) : ''} style="color:inherit;text-decoration:none">
      <div><div class="kpi-label">${label}</div><div class="kpi-value" style="${tono}">${valor}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div></a>`;
    dibujar($('[data-kpis]', el), html`
      ${kpi('Activas', k.activas, 'Suscripciones vigentes', 'activa')}
      ${montos ? kpi('Ingreso mensual', porMoneda(k.mrr), 'Equivalente mensual de las activas') : ''}
      ${montos ? kpi('Cobrado este mes', porMoneda(k.cobrado_mes), 'Pagos registrados') : ''}
      ${kpi('Con periodos sin pago', k.con_periodos_sin_pago, 'Solo informativo', null, k.con_periodos_sin_pago ? 'color:var(--warning)' : '')}`);
    pintarLista(el);
  } catch (e) { toastError(e); }
}

function pintarLista(el) {
  const lista = $('[data-lista]', el), montos = can('suscripciones.cobros');
  if (!st.rows.length) {
    const sinCatalogo = !st.catalogo?.planes?.length;
    dibujar(lista, html`<div class="card">${vacio({ icono: 'refresh', titulo: 'Sin suscripciones',
      texto: sinCatalogo ? 'Primero crea tu producto SaaS y sus planes en "Planes e integraciones".' : 'Registra qué plan tiene cada cliente y lleva el control de sus pagos.',
      accion: can('suscripciones.gestionar') ? (sinCatalogo ? html`<button class="btn btn-primary" data-act="tab" data-tab="catalogo">${icon('layers', 'sm')} Crear planes</button>`
        : html`<button class="btn btn-primary" data-act="nueva">${icon('plus', 'sm')} Nueva suscripción</button>`) : '' })}</div>`);
    return;
  }
  dibujar(lista, html`<div class="card"><div class="table-wrap"><table class="table"><thead><tr>
      <th>Cliente</th><th>Plan</th><th>Estado</th><th>Pagado hasta</th>${montos ? html`<th>Monto</th><th>Total pagado</th>` : ''}<th class="hide-mobile">Responsable</th></tr></thead><tbody>
    ${st.rows.map(s => { const ints = s.integraciones.filter(i => Number(i.activo));
      return html`<tr class="clickable" data-act="abrir" data-id="${s.id}">
      <td><div class="strong">${s.cliente}</div><div class="xs muted mono">${s.codigo}</div></td>
      <td><div class="small">${s.producto_nombre} · <b>${s.plan_nombre}</b></div><div class="xs muted">${CICLOS[s.ciclo]}${ints.length ? ` · ${ints.map(i => i.nombre).join(', ')}` : ''}</div></td>
      <td>${estadoBadge(s.estado)}</td>
      <td class="small nowrap">${s.pagado_hasta ? fechaCorta(s.pagado_hasta) : html`<span class="muted">Sin pagos</span>`}
        ${s.estado === 'activa' && s.periodos_sin_pago ? html`<div class="xs" style="color:var(--warning)">${s.periodos_sin_pago} periodo(s) sin pago</div>` : ''}</td>
      ${montos ? html`<td class="small num nowrap">${dinero(s.monto_ciclo, s.moneda)}<div class="xs muted">${s.ciclo !== 'mensual' ? `${dinero(s.mensual, s.moneda)}/mes` : 'al mes'}</div></td>
        <td class="small num nowrap">${dinero(s.total_pagado, s.moneda)}</td>` : ''}
      <td class="small hide-mobile">${s.responsable_nombre || '—'}</td></tr>`; })}
  </tbody></table></div></div>`);
}

// ── Pagos (todas las suscripciones) ───────────────────────────────────────
async function cargarPagos(el) {
  const lista = $('[data-lista]', el);
  try {
    const { rows } = await api.get('/api/suscripciones/pagos', st.pagosF);
    if (!rows.length) { dibujar(lista, html`<div class="card">${vacio({ icono: 'dollar', titulo: 'Sin pagos', texto: 'Registra los pagos desde la ficha de cada suscripción.' })}</div>`); return; }
    const totales = rows.reduce((a, x) => { a[x.moneda] = r2((a[x.moneda] || 0) + x.monto); return a; }, {});
    dibujar(lista, html`<div class="card"><div class="card-head"><h3>${rows.length} pago(s)</h3><span class="small">Total: <b>${porMoneda(totales)}</b></span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Cliente</th><th>Periodo</th><th>Monto</th><th>Método</th><th></th></tr></thead><tbody>
      ${rows.map(x => html`<tr><td class="small nowrap">${fechaCorta(x.fecha)}</td>
        <td><a href="#" class="strong" data-act="abrir" data-id="${x.suscripcion_id}">${x.cliente}</a><div class="xs muted">${x.codigo} · ${x.plan_nombre}</div></td>
        <td class="small nowrap">${fechaCorta(x.periodo_inicio)} – ${fechaCorta(x.periodo_fin)}</td>
        <td class="small num">${dinero(x.monto, x.moneda)}</td>
        <td class="small">${METODOS[x.metodo] || x.metodo}${x.referencia ? html`<div class="xs muted">${x.referencia}</div>` : ''}</td>
        <td>${x.comprobante_url ? html`<a class="btn btn-xs" href="${x.comprobante_url}" target="_blank" rel="noopener">${icon('image', 'sm')}</a>` : ''}</td></tr>`)}
      </tbody></table></div></div>`);
  } catch (e) { toastError(e); }
}

// ── Catálogo ──────────────────────────────────────────────────────────────
function pintarCatalogo(cont) {
  const { productos, planes, integraciones } = st.catalogo;
  const montos = can('suscripciones.cobros');
  const gestion = can('suscripciones.gestionar') && montos;
  dibujar(cont, html`
    <div class="row between mb"><p class="small muted">Tus productos SaaS con sus planes y las integraciones que se venden aparte (ej. API RENIEC).</p>
      ${gestion ? html`<button class="btn" data-act="producto-nuevo">${icon('plus', 'sm')} Producto</button>` : ''}</div>
    ${productos.length ? productos.map(pr => { const ps = planes.filter(p => p.producto_id === pr.id);
      return html`<div class="card mb"><div class="card-head"><div><h3>${pr.nombre} ${Number(pr.activo) ? '' : html`<span class="badge">Inactivo</span>`}</h3>
          ${pr.descripcion ? html`<div class="xs muted" style="margin-top:2px">${pr.descripcion}</div>` : ''}</div>
        ${gestion ? html`<div class="row"><button class="btn btn-sm btn-primary" data-act="plan-nuevo" data-producto="${pr.id}">${icon('plus', 'sm')} Plan</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="producto-editar" data-id="${pr.id}" aria-label="Editar">${icon('edit', 'sm')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="producto-borrar" data-id="${pr.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button></div>` : ''}</div>
        ${ps.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Plan</th>${montos ? html`<th>Mensual</th><th>Trimestral</th><th>Anual</th>` : ''}<th>Clientes</th><th></th></tr></thead><tbody>
          ${ps.map(p => html`<tr><td><div class="strong">${p.nombre} ${Number(p.activo) ? '' : html`<span class="badge">Inactivo</span>`}</div>${p.incluye ? html`<div class="xs muted" style="white-space:pre-wrap">${p.incluye}</div>` : ''}</td>
            ${montos ? html`<td class="small num">${dinero(p.precio_mensual, p.moneda)}</td>
              <td class="small num">${p.precio_trimestral !== null ? dinero(p.precio_trimestral, p.moneda) : html`<span class="muted">${dinero(p.precio_mensual * 3, p.moneda)}</span>`}</td>
              <td class="small num">${p.precio_anual !== null ? dinero(p.precio_anual, p.moneda) : html`<span class="muted">${dinero(p.precio_mensual * 12, p.moneda)}</span>`}</td>` : ''}
            <td class="small">${p.en_uso}</td>
            <td class="nowrap">${gestion ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="plan-editar" data-id="${p.id}" aria-label="Editar">${icon('edit', 'sm')}</button>
              <button class="btn btn-ghost btn-xs btn-icon" data-act="plan-borrar" data-id="${p.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</td></tr>`)}
          </tbody></table></div>` : html`<div class="card-body small muted">Sin planes. Agrega por ejemplo Básico, Profesional y Empresarial.</div>`}</div>`; })
      : html`<div class="card mb">${vacio({ icono: 'layers', titulo: 'Sin productos', texto: 'Crea tu primer producto SaaS (ej. VetZen) y luego sus planes.',
          accion: gestion ? html`<button class="btn btn-primary" data-act="producto-nuevo">${icon('plus', 'sm')} Crear producto</button>` : '' })}</div>`}

    <div class="card"><div class="card-head"><div><h3>${icon('zap', 'sm')} Integraciones</h3><div class="xs muted" style="margin-top:2px">Adicionales que se suman a la suscripción de cada cliente.</div></div>
      ${gestion ? html`<button class="btn btn-sm btn-primary" data-act="int-nueva">${icon('plus', 'sm')} Integración</button>` : ''}</div>
      ${integraciones.length ? integraciones.map(i => html`<div class="list-item"><div class="grow">
          <div class="strong">${i.nombre} ${Number(i.activo) ? '' : html`<span class="badge">Inactiva</span>`} <span class="xs muted">· ${i.producto_id ? (productos.find(p => p.id === i.producto_id)?.nombre || '') : 'todos los productos'}</span></div>
          ${i.descripcion ? html`<div class="xs muted">${i.descripcion}</div>` : ''}
          <div class="xs muted">${montos ? `${dinero(i.precio_mensual)}/mes · ` : ''}${i.en_uso} cliente(s)</div></div>
        ${gestion ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="int-editar" data-id="${i.id}" aria-label="Editar">${icon('edit', 'sm')}</button>
          <button class="btn btn-ghost btn-xs btn-icon" data-act="int-borrar" data-id="${i.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</div>`)
        : html`<div class="card-body small muted">Sin integraciones. Ej.: "API RENIEC" a S/ 30 al mes.</div>`}</div>`);
}

function formProducto(p, despues) {
  return formModal({
    title: p ? 'Editar producto' : 'Nuevo producto', size: 'sm',
    fields: html`<label class="field span-2"><span>Nombre *</span><input class="input" name="nombre" required maxlength="120" value="${p?.nombre || ''}" placeholder="Ej. VetZen"></label>
      <label class="field span-2"><span>Descripción</span><textarea class="input" name="descripcion" rows="2">${p?.descripcion || ''}</textarea></label>
      <label class="field span-2"><span>Sitio web</span><input class="input" name="url" value="${p?.url || ''}" placeholder="https://"></label>
      ${p ? html`<label class="check span-2"><input type="checkbox" name="activo" ${Number(p.activo) ? raw('checked') : ''}> Activo (disponible para nuevas suscripciones)</label>` : ''}`,
    onSubmit: async d => {
      if (p) await api.put(`/api/suscripciones/productos/${p.id}`, { ...d, activo: d.activo ? 1 : 0 });
      else await api.post('/api/suscripciones/productos', d);
      toast('Producto guardado'); despues();
    },
  }).done;
}

function formPlan(p, productoId, despues) {
  const v = p || { moneda: session.moneda === 'USD' ? 'USD' : 'PEN', activo: 1 };
  return formModal({
    title: p ? `Editar plan ${p.nombre}` : 'Nuevo plan',
    fields: html`<label class="field"><span>Nombre *</span><input class="input" name="nombre" required maxlength="80" value="${v.nombre || ''}" placeholder="Ej. Profesional"></label>
      <label class="field"><span>Moneda</span><select class="select" name="moneda">${opciones([['PEN', 'Soles (S/)'], ['USD', 'Dólares (US$)']], v.moneda)}</select></label>
      <label class="field"><span>Precio mensual *</span><input class="input" type="number" name="precio_mensual" min="0.01" step="0.01" required value="${v.precio_mensual ?? ''}"></label>
      <label class="field"><span>Orden</span><input class="input" type="number" name="orden" min="0" value="${v.orden ?? 0}"></label>
      <label class="field"><span>Precio trimestral</span><input class="input" type="number" name="precio_trimestral" min="0" step="0.01" value="${v.precio_trimestral ?? ''}" placeholder="Vacío = mensual × 3"></label>
      <label class="field"><span>Precio anual</span><input class="input" type="number" name="precio_anual" min="0" step="0.01" value="${v.precio_anual ?? ''}" placeholder="Vacío = mensual × 12"></label>
      <label class="field span-2"><span>Qué incluye</span><textarea class="input" name="incluye" rows="3" placeholder="Usuarios, sedes, módulos…">${v.incluye || ''}</textarea></label>
      ${p ? html`<label class="check span-2"><input type="checkbox" name="activo" ${Number(v.activo) ? raw('checked') : ''}> Activo (disponible para nuevas suscripciones)</label>` : ''}`,
    onSubmit: async d => {
      if (p) await api.put(`/api/suscripciones/planes/${p.id}`, { ...d, activo: d.activo ? 1 : 0 });
      else await api.post('/api/suscripciones/planes', { ...d, producto_id: productoId });
      toast('Plan guardado'); despues();
    },
  }).done;
}

function formIntegracion(i, despues) {
  const prods = st.catalogo.productos;
  return formModal({
    title: i ? `Editar ${i.nombre}` : 'Nueva integración',
    fields: html`<label class="field span-2"><span>Nombre *</span><input class="input" name="nombre" required maxlength="120" value="${i?.nombre || ''}" placeholder="Ej. API RENIEC"></label>
      <label class="field"><span>Disponible para</span><select class="select" name="producto_id">${opciones(prods.map(p => [p.id, p.nombre]), i?.producto_id, { vacio: 'Todos los productos' })}</select></label>
      <label class="field"><span>Precio mensual</span><input class="input" type="number" name="precio_mensual" min="0" step="0.01" value="${i?.precio_mensual ?? ''}" placeholder="0.00"></label>
      <label class="field span-2"><span>Descripción</span><textarea class="input" name="descripcion" rows="2" placeholder="Qué hace, límites de consultas…">${i?.descripcion || ''}</textarea></label>
      ${i ? html`<label class="check span-2"><input type="checkbox" name="activo" ${Number(i.activo) ? raw('checked') : ''}> Activa</label>` : ''}`,
    onSubmit: async d => {
      if (i) await api.put(`/api/suscripciones/integraciones/${i.id}`, { ...d, activo: d.activo ? 1 : 0 });
      else await api.post('/api/suscripciones/integraciones', d);
      toast('Integración guardada'); despues();
    },
  }).done;
}

// ── Formulario de suscripción ─────────────────────────────────────────────
function calcular(ciclo, plan, especial, pct, ints) {
  const m = MESES[ciclo];
  const base = especial !== '' && especial !== null && especial !== undefined ? r2(especial)
    : ciclo === 'trimestral' && plan.precio_trimestral !== null ? r2(plan.precio_trimestral)
    : ciclo === 'anual' && plan.precio_anual !== null ? r2(plan.precio_anual) : r2(plan.precio_mensual * m);
  const lineas = [[`Plan ${plan.nombre} (${CICLOS[ciclo].toLowerCase()})`, base], ...ints.map(i => [`${i.nombre}${m > 1 ? ` × ${m}` : ''}`, r2(i.precio * m)])];
  const bruto = r2(lineas.reduce((t, l) => t + l[1], 0));
  const desc = r2(bruto * Math.min(100, Math.max(0, Number(pct) || 0)) / 100);
  if (desc) lineas.push([`Descuento ${pct} %`, -desc]);
  return { lineas, total: r2(bruto - desc), mensual: r2((bruto - desc) / m) };
}

export async function formSuscripcion(s = null, { negocio = null, onGuardado } = {}) {
  const [cat, us] = await Promise.all([catalogo(!s), usuarios()]);
  const montos = can('suscripciones.cobros');
  const planesActivos = cat.planes.filter(p => Number(p.activo) || p.id === s?.plan_id);
  if (!planesActivos.length) { toast('Primero crea un producto y sus planes en Suscripciones → Planes e integraciones.', 'warning'); return; }
  const prevNeg = negocio ? { ...negocio, fijo: true } : (s ? { id: s.negocio_id, nombre: s.cliente, fijo: true } : null);
  const v = s || { ciclo: 'mensual', descuento_pct: 0, fecha_inicio: hoyISO() };
  const productoIni = s ? s.producto_id : planesActivos[0].producto_id;

  return formModal({
    title: s ? `Editar ${s.codigo}` : 'Nueva suscripción', size: 'lg', submit: s ? 'Guardar cambios' : 'Registrar suscripción',
    fields: html`
      ${campoContacto('negocio_id', prevNeg, 'Cliente *')}
      <label class="field"><span>Producto</span><select class="select" name="producto">${opciones(cat.productos.filter(p => Number(p.activo) || p.id === productoIni).map(p => [p.id, p.nombre]), productoIni)}</select></label>
      <label class="field"><span>Plan *</span><select class="select" name="plan_id" required></select></label>
      <label class="field"><span>Ciclo de pago</span><select class="select" name="ciclo">${opciones(Object.entries(CICLOS), v.ciclo)}</select></label>
      <label class="field"><span>Fecha de inicio</span><input class="input" type="date" name="fecha_inicio" value="${v.fecha_inicio}"><span class="hint">Los periodos se cuentan desde esta fecha.</span></label>
      <label class="field"><span>Responsable</span><select class="select" name="responsable_id">${opciones(us, v.responsable_id || session.user.id)}</select></label>
      <div></div>
      <div class="span-2"><div class="divider" style="margin:4px 0 10px"></div><span class="label">Integraciones adicionales</span><div data-ints class="stack sm" style="margin-top:6px"></div></div>
      ${montos ? html`<div class="span-2 divider" style="margin:4px 0"></div>
        <label class="field"><span>Precio especial del plan (por ciclo)</span><input class="input" type="number" name="precio_especial" min="0" step="0.01" value="${v.precio_especial ?? ''}" placeholder="Vacío = precio del plan"></label>
        <label class="field"><span>Descuento %</span><input class="input" type="number" name="descuento_pct" min="0" max="100" step="0.5" value="${Number(v.descuento_pct) || 0}"></label>
        <label class="check span-2"><input type="checkbox" name="incluye_igv" ${s ? (Number(s.incluye_igv) ? raw('checked') : '') : raw('checked')}> Los precios incluyen IGV</label>
        <div class="span-2" data-resumen></div>` : ''}
      <label class="field span-2"><span>Notas</span><textarea class="input" name="notas" rows="2" placeholder="Acuerdos, dominio, cantidad de usuarios…">${v.notas || ''}</textarea></label>`,

    onMount: (m, form) => {
      enlazarContacto(form);
      if (negocio) form.negocio_id.value = negocio.id;
      if (s) form.negocio_id.value = s.negocio_id;
      const elegidas = new Map();
      const pintarPlanes = () => {
        const pid = Number(form.producto.value);
        const ps = planesActivos.filter(p => p.producto_id === pid);
        dibujar(form.plan_id, opciones(ps.map(p => [p.id, montos ? `${p.nombre} · ${dinero(p.precio_mensual, p.moneda)}/mes` : p.nombre]), s?.plan_id || ps[0]?.id));
      };
      const pintarInts = () => {
        const cont = $('[data-ints]', form);
        if (s) { dibujar(cont, html`<p class="small muted">Las integraciones se agregan o quitan desde la ficha de la suscripción.</p>`); return; }
        const pid = Number(form.producto.value);
        const ints = cat.integraciones.filter(i => Number(i.activo) && (!i.producto_id || i.producto_id === pid));
        dibujar(cont, ints.length ? html`${ints.map(i => html`<div class="row">
          <label class="check grow"><input type="checkbox" data-int="${i.id}" ${elegidas.has(i.id) ? raw('checked') : ''}> ${i.nombre}
            ${montos ? html`<span class="xs muted">${dinero(i.precio_mensual)}/mes</span>` : ''}</label>
          ${montos ? html`<input class="input sm" type="number" min="0" step="0.01" data-int-precio="${i.id}" value="${elegidas.get(i.id)?.precio ?? i.precio_mensual}" style="width:120px" title="Precio mensual para este cliente" ${elegidas.has(i.id) ? '' : raw('disabled')}>` : ''}</div>`)}`
          : html`<p class="small muted">No hay integraciones para este producto.</p>`);
      };
      const resumen = () => {
        const box = $('[data-resumen]', form);
        if (!box) return;
        const plan = cat.planes.find(p => p.id === Number(form.plan_id.value));
        if (!plan) { dibujar(box, ''); return; }
        const ints = s ? (s.integraciones || []).filter(i => Number(i.activo)).map(i => ({ nombre: i.nombre, precio: Number(i.precio_mensual) || 0 }))
          : [...elegidas.entries()].map(([id, x]) => ({ nombre: cat.integraciones.find(y => y.id === id).nombre, precio: Number(x.precio) || 0 }));
        const c = calcular(form.ciclo.value, plan, form.precio_especial.value, form.descuento_pct.value, ints);
        dibujar(box, html`<div class="alert info small">${icon('dollar', 'sm')}<div class="grow">
          ${c.lineas.map(([t, x]) => html`<div class="row between"><span>${t}</span><span class="num">${dinero(x, plan.moneda)}</span></div>`)}
          <div class="row between strong" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>Monto por periodo (${CICLOS[form.ciclo.value].toLowerCase()})</span><span class="num">${dinero(c.total, plan.moneda)}</span></div>
          ${form.ciclo.value !== 'mensual' ? html`<div class="xs muted">Equivale a ${dinero(c.mensual, plan.moneda)} al mes.</div>` : ''}</div></div>`);
      };
      form.addEventListener('change', e => {
        const t = e.target;
        if (t.name === 'producto') { elegidas.clear(); pintarPlanes(); pintarInts(); }
        if (t.dataset.int) {
          const id = Number(t.dataset.int), precio = $(`[data-int-precio="${id}"]`, form);
          if (t.checked) elegidas.set(id, { precio: precio ? precio.value : cat.integraciones.find(i => i.id === id).precio_mensual });
          else elegidas.delete(id);
          if (precio) precio.disabled = !t.checked;
        }
        resumen();
      });
      form.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.intPrecio && elegidas.has(Number(t.dataset.intPrecio))) elegidas.get(Number(t.dataset.intPrecio)).precio = t.value;
        resumen();
      });
      m.elegidas = elegidas;
      pintarPlanes(); pintarInts(); resumen();
    },

    onSubmit: async (d, form, m) => {
      if (!d.negocio_id) throw new Error('Elige el cliente de la lista.');
      const body = { negocio_id: d.negocio_id, plan_id: d.plan_id, ciclo: d.ciclo, fecha_inicio: d.fecha_inicio, responsable_id: d.responsable_id, notas: d.notas };
      if (montos) Object.assign(body, { precio_especial: d.precio_especial, descuento_pct: d.descuento_pct, incluye_igv: d.incluye_igv ? 1 : 0 });
      if (!s) body.integraciones = [...m.elegidas.entries()].map(([id, x]) => ({ integracion_id: id, precio_mensual: x.precio }));
      const r = s ? await api.put(`/api/suscripciones/${s.id}`, body) : await api.post('/api/suscripciones', body);
      toast(s ? 'Suscripción actualizada' : `Suscripción ${r.codigo} registrada`);
      onGuardado?.(s ? s.id : r.id);
      return r;
    },
  }).done;
}

// ── Registrar pago de un periodo ──────────────────────────────────────────
// periodo: { inicio, fin, monto, pagado } (el que se eligió en la lista); se puede cambiar a mano
function formPago(s, periodo) {
  const inicio = periodo?.inicio || hoyISO();
  const sugerido = periodo ? r2(Math.max(0, (periodo.monto || 0) - (periodo.pagado || 0))) : s.monto_ciclo;
  return modal({
    title: 'Registrar pago', subtitle: `${s.cliente} · ${s.codigo}${periodo ? ` · ${nombrePeriodo(periodo, s.ciclo)}` : ''}`,
    body: html`<form class="form-grid" data-pago>
      <label class="field"><span>Periodo desde</span><input class="input" type="date" name="periodo_inicio" required value="${inicio}"></label>
      <label class="field"><span>Periodo hasta</span><input class="input" type="date" name="periodo_fin" required value="${periodo?.fin || finPeriodo(inicio, s.ciclo)}"></label>
      <label class="field"><span>Monto *</span><input class="input" type="number" name="monto" min="0.01" step="0.01" required value="${sugerido || ''}"></label>
      <label class="field"><span>Fecha de pago</span><input class="input" type="date" name="fecha" value="${hoyISO()}" max="${hoyISO()}"></label>
      <label class="field"><span>Método</span><select class="select" name="metodo">${opciones(Object.entries(METODOS), 'transferencia')}</select></label>
      <label class="field"><span>Referencia</span><input class="input" name="referencia" maxlength="150" placeholder="N.° de operación"></label>
      <label class="field span-2"><span>Nota</span><input class="input" name="notas" maxlength="300" placeholder="Opcional"></label>
      <label class="field span-2"><span>Comprobante (imagen)</span><input class="input" type="file" name="comprobante" accept="image/jpeg,image/png,image/webp"></label></form>`,
    foot: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-ok>${icon('check', 'sm')} Registrar pago</button>`,
    onMount: m => {
      const form = $('[data-pago]', m.el);
      form.periodo_inicio.addEventListener('change', () => { if (form.periodo_inicio.value) form.periodo_fin.value = finPeriodo(form.periodo_inicio.value, s.ciclo); });
      $('[data-ok]', m.el).addEventListener('click', e => conCarga(e.currentTarget, async () => {
        if (!form.reportValidity()) return;
        const fd = new FormData(form);
        if (!form.comprobante.files.length) fd.delete('comprobante');
        try { await api.form('POST', `/api/suscripciones/${s.id}/pagos`, fd); toast('Pago registrado'); m.close(true); }
        catch (err) { toastError(err); }
      }));
    },
  }).done;
}

// ── Ficha lateral ─────────────────────────────────────────────────────────
export async function abrirSuscripcion(id, { onCambio } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay drawer-wrap';
  dibujar(ov, html`<div class="drawer" role="dialog" aria-modal="true">${cargando()}</div>`);
  document.body.appendChild(ov);
  const drawer = ov.firstElementChild;
  const montos = can('suscripciones.cobros'), gestion = can('suscripciones.gestionar');
  let cambiado = false, d = null, tab = montos ? 'pagos' : 'resumen', verTodos = false;
  const cerrar = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (cambiado) onCambio?.(); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.overlay:not(.drawer-wrap)')) cerrar(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });

  async function cargar() {
    try { d = await api.get(`/api/suscripciones/${id}`); return true; }
    catch (e) { toastError(e); cerrar(); return false; }
  }
  const refrescar = async () => { cambiado = true; if (await cargar()) pintar(); };

  function pintar() {
    const s = d.suscripcion;
    dibujar(drawer, html`<div class="drawer-head">
      <div class="row top"><div class="grow">
        <div class="row xs muted"><span class="mono">${s.codigo}</span> · ${s.producto_nombre}</div>
        <h2 style="margin-top:2px">${s.cliente}</h2>
        <div class="row wrap small" style="margin-top:4px">${estadoBadge(s.estado)}<span>Plan <b>${s.plan_nombre}</b> · ${CICLOS[s.ciclo]}</span>
          <span class="muted">· ${s.pagado_hasta ? `pagado hasta ${fechaCorta(s.pagado_hasta)}` : 'sin pagos'}</span></div></div>
        <button class="icon-btn" data-act="cerrar" aria-label="Cerrar">${icon('x')}</button></div>
      ${gestion ? html`<div class="row wrap" style="margin:12px 0 4px">
        ${s.estado !== 'cancelada' ? html`<button class="btn btn-sm" data-act="editar">${icon('edit', 'sm')} Editar</button>` : ''}
        ${s.estado !== 'cancelada' ? html`<button class="btn btn-sm" data-act="int-agregar">${icon('zap', 'sm')} Agregar integración</button>` : ''}
        ${s.estado !== 'activa' ? html`<button class="btn btn-sm btn-success" data-act="estado" data-a="reactivar">${icon('play', 'sm')} Reactivar</button>` : ''}
        <button class="btn btn-sm btn-ghost btn-icon right" data-act="mas" aria-label="Más">${icon('more')}</button></div>` : ''}
      <div class="tabs" style="margin:8px 0 0;border:0">
        ${[...(montos ? [['pagos', 'Periodos y pagos']] : []), ['resumen', 'Resumen'], ['historial', 'Historial']]
          .map(([k, t]) => html`<button class="tab ${tab === k ? 'active' : ''}" data-act="tab" data-tab="${k}">${t}</button>`)}</div></div>
      <div class="drawer-body">${tab === 'pagos' ? pagos() : tab === 'resumen' ? resumen() : historial()}</div>`);
  }

  // Periodos por fecha, cada uno con su botón de pago
  function pagos() {
    const s = d.suscripcion;
    const lista = verTodos ? s.periodos : s.periodos.slice(0, 12);
    return html`
      <div class="row mb"><p class="small muted grow">Periodos ${CICLOS[s.ciclo].toLowerCase()}es desde el ${fechaCorta(s.fecha_inicio)}. Monto de referencia por periodo: <b>${dinero(s.monto_ciclo, s.moneda)}</b>.</p>
        ${gestion ? html`<button class="btn btn-sm" data-act="pago-libre">${icon('plus', 'sm')} Otro pago</button>` : ''}</div>
      <div class="card">${lista.length ? lista.map((p, i) => { const [t, n] = ESTADO_PERIODO[p.estado] || ['', p.estado];
        return html`<div class="list-item">
          <div class="grow"><div class="strong" style="text-transform:capitalize">${nombrePeriodo(p, s.ciclo)}</div>
            <div class="xs muted">${fechaCorta(p.inicio)} – ${fechaCorta(p.fin)}${p.pagado ? ` · pagado ${dinero(p.pagado, s.moneda)}` : ''}</div></div>
          <span class="badge ${t}">${n}</span>
          ${gestion && p.estado !== 'pagado' ? html`<button class="btn btn-xs ${p.estado === 'futuro' ? '' : 'btn-primary'}" data-act="pagar" data-i="${i}">${icon('dollar', 'sm')} ${p.estado === 'parcial' ? 'Completar pago' : 'Registrar pago'}</button>` : ''}</div>`; })
        : html`<div class="card-body small muted">${s.estado === 'activa' ? 'La suscripción aún no empieza.' : 'Sin periodos.'}</div>`}
        ${!verTodos && s.periodos.length > 12 ? html`<div class="card-body"><button class="btn btn-sm btn-ghost" data-act="ver-todos">Ver los ${s.periodos.length} periodos</button></div>` : ''}</div>

      <div class="card mt"><div class="card-head"><h3>Pagos registrados</h3><span class="small">Total: <b>${dinero(s.total_pagado, s.moneda)}</b></span></div>
        ${d.pagos.length ? d.pagos.map(g => html`<div class="list-item"><div class="grow">
            <div class="strong">${dinero(g.monto, s.moneda)} <span class="badge">${METODOS[g.metodo] || g.metodo}</span></div>
            <div class="xs muted">Periodo ${fechaCorta(g.periodo_inicio)} – ${fechaCorta(g.periodo_fin)} · pagado el ${fechaCorta(g.fecha)}${g.referencia ? ` · ${g.referencia}` : ''}${g.registrado_por_nombre ? ` · ${g.registrado_por_nombre}` : ''}</div>
            ${g.notas ? html`<div class="xs muted">${g.notas}</div>` : ''}</div>
          ${g.comprobante_url ? html`<a class="btn btn-xs" href="${g.comprobante_url}" target="_blank" rel="noopener">${icon('image', 'sm')} Comprobante</a>` : ''}
          ${gestion ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="borrar-pago" data-id="${g.id}" aria-label="Anular">${icon('trash', 'sm')}</button>` : ''}</div>`)
          : html`<div class="card-body small muted">Aún no se registran pagos.</div>`}</div>`;
  }

  function resumen() {
    const s = d.suscripcion;
    const fila = (k, v) => html`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--border)"><span class="muted">${k}</span><span class="strong">${v}</span></div>`;
    return html`<div class="grid c2">
      ${montos ? html`<div class="card"><div class="card-head"><h3>${icon('dollar', 'sm')} Monto por periodo</h3><span class="xs muted">${Number(s.incluye_igv) ? 'IGV incluido' : '+ IGV'}</span></div><div class="card-body">
        ${s.lineas.map(l => html`<div class="row between small" style="padding:2px 0"><span class="muted">${l.concepto}</span><span class="num">${dinero(l.monto, s.moneda)}</span></div>`)}
        <div class="row between" style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px"><span class="small">${CICLOS[s.ciclo]}</span><span class="kpi-value" style="font-size:20px;margin:0">${dinero(s.monto_ciclo, s.moneda)}</span></div>
        ${s.ciclo !== 'mensual' ? html`<div class="xs muted">${dinero(s.mensual, s.moneda)} al mes</div>` : ''}
      </div></div>` : ''}
      <div class="card"><div class="card-head"><h3>${icon('calendar', 'sm')} Datos</h3></div><div class="card-body" style="padding-top:6px">
        ${fila('Inicio', fechaCorta(s.fecha_inicio))}
        ${fila('Pagado hasta', s.pagado_hasta ? fechaCorta(s.pagado_hasta) : '—')}
        ${fila('Responsable', s.responsable_nombre || '—')}
        ${s.proyecto_codigo ? fila('Proyecto de implementación', s.proyecto_codigo) : ''}
        ${s.estado === 'cancelada' ? fila('Cancelada', `${fechaCorta(s.cancelada_at)}${s.motivo_cancelacion ? ` — ${s.motivo_cancelacion}` : ''}`) : ''}
      </div></div></div>
      <div class="card mt"><div class="card-head"><h3>${icon('zap', 'sm')} Integraciones</h3>
        ${gestion && s.estado !== 'cancelada' ? html`<button class="btn btn-sm" data-act="int-agregar">${icon('plus', 'sm')} Agregar</button>` : ''}</div>
        ${s.integraciones.length ? s.integraciones.map(i => html`<div class="list-item"><div class="grow">
            <div class="strong" style="${Number(i.activo) ? '' : 'text-decoration:line-through;opacity:.6'}">${i.nombre}</div>
            <div class="xs muted">${montos ? `${dinero(i.precio_mensual, s.moneda)}/mes · ` : ''}${Number(i.activo) ? `desde ${fechaCorta(i.fecha_alta)}` : `retirada el ${fechaCorta(i.fecha_baja)}`}</div></div>
          ${gestion && Number(i.activo) ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="int-quitar" data-id="${i.id}" aria-label="Quitar">${icon('trash', 'sm')}</button>` : ''}</div>`)
          : html`<div class="card-body small muted">Sin integraciones adicionales.</div>`}</div>
      ${s.notas ? html`<div class="card mt"><div class="card-head"><h3>${icon('note', 'sm')} Notas</h3></div><div class="card-body small" style="white-space:pre-wrap">${s.notas}</div></div>` : ''}`;
  }

  function historial() {
    return d.historial.length ? html`<div class="card">${d.historial.map(h => html`<div class="list-item"><div class="grow small"><div>${h.contenido}</div><div class="xs muted">${h.usuario || 'Sistema'} · ${fmt.fechaHora(h.created_at)}</div></div></div>`)}</div>`
      : vacio({ icono: 'activity', titulo: 'Sin movimientos' });
  }

  async function cambiarEstado(accion) {
    const s = d.suscripcion;
    const textos = {
      suspender: ['¿Suspender la suscripción?', 'Queda registrada como suspendida.', 'Suspender'],
      cancelar: ['¿Cancelar la suscripción?', 'Los periodos se muestran solo hasta la fecha de cancelación. Podrás reactivarla después.', 'Cancelar suscripción'],
      reactivar: ['¿Reactivar la suscripción?', 'Vuelve a quedar activa.', 'Reactivar'],
    }[accion];
    const r = await formModal({
      title: textos[0], size: 'sm', submit: textos[2],
      fields: html`<p class="small muted span-2">${textos[1]}</p>
        ${accion === 'cancelar' ? html`<label class="field span-2"><span>Fecha de cancelación</span><input class="input" type="date" name="fecha" value="${hoyISO()}"></label>` : ''}
        ${accion !== 'reactivar' ? html`<label class="field span-2"><span>Motivo</span><input class="input" name="motivo" maxlength="300" placeholder="Opcional"></label>` : ''}`,
      onSubmit: async x => { await api.post(`/api/suscripciones/${s.id}/estado`, { accion, ...x }); return true; },
    }).done;
    if (r) { toast('Estado actualizado'); refrescar(); }
  }

  async function agregarIntegracion() {
    const s = d.suscripcion;
    const cat = await catalogo(true);
    const yaActivas = new Set(s.integraciones.filter(i => Number(i.activo)).map(i => i.integracion_id));
    const disponibles = cat.integraciones.filter(i => Number(i.activo) && (!i.producto_id || i.producto_id === s.producto_id) && !yaActivas.has(i.id));
    if (!disponibles.length) { toast('No hay más integraciones disponibles para este producto.', 'info'); return; }
    const r = await formModal({
      title: 'Agregar integración', size: 'sm',
      fields: html`<label class="field span-2"><span>Integración</span><select class="select" name="integracion_id">${opciones(disponibles.map(i => [i.id, i.nombre]), disponibles[0].id)}</select></label>
        ${montos ? html`<label class="field"><span>Precio mensual</span><input class="input" type="number" name="precio_mensual" min="0" step="0.01" value="${disponibles[0].precio_mensual}"></label>` : ''}
        <label class="field"><span>Desde</span><input class="input" type="date" name="fecha_alta" value="${hoyISO()}"></label>`,
      onMount: (m, form) => form.integracion_id.addEventListener('change', () => {
        if (form.precio_mensual) form.precio_mensual.value = disponibles.find(x => x.id === Number(form.integracion_id.value)).precio_mensual;
      }),
      onSubmit: async x => { await api.post(`/api/suscripciones/${s.id}/integraciones`, x); return true; },
    }).done;
    if (r) { toast('Integración agregada'); refrescar(); }
  }

  acciones(drawer, {
    cerrar,
    tab: b => { tab = b.dataset.tab; pintar(); },
    'ver-todos': () => { verTodos = true; pintar(); },
    editar: async () => { if (await formSuscripcion(d.suscripcion)) refrescar(); },
    pagar: async b => { if (await formPago(d.suscripcion, d.suscripcion.periodos[+b.dataset.i])) refrescar(); },
    'pago-libre': async () => { if (await formPago(d.suscripcion, null)) refrescar(); },
    estado: b => cambiarEstado(b.dataset.a),
    'int-agregar': agregarIntegracion,
    'int-quitar': async b => {
      if (!(await confirmar('Queda registrada la fecha en que se retiró.', { titulo: '¿Quitar la integración?', ok: 'Quitar', peligro: true }))) return;
      try { await api.del(`/api/suscripciones/integraciones/item/${b.dataset.id}`); toast('Integración retirada'); refrescar(); } catch (e) { toastError(e); }
    },
    'borrar-pago': async b => {
      if (!(await confirmar('Se elimina el registro de este pago.', { titulo: '¿Anular este pago?', ok: 'Anular pago', peligro: true }))) return;
      try { await api.del(`/api/suscripciones/pagos/${b.dataset.id}`); toast('Pago anulado'); refrescar(); } catch (e) { toastError(e); }
    },
    mas: b => {
      const s = d.suscripcion;
      const items = [{ label: 'Ver ficha del cliente', icon: 'user', onClick: () => { cerrar(); location.hash = `#/contactos/${s.negocio_id}`; } }];
      if (s.estado === 'activa') items.push({ label: 'Suspender', icon: 'pause', onClick: () => cambiarEstado('suspender') });
      if (s.estado !== 'cancelada') items.push('-', { label: 'Cancelar suscripción', icon: 'x', danger: true, onClick: () => cambiarEstado('cancelar') });
      if (!d.pagos.length) items.push({ label: 'Eliminar', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmar('Se borra la suscripción. No se puede deshacer.', { titulo: '¿Eliminar?', ok: 'Eliminar', peligro: true }))) return;
        try { await api.del(`/api/suscripciones/${s.id}`); toast('Suscripción eliminada'); cambiado = true; cerrar(); } catch (e) { toastError(e); }
      } });
      menu(b, items);
    },
  });

  if (await cargar()) pintar();
}
