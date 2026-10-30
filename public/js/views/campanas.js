// Campañas por WhatsApp con plantillas aprobadas por Meta
import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, $, $$, cargando, modal, conCarga, etapas, usuarios, opciones, debounce, bus, inputFecha, esc } from '../core.js';
import { camposUbigeo, enlazarUbigeo, pager } from '../ui.js';

const ESTADOS = {
  borrador: ['', 'Borrador'], programada: ['info', 'Programada'], enviando: ['success', 'Enviando'], pausada: ['warning', 'Pausada'],
  completada: ['primary', 'Completada'], cancelada: ['', 'Cancelada'],
};
let st, subs = [];
export function destroy() { subs.forEach(f => f()); subs = []; }

export async function render(el, params) {
  st = { rows: [], plantillas: null, variables: null };
  dibujar(el, html`
    <div class="page-head"><div><h1>Campañas</h1><p>Mensajes masivos por WhatsApp con plantillas aprobadas por Meta.</p></div>
      <div class="actions"><a class="btn" href="#/whatsapp/plantillas">${icon('template', 'sm')} Plantillas</a>
      ${can('campanas.gestionar') ? html`<button class="btn btn-primary" data-act="nueva">${icon('plus', 'sm')} Nueva campaña</button>` : ''}</div></div>
    <div data-aviso></div>
    <div class="card" data-lista>${cargando()}</div>`);
  acciones(el, {
    nueva: () => asistente(el),
    accion: async b => {
      const a = b.dataset.a;
      if (a === 'cancelar' && !(await confirmar('Los mensajes que aún no se enviaron no se enviarán.', { titulo: 'Cancelar campaña', ok: 'Cancelar campaña', peligro: true }))) return;
      try { const r = await api.post(`/api/campanas/${b.dataset.id}/${a}`); toast(r.msg); cargar(el); } catch (e) { toastError(e); }
    },
    reintentar: async b => { try { const r = await api.post(`/api/campanas/${b.dataset.id}/reintentar`); toast(`${r.reintentos} mensaje(s) vuelven a la cola`); cargar(el); } catch (e) { toastError(e); } },
    duplicar: async b => { try { await api.post(`/api/campanas/${b.dataset.id}/duplicar`); toast('Campaña duplicada como borrador'); cargar(el); } catch (e) { toastError(e); } },
    borrar: async b => {
      if (!(await confirmar('Se eliminará la campaña. Los mensajes enviados quedan en el historial.', { titulo: 'Eliminar campaña', ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/campanas/${b.dataset.id}`); cargar(el); } catch (e) { toastError(e); }
    },
    detalle: b => detalle(st.rows.find(c => c.id === +b.dataset.id)),
  });
  const refrescar = debounce(() => cargar(el), 1500);
  ['campana:estado', 'envio:progreso', 'envio:control', 'envio:estado', 'plantilla:estado'].forEach(ev => subs.push(bus.on(ev, refrescar)));
  await cargar(el);
  if (params[0] === 'nueva' && can('campanas.gestionar')) {
    const ids = JSON.parse(sessionStorage.getItem('envio_ids') || 'null');
    sessionStorage.removeItem('envio_ids');
    asistente(el, { ids });
  }
}

async function cargar(el) {
  try {
    const r = await api.get('/api/campanas');
    st.rows = r.rows;
    const enCurso = r.rows.some(c => c.estado === 'enviando');
    dibujar($('[data-aviso]', el), enCurso && r.bloqueo ? html`<div class="alert warning mb">${icon('clock')}<div>${r.bloqueo.msg}</div></div>` : '');
    dibujar($('[data-lista]', el), r.rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr>
        <th>Campaña</th><th>Estado</th><th style="min-width:180px">Progreso</th><th>Entregados</th><th>Leídos</th><th></th></tr></thead><tbody>
      ${r.rows.map(c => fila(c))}</tbody></table></div>`
      : vacio({ icono: 'megaphone', titulo: 'Aún no hay campañas', texto: 'Elige una plantilla aprobada, a quién enviarla y cuándo. El sistema respeta tu horario y límite diario.',
          accion: can('campanas.gestionar') ? html`<button class="btn btn-primary" data-act="nueva">${icon('plus', 'sm')} Nueva campaña</button>` : '' }));
  } catch (e) { toastError(e); }
}

function fila(c) {
  const [tone, txt] = ESTADOS[c.estado] || ['', c.estado];
  const hechos = Number(c.enviados) + Number(c.fallidos);
  const total = Number(c.total) || hechos + Number(c.pendientes);
  const pct = total ? Math.round((hechos / total) * 100) : 0;
  const legado = c.tipo === 'texto';
  const ej = can('envios.ejecutar') && !legado;
  const btn = (a, t, extra = '') => html`<button class="btn btn-xs ${extra}" data-act="accion" data-a="${a}" data-id="${c.id}">${t}</button>`;
  return html`<tr>
    <td><a href="#" class="strong" data-act="detalle" data-id="${c.id}">${c.nombre}</a>
      <div class="xs muted">${legado ? 'Sistema anterior · texto libre' : html`Plantilla <span class="mono">${c.plantilla || c.template_nombre || '—'}</span>`}
        ${c.programada_at && c.estado === 'programada' ? ` · ${fmt.fechaHora(c.programada_at)}` : ''}</div>
      ${c.ultimo_error && ['pausada', 'enviando'].includes(c.estado) ? html`<div class="xs" style="color:var(--warning)">${c.ultimo_error}</div>` : ''}</td>
    <td><span class="badge ${tone}">${txt}</span></td>
    <td>${Number(c.contactos_cargados ?? 1) || total ? html`<div class="row small"><span class="num">${fmt.num(c.enviados)}${total ? ` / ${fmt.num(total)}` : ''}</span>
        ${Number(c.fallidos) ? html`<span class="xs" style="color:var(--danger)">${fmt.num(c.fallidos)} fallidos</span>` : ''}</div>
      <div class="progress" style="margin-top:5px"><div style="width:${raw(pct)}%"></div></div>` : html`<span class="xs muted">Se calcula al iniciar</span>`}</td>
    <td class="small num">${fmt.pct(c.entregados, c.enviados)}</td>
    <td class="small num">${fmt.pct(c.leidos, c.enviados)}</td>
    <td class="actions"><div class="row" style="justify-content:flex-end">
      ${ej && c.estado === 'borrador' ? btn('iniciar', 'Iniciar', 'btn-success') : ''}
      ${ej && ['enviando', 'programada'].includes(c.estado) ? btn('pausar', 'Pausar') : ''}
      ${ej && c.estado === 'pausada' ? btn('reanudar', 'Reanudar', 'btn-success') : ''}
      ${ej && ['borrador', 'programada', 'enviando', 'pausada'].includes(c.estado) ? btn('cancelar', 'Cancelar', 'btn-ghost') : ''}
      ${ej && Number(c.fallidos) && ['completada', 'pausada', 'enviando'].includes(c.estado) ? html`<button class="btn btn-xs btn-ghost" data-act="reintentar" data-id="${c.id}" title="Reintentar fallidos">${icon('refresh', 'sm')}</button>` : ''}
      ${can('campanas.gestionar') && !legado ? html`<button class="btn btn-xs btn-ghost btn-icon" data-act="duplicar" data-id="${c.id}" title="Duplicar">${icon('copy', 'sm')}</button>` : ''}
      ${can('campanas.gestionar') && ['borrador', 'cancelada', 'completada'].includes(c.estado) ? html`<button class="btn btn-xs btn-ghost btn-icon" data-act="borrar" data-id="${c.id}" title="Eliminar">${icon('trash', 'sm')}</button>` : ''}
    </div></td></tr>`;
}

// Detalle: mensaje y contactos de la campaña
function detalle(c) {
  const ESTADO_ENVIO = { pendiente: ['warning', 'En cola'], procesando: ['warning', 'Enviando'], enviado: ['info', 'Enviado'], entregado: ['primary', 'Entregado'], leido: ['success', 'Leído'], fallido: ['danger', 'Fallido'], cancelado: ['', 'Cancelado'] };
  let off = 0, filtro = '';
  modal({
    title: c.nombre, subtitle: `${(ESTADOS[c.estado] || ['', c.estado])[1]} · creada ${fmt.fecha(c.created_at)}${c.creado_por_nombre ? ` por ${c.creado_por_nombre}` : ''}`, size: 'lg',
    body: html`<div class="bubble out" style="max-width:100%;margin-bottom:14px">${c.mensaje}</div>
      ${c.imagen_url ? html`<img src="${c.imagen_url}" alt="" style="max-height:120px;border-radius:6px;margin-bottom:14px">` : ''}
      <div class="row mb"><select class="select sm" data-f style="width:auto">${opciones(Object.entries(ESTADO_ENVIO).map(([k, v]) => [k, v[1]]), '', { vacio: 'Todos' })}</select></div>
      <div class="card"><div class="table-wrap" data-t>${cargando()}</div><div data-p></div></div>`,
    onMount: m => {
      const cargarEnv = async () => {
        const r = await api.get(`/api/campanas/${c.id}/envios`, { estado: filtro, limit: 20, offset: off });
        dibujar($('[data-t]', m.el), r.rows.length ? html`<table class="table"><thead><tr><th>Contacto</th><th>Estado</th><th>Enviado</th><th>Detalle</th></tr></thead><tbody>
          ${r.rows.map(e => { const [t, x] = ESTADO_ENVIO[e.estado] || ['', e.estado];
            return html`<tr><td class="small strong">${e.nombre}<div class="xs muted">${e.numero || ''}</div></td><td><span class="badge ${t}">${x}</span></td>
              <td class="xs nowrap">${e.enviado_at ? fmt.fechaHora(e.enviado_at) : '—'}</td><td class="xs muted" style="max-width:260px">${e.error_msg || ''}</td></tr>`; })}
          </tbody></table>` : html`<p class="muted small center" style="padding:20px">${Number(c.contactos_cargados) ? 'Sin mensajes con ese estado.' : 'Los contactos se cargan cuando la campaña empieza a enviarse.'}</p>`);
        dibujar($('[data-p]', m.el), r.total > 20 ? pager(r.total, off, 20) : '');
      };
      $('[data-f]', m.el).addEventListener('change', e => { filtro = e.target.value; off = 0; cargarEnv(); });
      m.el.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (b?.dataset.act === 'prev') { off = Math.max(0, off - 20); cargarEnv(); }
        if (b?.dataset.act === 'next') { off += 20; cargarEnv(); }
      });
      cargarEnv().catch(toastError);
    },
  });
}

// ── Asistente: plantilla → datos → audiencia → cuándo ──────────────────────
async function asistente(el, { ids } = {}) {
  try {
    if (!st.plantillas) st.plantillas = (await api.get('/api/whatsapp/plantillas')).rows;
    if (!st.variables) st.variables = (await api.get('/api/campanas/variables')).variables;
  } catch (e) { return toastError(e); }
  const aprobadas = st.plantillas.filter(t => t.estado === 'APPROVED' && (!t.header || ['TEXT', 'IMAGE'].includes(t.header)));
  if (!aprobadas.length) {
    return modal({ title: 'Nueva campaña', size: 'sm',
      body: html`<p class="muted">No tienes plantillas aprobadas por Meta. Crea una (categoría Marketing) y espera su aprobación; suele tardar entre minutos y unas horas.</p>`,
      foot: html`<button class="btn" data-close>Cerrar</button><a class="btn btn-primary" href="#/whatsapp/plantillas" data-close>Crear plantilla</a>` });
  }
  const [ets, us] = await Promise.all([etapas(), can('contactos.ver_todos') ? usuarios() : []]);
  const vars = Object.entries(st.variables);

  modal({
    title: 'Nueva campaña', subtitle: ids ? `${ids.length} contactos seleccionados desde Contactos` : null, size: 'lg',
    body: html`<form class="stack" data-f novalidate>
      <label class="field"><span>Nombre de la campaña *</span><input class="input" name="nombre" required maxlength="150" placeholder="Ej. Promoción noviembre — ferreterías Lima sur"></label>
      <div class="divider" style="margin:4px 0"></div>
      <div class="label">1. Plantilla</div>
      <select class="select" name="plantilla">${aprobadas.map((t, i) => html`<option value="${i}">${t.nombre} · ${t.idioma} · ${{ MARKETING: 'Marketing', UTILITY: 'Utilidad' }[t.categoria] || t.categoria}</option>`)}</select>
      <div data-vars></div>
      <div class="field hidden" data-img><span>Imagen del encabezado *</span><input type="file" name="imagen" accept="image/jpeg,image/png" class="input" style="padding:5px"><span class="hint">JPG o PNG, máx. 5 MB.</span></div>
      <div><div class="label" style="margin-bottom:6px">Vista previa</div><div class="bubble out" style="max-width:100%" data-prev></div></div>
      <div class="divider" style="margin:4px 0"></div>
      <div class="label">2. ¿A quién?</div>
      ${ids ? html`<p class="small muted">${ids.length} contactos elegidos en la lista de Contactos.</p>` : html`<div class="form-grid">
        <select class="select" name="etapa">${opciones(ets.map(e => [e.clave, e.nombre]), '', { vacio: 'Cualquier etapa' })}</select>
        <select class="select" name="wa">${opciones([['aptos', 'Con número apto para WhatsApp'], ['wa_ok', 'Solo WhatsApp confirmado']], 'aptos')}</select>
        ${camposUbigeo({}, { vacio: 'Todos' })}
        <input class="input" name="rubro" placeholder="Rubro (opcional)">
        <input class="input" name="etiqueta" placeholder="Etiqueta (opcional)">
        ${us.length ? html`<select class="select" name="asignado">${opciones([['yo', 'Mis contactos'], ['sin', 'Sin asignar'], ...us.map(u => [u.id, u.nombre])], '', { vacio: 'De todos los vendedores' })}</select>` : ''}
        <label class="field"><span class="xs muted">Máximo de mensajes</span><input class="input" type="number" name="maximo" min="1" max="20000" value="1000"></label>
      </div>`}
      <div class="card"><div class="card-body small" data-aud>${cargando('Calculando…')}</div></div>
      <label class="field"><span>Después de enviar, mover el contacto a</span><select class="select" name="etapa_destino">${opciones([['sin_cambio', 'No cambiar la etapa'], ...ets.map(e => [e.clave, e.nombre])], 'sin_cambio')}</select></label>
      <div class="divider" style="margin:4px 0"></div>
      <div class="label">3. ¿Cuándo?</div>
      <div class="seg" data-cuando><button type="button" class="active" data-c="ahora">Enviar ahora</button><button type="button" data-c="programar">Programar</button><button type="button" data-c="borrador">Guardar como borrador</button></div>
      <input class="input hidden" type="datetime-local" name="programada_at" value="${inputFecha(new Date(Date.now() + 3600e3))}">
      <p class="xs muted">Se envía dentro del horario y el límite diario de Configuración → Envíos masivos. Se excluyen los números sin WhatsApp y quienes ya recibieron esta campaña.</p>
    </form>`,
    foot: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-crear>Crear campaña</button>`,
    onMount: async m => {
      const f = $('[data-f]', m.el);
      let cuando = 'ahora';
      const tpl = () => aprobadas[+f.plantilla.value];
      const pintarVars = () => {
        const t = tpl();
        const nombres = t.variables_nombres || [];
        dibujar($('[data-vars]', f), t.variables ? html`<div class="small muted" style="margin:4px 0 8px">Qué va en cada dato variable:</div>
          <div class="form-grid">${Array.from({ length: t.variables }, (_, i) => {
            const pre = nombres[i] && st.variables[nombres[i]] ? nombres[i] : (i === 0 ? 'contacto' : '');
            return html`<label class="field"><span class="mono xs">{{${i + 1}}}</span><div class="row">
              <select class="select" name="v${i}">${vars.map(([k, txt]) => html`<option value="dato:${k}" ${pre === k ? raw('selected') : ''}>${txt}</option>`)}<option value="fijo" ${pre ? '' : raw('selected')}>Texto fijo…</option></select>
              <input class="input ${pre ? 'hidden' : ''}" name="f${i}" placeholder="Texto fijo" maxlength="200"></div></label>`;
          })}</div>` : html`<p class="xs muted">Esta plantilla no tiene datos variables.</p>`);
        $('[data-img]', f).classList.toggle('hidden', t.header !== 'IMAGE');
        preview();
      };
      const ejemplo = { nombre: 'Ferretería San Martín', contacto: 'María', telefono: '987654321', distrito: 'Miraflores', provincia: 'Lima', departamento: 'Lima', rubro: 'ferreterías', responsable: 'Carlos' };
      const mapeo = () => Array.from({ length: tpl().variables }, (_, i) => {
        const s = f[`v${i}`].value;
        return s.startsWith('dato:') ? { tipo: 'dato', valor: s.slice(5) } : { tipo: 'fijo', valor: f[`f${i}`].value.trim() };
      });
      const preview = () => {
        const mp = mapeo();
        $('[data-prev]', f).textContent = tpl().cuerpo.replace(/{{(\d+)}}/g, (x, n) => { const v = mp[n - 1]; return !v ? x : v.tipo === 'dato' ? ejemplo[v.valor] || x : (v.valor || x); });
      };
      const filtros = () => {
        if (ids) return { ids };
        const o = {};
        ['etapa', 'wa', 'rubro', 'etiqueta', 'asignado', 'maximo'].forEach(k => { if (f[k]?.value) o[k] = f[k].value; });
        if (f.departamento.value) o.dep = f.departamento.value;
        if (f.provincia.value) o.prov = f.provincia.value;
        if (f.distrito.value) o.dist = f.distrito.value;
        return o;
      };
      const calcular = debounce(async () => {
        try {
          const r = await api.post('/api/campanas/audiencia', { filtros: filtros() });
          const n = Math.min(r.total, ids ? r.total : (+f.maximo?.value || r.total));
          const dias = Math.ceil(n / Math.max(1, r.limite_diario));
          dibujar($('[data-aud]', m.el), html`<div class="row"><span class="kpi-value" style="font-size:20px">${fmt.num(r.total)}</span><span class="muted">contactos cumplen los filtros${r.total > n ? ` · se enviarán ${fmt.num(n)}` : ''}</span></div>
            ${r.muestra.length ? html`<div class="xs muted" style="margin-top:4px">Ej.: ${r.muestra.map(x => x.nombre).join(', ')}…</div>` : ''}
            ${dias > 1 ? html`<div class="xs" style="color:var(--warning);margin-top:6px">Con el límite de ${fmt.num(r.limite_diario)} mensajes por día tomará unos ${dias} días; continúa sola cada día.</div>` : ''}`);
        } catch (e) { dibujar($('[data-aud]', m.el), html`<span style="color:var(--danger)">${e.message}</span>`); }
      }, 350);
      f.addEventListener('change', e => {
        if (e.target.name === 'plantilla') pintarVars();
        if (/^v\d+$/.test(e.target.name)) { f[`f${e.target.name.slice(1)}`].classList.toggle('hidden', e.target.value !== 'fijo'); preview(); }
        if (!/^[vf]\d+$/.test(e.target.name) && e.target.name !== 'plantilla' && e.target.name !== 'etapa_destino') calcular();
      });
      f.addEventListener('input', e => { if (/^f\d+$/.test(e.target.name)) preview(); if (['rubro', 'etiqueta', 'maximo'].includes(e.target.name)) calcular(); });
      $('[data-cuando]', f).addEventListener('click', e => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        cuando = b.dataset.c;
        $$('[data-c]', f).forEach(x => x.classList.toggle('active', x === b));
        f.programada_at.classList.toggle('hidden', cuando !== 'programar');
        $('[data-crear]', m.el).textContent = { ahora: 'Crear y enviar', programar: 'Programar campaña', borrador: 'Guardar borrador' }[cuando];
      });
      $('[data-crear]', m.el).textContent = 'Crear y enviar';
      if (!ids) await enlazarUbigeo(f, calcular);
      pintarVars(); calcular();

      $('[data-crear]', m.el).addEventListener('click', async e => {
        if (!f.nombre.value.trim()) { f.nombre.reportValidity(); return; }
        const t = tpl(), mp = mapeo();
        if (mp.some(v => !v.valor)) return toast('Completa todos los datos variables.', 'warning');
        if (t.header === 'IMAGE' && !f.imagen.files[0]) return toast('Elige la imagen del encabezado.', 'warning');
        if (cuando === 'ahora' && !(await confirmar('La campaña empezará a enviarse de inmediato (dentro del horario permitido).', { titulo: 'Enviar campaña', ok: 'Enviar' }))) return;
        const fd = new FormData();
        fd.append('nombre', f.nombre.value.trim());
        fd.append('plantilla', `${t.nombre}|${t.idioma}`);
        fd.append('variables', JSON.stringify(mp));
        fd.append('filtros', JSON.stringify(filtros()));
        fd.append('etapa_destino', f.etapa_destino.value);
        if (cuando === 'programar') fd.append('programada_at', new Date(f.programada_at.value).toISOString());
        if (cuando === 'ahora') fd.append('iniciar', '1');
        if (f.imagen.files[0]) fd.append('imagen', f.imagen.files[0]);
        await conCarga(e.currentTarget, async () => {
          try {
            const r = await api.form('POST', '/api/campanas', fd);
            toast({ enviando: 'Campaña en marcha', programada: 'Campaña programada', borrador: 'Campaña guardada como borrador' }[r.estado] || 'Campaña creada');
            m.close(true); cargar(el);
          } catch (ex) { toastError(ex); }
        });
      });
    },
  });
}

export { esc };
