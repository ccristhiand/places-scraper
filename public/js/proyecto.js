// Proyectos: formulario (con plan de pagos) y ficha lateral. Se usan desde Proyectos y desde la ficha del cliente.
import { html, raw, icon, api, $, $$, render, acciones, toast, toastError, confirmar, fmt, can, cargando, vacio, opciones, usuarios, modal, formModal, conCarga, menu, session } from './core.js';
import { campoContacto, enlazarContacto } from './ui.js';

export const TIPOS = { web: 'Sitio web', app: 'App móvil', sistema: 'Sistema a medida', ecommerce: 'Tienda online', integracion: 'Integración', mantenimiento: 'Mantenimiento', otro: 'Otro' };
export const ESTADOS = {
  propuesta: ['', 'Propuesta'], aprobado: ['info', 'Aprobado'], desarrollo: ['primary', 'En desarrollo'], pruebas: ['warning', 'En pruebas'],
  soporte: ['success', 'En soporte'], cerrado: ['', 'Cerrado'], pausado: ['warning', 'Pausado'], cancelado: ['danger', 'Cancelado'],
};
const ACCIONES_ESTADO = {
  aprobado: ['Aprobar', 'check', 'btn-primary'], desarrollo: ['Iniciar desarrollo', 'play', 'btn-primary'], pruebas: ['Pasar a pruebas', 'checkSquare', ''],
  entregar: ['Marcar entregado', 'trophy', 'btn-success'], cerrado: ['Cerrar proyecto', 'lock', ''], pausado: ['Pausar', 'pause', 'btn-ghost'],
  cancelado: ['Cancelar', 'x', 'btn-ghost'], propuesta: ['Reabrir como propuesta', 'refresh', 'btn-ghost'],
};
const METODOS = { transferencia: 'Transferencia', yape: 'Yape', plin: 'Plin', efectivo: 'Efectivo', tarjeta: 'Tarjeta', otro: 'Otro' };

export const dinero = (v, moneda = 'PEN') => Number(v || 0).toLocaleString('es-PE', { style: 'currency', currency: moneda, maximumFractionDigits: 2, minimumFractionDigits: 0 });
// Fechas "YYYY-MM-DD" sin corrimiento de zona horaria
export const fechaCorta = s => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const sumarDias = (iso, d) => { const x = new Date(`${iso}T12:00:00`); x.setDate(x.getDate() + Number(d || 0)); return x.toISOString().slice(0, 10); };
export const estadoBadge = e => { const [t, n] = ESTADOS[e] || ['', e]; return html`<span class="badge ${t}">${n}</span>`; };

// ── Formulario ────────────────────────────────────────────────────────────
const PLANES = {
  unico: [['Pago único', 100]],
  '50_50': [['Adelanto', 50], ['Entrega', 50]],
  '50_30_20': [['Adelanto', 50], ['Demo / avance', 30], ['Entrega', 20]],
  '40_60': [['Adelanto', 40], ['Entrega', 60]],
};

export async function formProyecto(p = null, { negocio = null, cuotas = [], onGuardado } = {}) {
  const us = await usuarios();
  const montos = can('proyectos.montos');
  const v = p || { tipo: 'web', moneda: session.moneda === 'USD' ? 'USD' : 'PEN', incluye_igv: 1, dias_soporte: 30, fecha_inicio: hoyISO() };
  const prevNeg = negocio ? { ...negocio, fijo: true } : (p ? { id: p.negocio_id, nombre: p.cliente, fijo: true } : null);
  const durInicial = v.duracion_dias ? (v.duracion_dias % 30 === 0 ? [v.duracion_dias / 30, 30] : v.duracion_dias % 7 === 0 ? [v.duracion_dias / 7, 7] : [v.duracion_dias, 1]) : ['', 7];

  return formModal({
    title: p ? `Editar ${p.codigo}` : 'Nuevo proyecto', size: 'lg', submit: p ? 'Guardar cambios' : 'Crear proyecto',
    fields: html`
      ${campoContacto('negocio_id', prevNeg, 'Cliente *')}
      <label class="field span-2"><span>Nombre del proyecto *</span><input class="input" name="nombre" required maxlength="200" value="${v.nombre || ''}" placeholder="Ej. Sistema de citas y caja"></label>
      <label class="field"><span>Tipo</span><select class="select" name="tipo">${opciones(Object.entries(TIPOS), v.tipo)}</select></label>
      <label class="field"><span>Responsable</span><select class="select" name="responsable_id">${opciones(us, v.responsable_id || session.user.id)}</select></label>

      ${montos ? html`
        <div class="span-2 divider" style="margin:4px 0"></div>
        <label class="field"><span>Monto del proyecto *</span><div class="row">
          <select class="select" name="moneda" style="width:90px">${opciones([['PEN', 'S/'], ['USD', 'US$']], v.moneda)}</select>
          <input class="input" type="number" name="monto" min="0" step="0.01" required value="${v.monto ?? ''}" placeholder="0.00"></div></label>
        <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" name="incluye_igv" ${Number(v.incluye_igv) ? raw('checked') : ''}> El monto incluye IGV</label>` : ''}

      <div class="span-2 divider" style="margin:4px 0"></div>
      <label class="field"><span>Fecha de inicio</span><input class="input" type="date" name="fecha_inicio" value="${v.fecha_inicio || ''}"></label>
      <label class="field"><span>Tiempo de desarrollo</span><div class="row">
        <input class="input" type="number" name="dur_valor" min="1" max="3650" value="${durInicial[0]}" placeholder="Ej. 6" style="width:110px">
        <select class="select" name="dur_unidad">${opciones([[1, 'días'], [7, 'semanas'], [30, 'meses']], durInicial[1])}</select></div></label>
      <label class="field"><span>Días de soporte después de la entrega</span><input class="input" type="number" name="dias_soporte" min="0" max="3650" value="${v.dias_soporte ?? 30}">
        <span class="hint row wrap">${[30, 60, 90, 180].map(d => html`<button type="button" class="tag" data-soporte="${d}" style="cursor:pointer">${d} días</button>`)}</span></label>
      <div class="field"><span class="label">Fechas calculadas</span><div class="small" data-calc style="padding-top:6px"></div></div>

      ${montos ? html`<div class="span-2"><div class="divider" style="margin:4px 0 12px"></div>
        <div class="row between mb"><span class="label">Plan de pagos</span>
          <div class="seg" data-planes>${[['unico', '100 %'], ['50_50', '50 / 50'], ['50_30_20', '50 / 30 / 20'], ['40_60', '40 / 60']].map(([k, t]) => html`<button type="button" data-plan="${k}">${t}</button>`)}</div></div>
        <div data-cuotas></div>
        <div class="row mt"><button type="button" class="btn btn-sm" data-add-cuota>${icon('plus', 'sm')} Agregar cuota</button><span class="small right" data-suma></span></div></div>` : ''}

      <div class="span-2 divider" style="margin:4px 0"></div>
      <label class="field"><span>Horas estimadas</span><input class="input" type="number" name="horas_estimadas" min="0" step="0.5" value="${v.horas_estimadas ?? ''}" placeholder="Ej. 120"><span class="hint">Para comparar con las horas reales.</span></label>
      ${montos ? html`<label class="field"><span>Costo por hora</span><input class="input" type="number" name="costo_hora" min="0" step="0.01" value="${v.costo_hora ?? ''}" placeholder="Vacío = el de Configuración"><span class="hint">Para calcular la rentabilidad.</span></label>` : html`<div></div>`}
      <label class="field span-2"><span>Alcance</span><textarea class="input" name="alcance" rows="4" placeholder="Qué incluye: módulos, pantallas, integraciones… y qué NO incluye.">${v.alcance || ''}</textarea></label>
      <label class="field"><span>Repositorio</span><input class="input" name="url_repo" value="${v.url_repo || ''}" placeholder="https://github.com/…"></label>
      <label class="field"><span>Demo / staging</span><input class="input" name="url_demo" value="${v.url_demo || ''}" placeholder="https://"></label>
      <label class="field span-2"><span>Producción</span><input class="input" name="url_produccion" value="${v.url_produccion || ''}" placeholder="https://"></label>
      ${p ? '' : html`<label class="check span-2"><input type="checkbox" name="aprobado"> El cliente ya aprobó el proyecto (pasa a "Ganado" en el pipeline)</label>`}`,

    onMount: (m, form) => {
      enlazarContacto(form);
      if (negocio) form.negocio_id.value = negocio.id;
      if (p) form.negocio_id.value = p.negocio_id;
      let filas = (cuotas || []).map(c => ({ concepto: c.concepto, monto: Number(c.monto), vence_at: c.vence_at || '' }));

      const duracion = () => (Number(form.dur_valor.value) || 0) * Number(form.dur_unidad.value);
      const entrega = () => (form.fecha_inicio.value && duracion() ? sumarDias(form.fecha_inicio.value, duracion()) : null);
      const calc = () => {
        const e = entrega();
        render($('[data-calc]', form), e ? html`Entrega estimada: <b>${fechaCorta(e)}</b><br>Soporte hasta: <b>${fechaCorta(sumarDias(e, form.dias_soporte.value))}</b> <span class="xs muted">(si se entrega a tiempo)</span>`
          : html`<span class="muted">Indica inicio y tiempo para calcular la entrega.</span>`);
        if (montos) pintarCuotas();
      };
      const pintarCuotas = () => {
        const total = Number(form.monto.value) || 0;
        render($('[data-cuotas]', form), filas.length ? html`<table class="table"><thead><tr><th>Concepto</th><th style="width:80px">%</th><th style="width:130px">Monto</th><th style="width:150px">Vence</th><th></th></tr></thead><tbody>
          ${filas.map((c, i) => html`<tr>
            <td><input class="input sm" data-c="concepto" data-i="${i}" value="${c.concepto}"></td>
            <td><input class="input sm" type="number" min="0" max="100" step="1" data-c="pct" data-i="${i}" value="${total ? Math.round((c.monto / total) * 1000) / 10 : ''}"></td>
            <td><input class="input sm" type="number" min="0" step="0.01" data-c="monto" data-i="${i}" value="${c.monto}"></td>
            <td><input class="input sm" type="date" data-c="vence_at" data-i="${i}" value="${c.vence_at}"></td>
            <td><button type="button" class="btn btn-ghost btn-xs btn-icon" data-del-cuota="${i}" aria-label="Quitar">${icon('x', 'sm')}</button></td></tr>`)}
          </tbody></table>` : html`<p class="small muted">Sin plan de pagos. Elige uno arriba o agrega cuotas.</p>`);
        pintarSuma();
      };
      const pintarSuma = () => {
        const total = Number(form.monto.value) || 0;
        const suma = filas.reduce((s, c) => s + (Number(c.monto) || 0), 0);
        const dif = Math.round((total - suma) * 100) / 100;
        render($('[data-suma]', form), filas.length ? html`Suma de cuotas: <b>${dinero(suma, form.moneda.value)}</b>${dif ? html` · <span style="color:var(--warning)">${dif > 0 ? `faltan ${dinero(dif, form.moneda.value)}` : `sobran ${dinero(-dif, form.moneda.value)}`}</span>` : ''}` : '');
      };
      const aplicarPlan = k => {
        const total = Number(form.monto.value) || 0;
        const ini = form.fecha_inicio.value || hoyISO(), fin = entrega() || ini;
        const def = PLANES[k];
        filas = def.map(([concepto, pct], i) => ({
          concepto: `${concepto} (${pct} %)`,
          monto: Math.round(total * pct) / 100,
          vence_at: i === 0 ? ini : i === def.length - 1 ? fin : sumarDias(ini, Math.round(duracion() / 2)),
        }));
        // El redondeo va en la última cuota
        const resto = Math.round((total - filas.reduce((s, c) => s + c.monto, 0)) * 100) / 100;
        if (filas.length) filas[filas.length - 1].monto = Math.round((filas[filas.length - 1].monto + resto) * 100) / 100;
        $$('[data-plan]', form).forEach(b => b.classList.toggle('active', b.dataset.plan === k));
        pintarCuotas();
      };

      form.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.c) {
          // Se actualiza el modelo y la celda vecina sin redibujar la tabla (así no se pierde el foco)
          const i = +t.dataset.i, c = filas[i], total = Number(form.monto.value) || 0;
          const celda = k => $(`[data-c="${k}"][data-i="${i}"]`, form);
          if (t.dataset.c === 'pct') { c.monto = Math.round(total * Number(t.value)) / 100; celda('monto').value = c.monto; }
          else if (t.dataset.c === 'monto') { c.monto = Number(t.value) || 0; celda('pct').value = total ? Math.round((c.monto / total) * 1000) / 10 : ''; }
          else c[t.dataset.c] = t.value;
          pintarSuma();
          return;
        }
        if (['fecha_inicio', 'dur_valor', 'dur_unidad', 'dias_soporte', 'monto', 'moneda'].includes(t.name)) calc();
      });
      form.addEventListener('change', e => { if (e.target.name === 'dur_unidad' || e.target.name === 'moneda') calc(); });
      form.addEventListener('click', e => {
        const s = e.target.closest('[data-soporte]'); if (s) { form.dias_soporte.value = s.dataset.soporte; calc(); }
        const pl = e.target.closest('[data-plan]'); if (pl) aplicarPlan(pl.dataset.plan);
        if (e.target.closest('[data-add-cuota]')) { filas.push({ concepto: `Cuota ${filas.length + 1}`, monto: 0, vence_at: '' }); pintarCuotas(); }
        const d = e.target.closest('[data-del-cuota]'); if (d) { filas.splice(+d.dataset.delCuota, 1); pintarCuotas(); }
      });
      m.filas = () => filas;
      calc();
    },

    onSubmit: async (d, form, m) => {
      if (!d.negocio_id) throw new Error('Elige el cliente de la lista.');
      const body = {
        negocio_id: d.negocio_id, nombre: d.nombre, tipo: d.tipo, responsable_id: d.responsable_id,
        fecha_inicio: d.fecha_inicio || null,
        duracion_dias: d.dur_valor ? Number(d.dur_valor) * Number(d.dur_unidad) : null,
        dias_soporte: d.dias_soporte, alcance: d.alcance, url_repo: d.url_repo, url_demo: d.url_demo, url_produccion: d.url_produccion,
        horas_estimadas: d.horas_estimadas,
      };
      if (montos) {
        Object.assign(body, { moneda: d.moneda, monto: d.monto, incluye_igv: d.incluye_igv ? 1 : 0, costo_hora: d.costo_hora });
        body.cuotas = m.filas().filter(c => Number(c.monto) > 0);
      }
      if (!p && d.aprobado) body.estado = 'aprobado';
      const r = p ? await api.put(`/api/proyectos/${p.id}`, body) : await api.post('/api/proyectos', body);
      toast(p ? 'Proyecto actualizado' : `Proyecto ${r.codigo} creado`);
      onGuardado?.(p ? p.id : r.id);
      return r;
    },
  }).done;
}

// ── Ficha lateral ─────────────────────────────────────────────────────────
export async function abrirProyecto(id, { onCambio } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay drawer-wrap';
  render(ov, html`<div class="drawer" role="dialog" aria-modal="true">${cargando()}</div>`);
  document.body.appendChild(ov);
  const drawer = ov.firstElementChild;
  let cambiado = false, d = null, tab = 'resumen';
  const cerrar = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (cambiado) onCambio?.(); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.overlay:not(.drawer-wrap)')) cerrar(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });

  async function cargar() {
    try { d = await api.get(`/api/proyectos/${id}`); return true; }
    catch (e) { toastError(e); cerrar(); return false; }
  }
  const p = () => d.proyecto;

  function cabecera() {
    const x = p();
    const gestion = can('proyectos.gestionar');
    const principales = d.transiciones.filter(t => !['pausado', 'cancelado', 'propuesta'].includes(t));
    const secundarias = d.transiciones.filter(t => ['pausado', 'cancelado', 'propuesta'].includes(t));
    return html`<div class="drawer-head">
      <div class="row top"><div class="grow">
        <div class="row xs muted"><span class="mono">${x.codigo}</span> · ${TIPOS[x.tipo] || x.tipo}</div>
        <h2 style="margin-top:2px">${x.nombre}</h2>
        <div class="row wrap small" style="margin-top:4px">${estadoBadge(x.estado)}
          <a href="#" data-act="cliente">${icon('user', 'sm')} ${x.cliente}</a>
          ${x.responsable_nombre ? html`<span class="muted">· Responsable: ${x.responsable_nombre}</span>` : ''}
          ${x.atrasado ? html`<span class="badge danger">Atrasado ${-x.dias_para_entrega} d</span>` : ''}</div></div>
        <button class="icon-btn" data-act="cerrar" aria-label="Cerrar">${icon('x')}</button></div>
      ${gestion ? html`<div class="row wrap" style="margin:12px 0 4px">
        ${principales.map(t => { const [txt, ic, cls] = ACCIONES_ESTADO[t]; return html`<button class="btn btn-sm ${cls}" data-act="estado" data-e="${t}">${icon(ic, 'sm')} ${txt}</button>`; })}
        <button class="btn btn-sm" data-act="editar">${icon('edit', 'sm')} Editar</button>
        ${can('proyectos.montos') && !['propuesta', 'cancelado'].includes(x.estado) && x.saldo > 0 ? html`<button class="btn btn-sm" data-act="cobro">${icon('dollar', 'sm')} Registrar cobro</button>` : ''}
        <button class="btn btn-sm btn-ghost btn-icon right" data-act="mas" data-sec="${secundarias.join(',')}" aria-label="Más">${icon('more')}</button></div>` : ''}
      <div class="tabs" style="margin:8px 0 0;border:0">
        ${[['resumen', 'Resumen'], ['avance', `Avance${x.avance !== null ? ` ${x.avance} %` : ''}`],
           ...(can('proyectos.montos') ? [['pagos', `Pagos${x.cuotas_vencidas ? ` · ${x.cuotas_vencidas} vencida(s)` : ''}`]] : []),
           ['soporte', `Incidencias${x.tickets_abiertos ? ` (${x.tickets_abiertos})` : ''}`], ['horas', 'Horas'], ['archivos', `Archivos${d.archivos.length ? ` (${d.archivos.length})` : ''}`], ['historial', 'Historial']]
          .map(([k, t]) => html`<button class="tab ${tab === k ? 'active' : ''}" data-act="tab" data-tab="${k}">${t}</button>`)}</div></div>`;
  }

  function resumen() {
    const x = p();
    const fila = (k, v) => html`<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--border)"><span class="muted">${k}</span><span class="strong">${v}</span></div>`;
    // Avance de tiempo: transcurrido / duración total
    let tiempoPct = null;
    if (x.fecha_inicio && x.fecha_entrega_estimada) {
      const ini = new Date(`${x.fecha_inicio}T12:00:00`), fin = new Date(`${x.fecha_entrega_estimada}T12:00:00`);
      tiempoPct = Math.max(0, Math.min(100, Math.round(((Date.now() - ini) / Math.max(1, fin - ini)) * 100)));
    }
    const enDesarrollo = ['aprobado', 'desarrollo', 'pruebas'].includes(x.estado);
    return html`<div class="grid c2">
      ${can('proyectos.montos') ? html`<div class="card"><div class="card-head"><h3>${icon('dollar', 'sm')} Dinero</h3>${Number(x.incluye_igv) ? html`<span class="xs muted">IGV incluido</span>` : html`<span class="xs muted">+ IGV</span>`}</div><div class="card-body">
        <div class="row between"><span class="muted small">Monto</span><span class="kpi-value" style="font-size:20px;margin:0">${dinero(x.monto, x.moneda)}</span></div>
        <div class="progress" style="margin:10px 0 6px"><div style="width:${raw(x.monto ? Math.min(100, (x.pagado / x.monto) * 100) : 0)}%;background:var(--success)"></div></div>
        <div class="row between small"><span>Cobrado <b>${dinero(x.pagado, x.moneda)}</b></span><span>Saldo <b style="${x.saldo > 0 ? 'color:var(--warning)' : ''}">${dinero(x.saldo, x.moneda)}</b></span></div>
        ${x.proxima_cuota ? html`<div class="alert ${x.proxima_cuota.estado === 'vencida' ? 'danger' : 'info'} small mt">${icon('clock', 'sm')}<div>Próxima cuota: <b>${x.proxima_cuota.concepto}</b> · ${dinero(x.proxima_cuota.monto - x.proxima_cuota.cubierto, x.moneda)}${x.proxima_cuota.vence_at ? ` · ${x.proxima_cuota.estado === 'vencida' ? 'venció' : 'vence'} el ${fechaCorta(x.proxima_cuota.vence_at)}` : ''}</div></div>` : ''}
      </div></div>` : ''}
      <div class="card"><div class="card-head"><h3>${icon('calendar', 'sm')} Tiempo</h3></div><div class="card-body" style="padding-top:6px">
        ${fila('Inicio', fechaCorta(x.fecha_inicio))}
        ${fila('Duración', x.duracion_dias ? `${x.duracion_dias} días` : '—')}
        ${x.avance !== null ? fila('Avance (hitos)', `${x.avance} %`) : ''}
        ${fila(x.fecha_entrega_real ? 'Entrega estimada' : 'Entrega', fechaCorta(x.fecha_entrega_estimada))}
        ${x.fecha_entrega_real ? fila('Entregado', fechaCorta(x.fecha_entrega_real)) : ''}
        ${enDesarrollo && tiempoPct !== null ? html`<div class="xs muted" style="margin-top:10px">Tiempo transcurrido ${tiempoPct} %${x.dias_para_entrega !== null ? (x.dias_para_entrega >= 0 ? ` · faltan ${x.dias_para_entrega} días` : ` · atrasado ${-x.dias_para_entrega} días`) : ''}</div>
          <div class="progress" style="margin-top:5px"><div style="width:${raw(tiempoPct)}%;background:${raw(x.atrasado ? 'var(--danger)' : 'var(--primary)')}"></div></div>` : ''}
      </div></div>
      <div class="card"><div class="card-head"><h3>${icon('shield', 'sm')} Soporte</h3></div><div class="card-body" style="padding-top:6px">
        ${fila('Días de soporte', `${x.dias_soporte} días`)}
        ${x.fecha_fin_soporte ? fila('Soporte hasta', fechaCorta(x.fecha_fin_soporte)) : fila('Empieza', 'al entregar el proyecto')}
        ${x.estado === 'soporte' && x.dias_soporte_restantes !== null ? html`<div class="alert ${x.dias_soporte_restantes <= 7 ? 'warning' : 'success'} small mt">${icon('clock', 'sm')}<div>
          ${x.dias_soporte_restantes >= 0 ? html`Quedan <b>${x.dias_soporte_restantes}</b> días de soporte.` : 'El soporte terminó.'}
          ${x.dias_soporte_restantes <= 7 ? ' Buen momento para ofrecer un plan de mantenimiento.' : ''}</div></div>` : ''}
      </div></div>
      <div class="card"><div class="card-head"><h3>${icon('link', 'sm')} Enlaces</h3></div><div class="card-body stack sm small">
        ${[['Repositorio', x.url_repo], ['Demo', x.url_demo], ['Producción', x.url_produccion]].map(([k, u]) => html`<div class="row between"><span class="muted">${k}</span>${u ? html`<a href="${u}" target="_blank" rel="noopener noreferrer" class="truncate" style="max-width:220px">${u.replace(/^https?:\/\//, '')}</a>` : html`<span class="muted">—</span>`}</div>`)}
      </div></div>
    </div>
    ${x.alcance ? html`<div class="card mt"><div class="card-head"><h3>${icon('file', 'sm')} Alcance</h3></div><div class="card-body small" style="white-space:pre-wrap">${x.alcance}</div></div>` : ''}
    ${d.tareas.length ? html`<div class="card mt"><div class="card-head"><h3>${icon('checkSquare', 'sm')} Tareas del proyecto</h3><a class="small" href="#/tareas">Ver tareas</a></div>
      ${d.tareas.map(t => html`<div class="list-item"><span class="dot ${t.estado === 'completada' ? 'ok' : ''}" style="margin-top:7px"></span><div class="grow small"><div class="strong" style="${t.estado === 'completada' ? 'text-decoration:line-through;opacity:.6' : ''}">${t.titulo}</div><div class="xs muted">${t.vence_at ? fmt.fechaHora(t.vence_at) : 'Sin fecha'} · ${t.asignado_nombre || '—'}</div></div></div>`)}</div>` : ''}`;
  }

  function pagos() {
    const x = p();
    const ESTADO_CUOTA = { pagada: ['success', 'Pagada'], parcial: ['warning', 'Parcial'], pendiente: ['', 'Pendiente'], vencida: ['danger', 'Vencida'] };
    return html`
      <div class="card"><div class="card-head"><h3>Plan de pagos</h3>${can('proyectos.gestionar') ? html`<button class="btn btn-sm" data-act="editar">${icon('edit', 'sm')} Editar plan</button>` : ''}</div>
        ${d.cuotas.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Concepto</th><th>Vence</th><th>Monto</th><th>Cubierto</th><th>Estado</th></tr></thead><tbody>
          ${d.cuotas.map(c => { const [t, n] = ESTADO_CUOTA[c.estado] || ['', c.estado];
            return html`<tr><td class="strong small">${c.concepto}</td><td class="small nowrap">${fechaCorta(c.vence_at)}</td><td class="small num">${dinero(c.monto, x.moneda)}</td>
              <td class="small num">${dinero(c.cubierto, x.moneda)}</td><td><span class="badge ${t}">${n}</span></td></tr>`; })}</tbody></table></div>`
          : html`<div class="card-body small muted">Sin plan de pagos. Agrégalo desde Editar para recibir avisos de cobro.</div>`}</div>
      <div class="card mt"><div class="card-head"><h3>Cobros recibidos</h3>
        ${can('proyectos.gestionar') && x.saldo > 0 && !['propuesta', 'cancelado'].includes(x.estado) ? html`<button class="btn btn-sm btn-primary" data-act="cobro">${icon('plus', 'sm')} Registrar cobro</button>` : ''}</div>
        ${d.pagos.length ? html`${d.pagos.map(g => html`<div class="list-item">
          <div class="grow"><div class="strong">${dinero(g.monto, x.moneda)} <span class="badge">${METODOS[g.metodo] || g.metodo}</span></div>
          <div class="xs muted">${fechaCorta(g.fecha)}${g.referencia ? ` · ${g.referencia}` : ''}${g.registrado_por_nombre ? ` · registrado por ${g.registrado_por_nombre}` : ''}</div></div>
          ${g.comprobante_url ? html`<a class="btn btn-xs" href="${g.comprobante_url}" target="_blank" rel="noopener">${icon('image', 'sm')} Comprobante</a>` : ''}
          ${can('proyectos.gestionar') ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="borrar-pago" data-id="${g.id}" aria-label="Anular">${icon('trash', 'sm')}</button>` : ''}</div>`)}`
          : html`<div class="card-body small muted">Aún no se registran cobros.</div>`}</div>`;
  }

  function historial() {
    return d.historial.length ? html`<div class="card">${d.historial.map(h => html`<div class="list-item"><div class="grow small"><div>${h.contenido}</div><div class="xs muted">${h.usuario || 'Sistema'} · ${fmt.fechaHora(h.created_at)}</div></div></div>`)}</div>`
      : vacio({ icono: 'activity', titulo: 'Sin movimientos' });
  }

  // ── Avance: hitos + cambios de alcance ──────────────────────────────────
  function avance() {
    const x = p(), gestion = can('proyectos.gestionar'), trabajar = gestion || can('proyectos.trabajar'), montos = can('proyectos.montos');
    const hoy = hoyISO();
    const ESTADO_CAMBIO = { pendiente: ['warning', 'Pendiente'], aprobado: ['success', 'Aprobado'], rechazado: ['', 'Rechazado'] };
    const adicionales = d.cambios.filter(c => c.estado === 'aprobado').reduce((s, c) => s + Number(c.monto || 0), 0);
    return html`
      <div class="card"><div class="card-head"><h3>${icon('target', 'sm')} Hitos y entregables</h3>
        ${gestion ? html`<div class="row">${d.hitos.length ? '' : html`<button class="btn btn-sm" data-act="hitos-estandar">${icon('zap', 'sm')} Usar hitos estándar</button>`}
          <button class="btn btn-sm btn-primary" data-act="hito-nuevo">${icon('plus', 'sm')} Hito</button></div>` : ''}</div>
        ${d.hitos.length ? html`<div class="card-body" style="padding-bottom:4px"><div class="row between small"><span class="muted">Avance según hitos completados</span><b>${x.avance ?? 0} %</b></div>
          <div class="progress" style="margin-top:6px"><div style="width:${raw(x.avance || 0)}%"></div></div></div>
          ${d.hitos.map(h => { const tarde = !h.completado && h.fecha_objetivo && h.fecha_objetivo < hoy;
            return html`<div class="list-item">
              <label class="check" style="margin-top:2px"><input type="checkbox" data-hito="${h.id}" ${h.completado ? raw('checked') : ''} ${trabajar ? '' : raw('disabled')} aria-label="Completar hito"></label>
              <div class="grow"><div class="strong" style="${h.completado ? 'text-decoration:line-through;opacity:.6' : ''}">${h.titulo} <span class="xs muted">· peso ${h.peso}</span></div>
                ${h.descripcion ? html`<div class="small muted" style="white-space:pre-wrap">${h.descripcion}</div>` : ''}
                <div class="xs ${tarde ? '' : 'muted'}" style="${tarde ? 'color:var(--danger)' : ''}">${h.completado ? `Completado ${fmt.fechaHora(h.completado_at)}${h.completado_por_nombre ? ` por ${h.completado_por_nombre}` : ''}` : h.fecha_objetivo ? `${tarde ? 'Atrasado · ' : ''}Objetivo: ${fechaCorta(h.fecha_objetivo)}` : 'Sin fecha objetivo'}</div></div>
              ${gestion ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="hito-editar" data-id="${h.id}" aria-label="Editar">${icon('edit', 'sm')}</button>
                <button class="btn btn-ghost btn-xs btn-icon" data-act="hito-borrar" data-id="${h.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</div>`; })}`
          : html`<div class="card-body small muted">Divide el proyecto en entregables (análisis, diseño, desarrollo, pruebas, entrega). El avance se calcula solo al marcarlos.</div>`}
      </div>

      <div class="card mt"><div class="card-head"><div><h3>${icon('layers', 'sm')} Cambios de alcance</h3>
          ${montos && (adicionales || x.monto_base !== null) ? html`<div class="xs muted" style="margin-top:2px">Monto original ${dinero(x.monto_base ?? x.monto, x.moneda)} · adicionales aprobados ${dinero(adicionales, x.moneda)}</div>` : ''}</div>
        ${gestion ? html`<button class="btn btn-sm" data-act="cambio-nuevo">${icon('plus', 'sm')} Registrar cambio</button>` : ''}</div>
        ${d.cambios.length ? d.cambios.map(c => { const [t, n] = ESTADO_CAMBIO[c.estado] || ['', c.estado];
          return html`<div class="list-item"><div class="grow">
            <div class="row"><span class="strong">${c.titulo}</span><span class="badge ${t}">${n}</span></div>
            ${c.descripcion ? html`<div class="small muted" style="white-space:pre-wrap">${c.descripcion}</div>` : ''}
            <div class="xs muted">${montos && Number(c.monto) ? `${dinero(c.monto, x.moneda)} · ` : ''}${Number(c.dias_extra) ? `+${c.dias_extra} días · ` : ''}${c.creado_por_nombre || ''} · ${fmt.fecha(c.created_at)}</div></div>
            ${gestion && c.estado === 'pendiente' ? html`<button class="btn btn-xs btn-success" data-act="cambio-aprobar" data-id="${c.id}">Aprobar</button>
              <button class="btn btn-xs btn-ghost" data-act="cambio-rechazar" data-id="${c.id}">Rechazar</button>` : ''}
            ${gestion && c.estado !== 'aprobado' ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="cambio-borrar" data-id="${c.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</div>`; })
          : html`<div class="card-body small muted">Cuando el cliente pida algo fuera del alcance, regístralo aquí. Al aprobarlo se suma al monto, se agrega una cuota y se extiende el plazo.</div>`}
      </div>`;
  }

  // ── Incidencias ─────────────────────────────────────────────────────────
  const ESTADO_TICKET = { abierto: ['danger', 'Abierta'], en_proceso: ['warning', 'En proceso'], resuelto: ['success', 'Resuelta'], cerrado: ['', 'Cerrada'] };
  const PRIORIDAD = { urgente: 'danger', alta: 'warning', media: '', baja: '' };
  const TIPO_TICKET = { error: 'Error', mejora: 'Mejora', consulta: 'Consulta', cambio: 'Cambio' };
  function soporte() {
    const x = p(), gestion = can('proyectos.gestionar'), trabajar = gestion || can('proyectos.trabajar'), montos = can('proyectos.montos');
    return html`
      <div class="row mb"><p class="small muted grow">${x.estado === 'soporte' ? `Soporte vigente hasta el ${fechaCorta(x.fecha_fin_soporte)}: las incidencias nuevas quedan cubiertas.`
          : ['cerrado'].includes(x.estado) ? 'El soporte terminó: las incidencias nuevas quedan fuera de soporte y se pueden cobrar.' : 'Registra errores, mejoras y consultas del cliente.'}</p>
        ${trabajar ? html`<button class="btn btn-primary btn-sm" data-act="ticket-nuevo">${icon('plus', 'sm')} Nueva incidencia</button>` : ''}</div>
      ${d.tickets.length ? html`<div class="card">${d.tickets.map(t => { const [te, ne] = ESTADO_TICKET[t.estado] || ['', t.estado];
        return html`<div class="list-item"><div class="grow">
          <div class="row wrap"><a href="#" class="strong" data-act="ticket-ver" data-id="${t.id}">#${t.numero} ${t.titulo}</a>
            <span class="badge ${PRIORIDAD[t.prioridad]}">${t.prioridad}</span><span class="badge">${TIPO_TICKET[t.tipo] || t.tipo}</span>
            ${t.cubierto ? html`<span class="badge success">Cubierto</span>` : html`<span class="badge warning">Fuera de soporte</span>`}</div>
          <div class="xs muted">${t.asignado_nombre ? `Asignado a ${t.asignado_nombre} · ` : ''}${Number(t.horas) ? `${t.horas} h · ` : ''}reportado ${fmt.relativo(t.created_at)}${t.resuelto_at ? ` · resuelto ${fmt.fecha(t.resuelto_at)}` : ''}</div>
          ${!t.cubierto && montos ? html`<div class="row small" style="margin-top:6px">
            ${t.cambio_id ? html`<span class="badge primary">Agregado al cobro: ${dinero(t.monto_adicional, x.moneda)}</span>`
              : gestion ? html`<input class="input sm" type="number" min="0" step="0.01" placeholder="Monto adicional" data-ticket-monto="${t.id}" value="${t.monto_adicional ?? ''}" style="width:150px">
                  <button class="btn btn-xs" data-act="ticket-cobrar" data-id="${t.id}">${icon('dollar', 'sm')} Agregar al cobro</button>` : ''}</div>` : ''}</div>
          ${trabajar ? html`<select class="select sm" data-ticket-estado="${t.id}" style="width:auto">${opciones(Object.entries(ESTADO_TICKET).map(([k, v]) => [k, v[1]]), t.estado)}</select>` : html`<span class="badge ${te}">${ne}</span>`}
          </div>`; })}</div>`
        : vacio({ icono: 'shield', titulo: 'Sin incidencias', texto: 'Cuando el cliente reporte un problema o pida algo, regístralo aquí para dar seguimiento.' })}`;
  }

  // ── Horas y rentabilidad ────────────────────────────────────────────────
  function horasTab() {
    const x = p(), trabajar = can('proyectos.gestionar') || can('proyectos.trabajar'), rent = d.rentabilidad;
    const est = Number(x.horas_estimadas) || 0;
    return html`
      <div class="grid c2">
        <div class="card"><div class="card-head"><h3>${icon('clock', 'sm')} Horas</h3></div><div class="card-body">
          <div class="row between"><span class="muted small">Registradas</span><span class="kpi-value" style="font-size:20px;margin:0">${d.horas_total} h</span></div>
          ${est ? html`<div class="progress" style="margin:10px 0 6px"><div style="width:${raw(Math.min(100, (d.horas_total / est) * 100))}%;background:${raw(d.horas_total > est ? 'var(--danger)' : 'var(--primary)')}"></div></div>
            <div class="xs ${d.horas_total > est ? '' : 'muted'}" style="${d.horas_total > est ? 'color:var(--danger)' : ''}">${d.horas_total > est ? `Excedido en ${Math.round((d.horas_total - est) * 10) / 10} h sobre lo estimado (${est} h)` : `${Math.round((est - d.horas_total) * 10) / 10} h disponibles de ${est} h estimadas`}</div>`
            : html`<div class="xs muted mt">Indica las horas estimadas al editar el proyecto para comparar.</div>`}
          ${d.horas_por_usuario.length ? html`<div class="divider"></div>${d.horas_por_usuario.map(u => html`<div class="row between small" style="padding:3px 0"><span>${u.nombre}</span><b>${u.horas} h</b></div>`)}` : ''}
        </div></div>
        ${rent ? html`<div class="card"><div class="card-head"><h3>${icon('chart', 'sm')} Rentabilidad</h3><span class="xs muted">${rent.costo_hora ? `${dinero(rent.costo_hora, x.moneda)}/h` : 'sin costo por hora'}</span></div><div class="card-body stack sm small">
          <div class="row between"><span class="muted">Ingreso (sin IGV)</span><b>${dinero(rent.ingreso, x.moneda)}</b></div>
          <div class="row between"><span class="muted">Costo (${rent.horas} h)</span><b>${dinero(rent.costo, x.moneda)}</b></div>
          <div class="row between"><span class="muted">Margen</span><b style="color:${raw(rent.margen < 0 ? 'var(--danger)' : 'var(--success)')}">${dinero(rent.margen, x.moneda)}${rent.margen_pct !== null ? ` · ${rent.margen_pct} %` : ''}</b></div>
          ${rent.tarifa_efectiva ? html`<div class="row between"><span class="muted">Ganas por hora</span><b>${dinero(rent.tarifa_efectiva, x.moneda)}</b></div>` : ''}
          ${!rent.costo_hora ? html`<div class="xs muted">Define el costo por hora en Configuración → Proyectos (o en el proyecto) para ver el margen real.</div>` : ''}
        </div></div>` : ''}
      </div>
      ${trabajar ? html`<form class="card mt" data-horas><div class="card-body form-grid" style="grid-template-columns:140px 100px minmax(0,1fr) auto;align-items:end">
        <label class="field"><span>Fecha</span><input class="input sm" type="date" name="fecha" value="${hoyISO()}" max="${hoyISO()}"></label>
        <label class="field"><span>Horas</span><input class="input sm" type="number" name="horas" min="0.25" max="24" step="0.25" required placeholder="2.5"></label>
        <label class="field"><span>¿En qué trabajaste?</span><div class="row"><input class="input sm" name="descripcion" maxlength="300" placeholder="Ej. Pantalla de reportes">
          <select class="select sm" name="ref" style="width:auto"><option value="">Sin vincular</option>
            ${d.hitos.filter(h => !h.completado).map(h => html`<option value="h${h.id}">Hito: ${h.titulo}</option>`)}
            ${d.tickets.filter(t => ['abierto', 'en_proceso'].includes(t.estado)).map(t => html`<option value="t${t.id}">#${t.numero} ${t.titulo}</option>`)}</select></div></label>
        <button class="btn btn-primary btn-sm" type="submit">Registrar</button></div></form>` : ''}
      <div class="card mt"><div class="card-head"><h3>Registro</h3></div>
        ${d.horas.length ? d.horas.map(h => html`<div class="list-item"><div class="grow small"><b>${h.horas} h</b> · ${h.descripcion || html`<span class="muted">Sin descripción</span>`}
            <div class="xs muted">${fechaCorta(h.fecha)} · ${h.usuario_nombre || '—'}${h.hito_id ? ` · ${d.hitos.find(x => x.id === h.hito_id)?.titulo || 'hito'}` : ''}${h.ticket_id ? ` · incidencia #${d.tickets.find(x => x.id === h.ticket_id)?.numero || ''}` : ''}</div></div>
          ${can('proyectos.gestionar') || h.usuario_id === session.user.id ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="horas-borrar" data-id="${h.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</div>`)
          : html`<div class="card-body small muted">Aún no hay horas registradas.</div>`}</div>`;
  }

  // ── Archivos ────────────────────────────────────────────────────────────
  const TIPO_ARCHIVO = { contrato: 'Contrato', propuesta: 'Propuesta', acta: 'Acta de entrega', factura: 'Factura / boleta', diseno: 'Diseño', documentacion: 'Documentación', otro: 'Otro' };
  const peso = b => (b > 1048576 ? `${Math.round(b / 104857.6) / 10} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  function archivosTab() {
    const trabajar = can('proyectos.gestionar') || can('proyectos.trabajar');
    const tipos = Object.entries(TIPO_ARCHIVO).filter(([k]) => can('proyectos.montos') || !['contrato', 'propuesta', 'factura'].includes(k));
    return html`
      ${trabajar ? html`<form class="card mb" data-archivo><div class="card-body row wrap" style="align-items:end">
        <label class="field"><span>Tipo</span><select class="select sm" name="tipo">${opciones(tipos, tipos[0][0])}</select></label>
        <label class="field grow"><span>Archivo (PDF, Word, Excel, imagen, ZIP · máx. 15 MB)</span><input class="input sm" type="file" name="archivo" required style="padding:4px"></label>
        <button class="btn btn-primary btn-sm" type="submit">${icon('upload', 'sm')} Subir</button></div></form>` : ''}
      ${d.archivos.length ? html`<div class="card">${d.archivos.map(a => html`<div class="list-item">
        <div class="kpi-icon">${icon(/^image\//.test(a.mime || '') ? 'image' : 'file', 'sm')}</div>
        <div class="grow"><a class="strong" href="${a.url}" target="_blank" rel="noopener" download="${a.nombre}">${a.nombre}</a>
          <div class="xs muted">${TIPO_ARCHIVO[a.tipo] || a.tipo}${a.tamano ? ` · ${peso(a.tamano)}` : ''} · ${a.subido_por_nombre || '—'} · ${fmt.fecha(a.created_at)}</div></div>
        ${can('proyectos.gestionar') ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="archivo-borrar" data-id="${a.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</div>`)}</div>`
        : vacio({ icono: 'file', titulo: 'Sin archivos', texto: 'Guarda aquí el contrato, la propuesta, el acta de entrega y la documentación del proyecto.' })}`;
  }

  function pintar() {
    const vistas = { resumen, avance, pagos, soporte, horas: horasTab, archivos: archivosTab, historial };
    render(drawer, html`${cabecera()}<div class="drawer-body">${(vistas[tab] || resumen)()}</div>`);
    // Formularios de las pestañas
    $('[data-horas]', drawer)?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, ref = f.ref.value;
      await conCarga(f.querySelector('[type=submit]'), async () => {
        try {
          await api.post(`/api/proyectos/${id}/horas`, { fecha: f.fecha.value, horas: f.horas.value, descripcion: f.descripcion.value,
            hito_id: ref.startsWith('h') ? ref.slice(1) : null, ticket_id: ref.startsWith('t') ? ref.slice(1) : null });
          toast('Horas registradas'); recargar();
        } catch (ex) { toastError(ex); }
      });
    });
    $('[data-archivo]', drawer)?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      if (!f.archivo.files[0]) return;
      const fd = new FormData(); fd.append('tipo', f.tipo.value); fd.append('archivo', f.archivo.files[0]);
      await conCarga(f.querySelector('[type=submit]'), async () => {
        try { await api.form('POST', `/api/proyectos/${id}/archivos`, fd); toast('Archivo subido'); recargar(); } catch (ex) { toastError(ex); }
      });
    });
  }
  const recargar = async () => { cambiado = true; if (await cargar()) pintar(); };

  acciones(drawer, {
    cerrar,
    tab: b => { tab = b.dataset.tab; pintar(); },
    cliente: () => { cerrar(); location.hash = `#/contactos/${p().negocio_id}`; },
    editar: async () => { if (await formProyecto(p(), { cuotas: d.cuotas })) recargar(); },
    estado: b => cambiarEstado(b.dataset.e),
    mas: b => {
      const sec = (b.dataset.sec || '').split(',').filter(Boolean);
      menu(b, [
        ...sec.map(t => ({ label: ACCIONES_ESTADO[t][0], icon: ACCIONES_ESTADO[t][1], danger: t === 'cancelado', onClick: () => cambiarEstado(t) })),
        ...(['propuesta', 'cancelado'].includes(p().estado) ? [sec.length ? '-' : null, { label: 'Eliminar proyecto', icon: 'trash', danger: true, onClick: eliminar }].filter(Boolean) : []),
      ].filter(Boolean));
    },
    cobro: () => registrarCobro(),
    // Avance
    'hitos-estandar': async b => conCarga(b, async () => { try { await api.post(`/api/proyectos/${id}/hitos/plantilla`); toast('Hitos estándar agregados'); recargar(); } catch (e) { toastError(e); } }),
    'hito-nuevo': () => formHito(),
    'hito-editar': b => formHito(d.hitos.find(h => h.id === +b.dataset.id)),
    'hito-borrar': async b => {
      if (!(await confirmar('¿Eliminar este hito?', { ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/proyectos/hitos/${b.dataset.id}`); recargar(); } catch (e) { toastError(e); }
    },
    'cambio-nuevo': () => formModal({
      title: 'Cambio de alcance', subtitle: 'Algo que el cliente pide fuera de lo acordado.', submit: 'Registrar',
      fields: html`<label class="field span-2"><span>¿Qué pidió? *</span><input class="input" name="titulo" required maxlength="200" placeholder="Ej. Agregar módulo de inventario"></label>
        <label class="field span-2"><span>Detalle</span><textarea class="input" name="descripcion" rows="3"></textarea></label>
        ${can('proyectos.montos') ? html`<label class="field"><span>Monto adicional</span><input class="input" type="number" name="monto" min="0" step="0.01" placeholder="0.00"></label>` : ''}
        <label class="field"><span>Días adicionales</span><input class="input" type="number" name="dias_extra" min="0" max="3650" value="0"></label>
        <label class="check span-2"><input type="checkbox" name="aprobar"> El cliente ya lo aprobó (sumar ahora al proyecto)</label>`,
      onSubmit: async f => {
        const r = await api.post(`/api/proyectos/${id}/cambios`, f);
        if (f.aprobar) await api.post(`/api/proyectos/cambios/${r.id}/aprobar`);
        toast(f.aprobar ? 'Cambio aprobado y sumado al proyecto' : 'Cambio registrado'); recargar();
      },
    }),
    'cambio-aprobar': async b => {
      if (!(await confirmar('Se sumará el monto al proyecto (con una cuota nueva) y se extenderá el plazo si tiene días adicionales.', { titulo: 'Aprobar cambio', ok: 'Aprobar' }))) return;
      try { await api.post(`/api/proyectos/cambios/${b.dataset.id}/aprobar`); toast('Cambio aprobado'); recargar(); } catch (e) { toastError(e); }
    },
    'cambio-rechazar': async b => { try { await api.post(`/api/proyectos/cambios/${b.dataset.id}/rechazar`); recargar(); } catch (e) { toastError(e); } },
    'cambio-borrar': async b => {
      if (!(await confirmar('¿Eliminar este cambio?', { ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/proyectos/cambios/${b.dataset.id}`); recargar(); } catch (e) { toastError(e); }
    },
    // Incidencias
    'ticket-nuevo': () => formTicket(),
    'ticket-ver': b => formTicket(d.tickets.find(t => t.id === +b.dataset.id)),
    'ticket-cobrar': async b => {
      const input = $(`[data-ticket-monto="${b.dataset.id}"]`, drawer);
      try {
        await api.put(`/api/proyectos/tickets/${b.dataset.id}`, { monto_adicional: input.value });
        await api.post(`/api/proyectos/tickets/${b.dataset.id}/cobrar`);
        toast('Agregado al cobro del proyecto'); recargar();
      } catch (e) { toastError(e); }
    },
    // Horas y archivos
    'horas-borrar': async b => { try { await api.del(`/api/proyectos/horas/${b.dataset.id}`); recargar(); } catch (e) { toastError(e); } },
    'archivo-borrar': async b => {
      if (!(await confirmar('Se eliminará el archivo definitivamente.', { titulo: 'Eliminar archivo', ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/proyectos/archivos/${b.dataset.id}`); toast('Archivo eliminado'); recargar(); } catch (e) { toastError(e); }
    },
    'borrar-pago': async b => {
      if (!(await confirmar('Se anulará este cobro y el saldo volverá a aumentar.', { titulo: 'Anular cobro', ok: 'Anular', peligro: true }))) return;
      try { await api.del(`/api/proyectos/pagos/${b.dataset.id}`); toast('Cobro anulado'); recargar(); } catch (e) { toastError(e); }
    },
  });

  // Cambios rápidos en las listas (sin abrir modales)
  drawer.addEventListener('change', async e => {
    const t = e.target;
    try {
      if (t.dataset.hito) {
        await api.post(`/api/proyectos/hitos/${t.dataset.hito}/completar`, { completado: t.checked });
        recargar();
      } else if (t.dataset.ticketEstado) {
        await api.put(`/api/proyectos/tickets/${t.dataset.ticketEstado}`, { estado: t.value });
        toast('Incidencia actualizada'); recargar();
      }
    } catch (ex) { toastError(ex); recargar(); }
  });

  function formHito(h = null) {
    return formModal({
      title: h ? 'Editar hito' : 'Nuevo hito', submit: h ? 'Guardar' : 'Agregar',
      fields: html`<label class="field span-2"><span>Título *</span><input class="input" name="titulo" required maxlength="200" value="${h?.titulo || ''}" placeholder="Ej. Módulo de reportes"></label>
        <label class="field"><span>Fecha objetivo</span><input class="input" type="date" name="fecha_objetivo" value="${h?.fecha_objetivo || ''}"></label>
        <label class="field"><span>Peso en el avance</span><input class="input" type="number" name="peso" min="1" max="100" value="${h?.peso || 1}"><span class="hint">Un hito de peso 4 vale 4 veces uno de peso 1.</span></label>
        <label class="field span-2"><span>Detalle</span><textarea class="input" name="descripcion" rows="3">${h?.descripcion || ''}</textarea></label>`,
      onSubmit: async f => {
        if (h) await api.put(`/api/proyectos/hitos/${h.id}`, f); else await api.post(`/api/proyectos/${id}/hitos`, f);
        recargar();
      },
    });
  }

  async function formTicket(t = null) {
    const us = await usuarios();
    const x = p();
    return formModal({
      title: t ? `Incidencia #${t.numero}` : 'Nueva incidencia', size: 'lg', submit: t ? 'Guardar' : 'Registrar',
      subtitle: t ? `${t.cubierto ? 'Cubierta por el soporte' : 'Fuera de soporte'} · reportada ${fmt.fechaHora(t.created_at)}${t.creado_por_nombre ? ` por ${t.creado_por_nombre}` : ''}` : null,
      fields: html`<label class="field span-2"><span>¿Qué pasa? *</span><input class="input" name="titulo" required maxlength="200" value="${t?.titulo || ''}" placeholder="Ej. No se puede imprimir la boleta"></label>
        <label class="field"><span>Tipo</span><select class="select" name="tipo">${opciones(Object.entries(TIPO_TICKET), t?.tipo || 'error')}</select></label>
        <label class="field"><span>Prioridad</span><select class="select" name="prioridad">${opciones([['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta'], ['urgente', 'Urgente']], t?.prioridad || 'media')}</select></label>
        <label class="field"><span>Asignar a</span><select class="select" name="asignado_a">${opciones(us, t?.asignado_a || x.responsable_id, { vacio: 'Sin asignar' })}</select></label>
        ${t ? html`<label class="field"><span>Estado</span><select class="select" name="estado">${opciones(Object.entries(ESTADO_TICKET).map(([k, v]) => [k, v[1]]), t.estado)}</select></label>` : html`<div></div>`}
        <label class="field span-2"><span>Detalle</span><textarea class="input" name="descripcion" rows="4" placeholder="Pasos para reproducirlo, pantalla, mensaje de error…">${t?.descripcion || ''}</textarea></label>
        ${t ? html`<label class="field span-2"><span>Solución</span><textarea class="input" name="solucion" rows="3" placeholder="Qué se hizo para resolverlo">${t.solucion || ''}</textarea></label>` : ''}
        ${t && can('proyectos.gestionar') ? html`<label class="check span-2"><input type="checkbox" name="cubierto" ${t.cubierto ? raw('checked') : ''} ${t.cambio_id ? raw('disabled') : ''}> Cubierta por el soporte (sin costo para el cliente)</label>` : ''}`,
      onSubmit: async f => {
        if (t) { if (f.cubierto !== undefined) f.cubierto = f.cubierto ? 1 : 0; await api.put(`/api/proyectos/tickets/${t.id}`, f); toast('Incidencia actualizada'); }
        else { const r = await api.post(`/api/proyectos/${id}/tickets`, f); toast(r.cubierto ? `Incidencia #${r.numero} registrada` : `Incidencia #${r.numero} registrada fuera de soporte`); }
        recargar();
      },
    });
  }

  async function cambiarEstado(e) {
    const x = p();
    if (e === 'entregar') {
      const r = await formModal({ title: 'Marcar como entregado', size: 'sm', submit: 'Confirmar entrega',
        subtitle: x.dias_soporte > 0 ? `Desde esta fecha corren los ${x.dias_soporte} días de soporte.` : 'El proyecto no tiene días de soporte: quedará cerrado.',
        fields: html`<label class="field span-2"><span>Fecha de entrega</span><input class="input" type="date" name="fecha" value="${hoyISO()}" required></label>`,
        onSubmit: dd => api.post(`/api/proyectos/${id}/estado`, { estado: 'entregar', fecha: dd.fecha }) }).done;
      if (r) { toast('Proyecto entregado'); recargar(); }
      return;
    }
    if (['cancelado', 'pausado'].includes(e)) {
      const r = await formModal({ title: e === 'cancelado' ? 'Cancelar proyecto' : 'Pausar proyecto', size: 'sm', submit: e === 'cancelado' ? 'Cancelar proyecto' : 'Pausar',
        fields: html`<label class="field span-2"><span>Motivo (opcional)</span><input class="input" name="motivo" maxlength="300"></label>`,
        onSubmit: dd => api.post(`/api/proyectos/${id}/estado`, { estado: e, motivo: dd.motivo }) }).done;
      if (r) { toast(ESTADOS[e][1]); recargar(); }
      return;
    }
    if (e === 'cerrado' && !(await confirmar('El proyecto quedará cerrado aunque le queden días de soporte.', { titulo: 'Cerrar proyecto', ok: 'Cerrar' }))) return;
    try { await api.post(`/api/proyectos/${id}/estado`, { estado: e }); toast(e === 'aprobado' ? 'Proyecto aprobado: el cliente pasó a Ganado' : `Estado: ${ESTADOS[e]?.[1] || e}`); recargar(); }
    catch (ex) { toastError(ex); }
  }

  async function registrarCobro() {
    const x = p();
    const sugerido = x.proxima_cuota ? Math.round((x.proxima_cuota.monto - x.proxima_cuota.cubierto) * 100) / 100 : x.saldo;
    const m = modal({
      title: 'Registrar cobro', subtitle: `Saldo pendiente: ${dinero(x.saldo, x.moneda)}`, size: 'sm',
      body: html`<form class="form-grid" data-f>
        <label class="field"><span>Monto *</span><input class="input" type="number" name="monto" min="0.01" step="0.01" max="${x.saldo}" value="${sugerido}" required></label>
        <label class="field"><span>Fecha</span><input class="input" type="date" name="fecha" value="${hoyISO()}"></label>
        <label class="field"><span>Método</span><select class="select" name="metodo">${opciones(Object.entries(METODOS), 'transferencia')}</select></label>
        <label class="field"><span>N.° de operación</span><input class="input" name="referencia" maxlength="150"></label>
        <label class="field span-2"><span>Foto del comprobante (opcional)</span><input class="input" type="file" name="comprobante" accept="image/jpeg,image/png,image/webp" style="padding:5px"></label>
        ${x.proxima_cuota ? html`<p class="xs muted span-2">Se aplica primero a: ${x.proxima_cuota.concepto}.</p>` : ''}</form>`,
      foot: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-ok>Registrar</button>`,
      onMount: mm => $('[data-ok]', mm.el).addEventListener('click', async ev => {
        const f = $('[data-f]', mm.el);
        if (!f.reportValidity()) return;
        const fd = new FormData();
        ['monto', 'fecha', 'metodo', 'referencia'].forEach(k => fd.append(k, f[k].value));
        if (f.comprobante.files[0]) fd.append('comprobante', f.comprobante.files[0]);
        await conCarga(ev.currentTarget, async () => {
          try { await api.form('POST', `/api/proyectos/${id}/pagos`, fd); toast('Cobro registrado'); mm.close(true); tab = 'pagos'; recargar(); }
          catch (e) { toastError(e); }
        });
      }),
    });
    return m;
  }

  async function eliminar() {
    if (!(await confirmar(`Se eliminará ${p().codigo} con su plan de pagos.`, { titulo: 'Eliminar proyecto', ok: 'Eliminar', peligro: true }))) return;
    try { await api.del(`/api/proyectos/${id}`); toast('Proyecto eliminado'); cambiado = true; cerrar(); } catch (e) { toastError(e); }
  }

  if (await cargar()) pintar();
}
