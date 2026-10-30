// Ficha de contacto en panel lateral (se abre desde contactos, pipeline, bandeja, leads…)
import { html, raw, icon, api, $, render, acciones, toast, toastError, confirmar, fmt, etapas, etapaBadge, avatar, can, cargando, vacio, opciones, conCarga, menu } from './core.js';
import { formContacto, formTarea, formReunion, enlaceWa, TIPO_ACTIVIDAD } from './ui.js';

export async function abrirContacto(id, { onCambio, tab = 'resumen' } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay drawer-wrap';
  render(ov, html`<div class="drawer" role="dialog" aria-modal="true">${cargando()}</div>`);
  document.body.appendChild(ov);
  const drawer = ov.firstElementChild;
  let cambiado = false;
  const cerrar = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (cambiado) onCambio?.(); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.overlay:not(.drawer-wrap)')) cerrar(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });

  let c, cuentas, actual = tab;
  const ets = await etapas();

  async function cargar() {
    try { ({ contacto: c, cuentas } = await api.get(`/api/contactos/${id}`)); }
    catch (e) { toastError(e); cerrar(); return false; }
    return true;
  }

  function cabecera() {
    const num = c.whatsapp || c.telefono_int || c.telefono;
    return html`<div class="drawer-head">
      <div class="row top">
        ${avatar(c.nombre, 'lg')}
        <div class="grow">
          <h2 class="truncate">${c.nombre}</h2>
          <div class="row wrap small muted" style="margin-top:4px">
            ${c.contacto_nombre ? html`<span>${icon('user', 'sm')} ${c.contacto_nombre}</span>` : ''}
            ${c.distrito ? html`<span>${icon('pin', 'sm')} ${c.distrito}</span>` : ''}
            ${c.asignado_nombre ? html`<span>· Asignado a <b>${c.asignado_nombre}</b></span>` : html`<span>· Sin asignar</span>`}
          </div>
        </div>
        <button class="icon-btn" data-act="cerrar" aria-label="Cerrar">${icon('x')}</button>
      </div>
      <div class="row wrap" style="margin:14px 0 4px">
        ${can('pipeline.mover') ? html`<select class="select sm" data-etapa style="width:auto">${opciones(ets.map(e => [e.clave, e.nombre]), c.estado_crm)}</select>` : etapaBadge(c.estado_crm)}
        ${can('chat.ver') ? html`<a class="btn btn-sm btn-success" href="#/bandeja/${c.id}" data-act="chat">${icon('whatsapp', 'sm')} Conversación</a>` : ''}
        ${num ? html`<a class="btn btn-sm" href="tel:${num}">${icon('phone', 'sm')} Llamar</a>` : ''}
        ${can('contactos.editar') ? html`<button class="btn btn-sm" data-act="editar">${icon('edit', 'sm')} Editar</button>` : ''}
        <button class="btn btn-sm btn-ghost btn-icon right" data-act="mas" aria-label="Más acciones">${icon('more')}</button>
      </div>
      <div class="tabs" style="margin:10px 0 0;border:0">
        ${[['resumen', 'Resumen'], ['actividad', 'Actividad'], ['tareas', `Tareas${cuentas.tareas ? ` (${cuentas.tareas})` : ''}`], ['reuniones', `Reuniones${cuentas.reuniones ? ` (${cuentas.reuniones})` : ''}`]]
          .map(([k, t]) => html`<button class="tab ${actual === k ? 'active' : ''}" data-act="tab" data-tab="${k}">${t}</button>`)}
      </div></div>`;
  }

  function resumen() {
    const f = (ic, label, val, href) => val ? html`<div class="row top" style="padding:9px 0;border-bottom:1px solid var(--border)">
      <span class="muted">${icon(ic, 'sm')}</span><div class="grow"><div class="xs muted">${label}</div>
      <div class="strong" style="word-break:break-word">${href ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${val}</a>` : val}</div></div></div>` : '';
    const wa = c.whatsapp || c.telefono_int;
    return html`<div class="grid c2">
      <div class="card"><div class="card-head"><h3>Datos de contacto</h3></div><div class="card-body" style="padding-top:4px">
        ${f('whatsapp', 'WhatsApp', wa, enlaceWa(wa))}
        ${f('phone', 'Teléfono', c.telefono)}
        ${f('mail', 'Correo', c.email, c.email ? `mailto:${c.email}` : null)}
        ${f('globe', 'Sitio web', c.website, /^https?:/.test(c.website || '') ? c.website : null)}
        ${f('pin', 'Dirección', c.direccion)}
        ${f('external', 'Google Maps', c.maps_url ? 'Ver en el mapa' : null, c.maps_url)}
        ${!wa && !c.telefono && !c.email ? html`<p class="muted small" style="padding-top:10px">Sin datos de contacto.</p>` : ''}
      </div></div>
      <div class="card"><div class="card-head"><h3>Oportunidad</h3></div><div class="card-body stack sm">
        <div class="row between"><span class="muted">Valor estimado</span><b>${c.valor_estimado ? fmt.moneda(c.valor_estimado) : '—'}</b></div>
        <div class="row between"><span class="muted">Rubro</span><span>${c.rubro_busqueda || '—'}</span></div>
        <div class="row between"><span class="muted">Origen</span><span class="badge">${c.origen || 'google'}</span></div>
        <div class="row between"><span class="muted">WhatsApp</span>${c.wa_verificado === 1 ? html`<span class="badge success">Activo</span>` : c.wa_verificado === 0 ? html`<span class="badge danger">Sin WhatsApp</span>` : html`<span class="badge">Sin verificar</span>`}</div>
        <div class="row between"><span class="muted">Ventana 24 h</span>${c.ventana_abierta ? html`<span class="badge success">Abierta</span>` : html`<span class="badge">Cerrada</span>`}</div>
        ${c.rating ? html`<div class="row between"><span class="muted">Google</span><span>${icon('star', 'sm')} ${c.rating} (${c.resenas})</span></div>` : ''}
        <div class="row between"><span class="muted">Creado</span><span>${fmt.fecha(c.created_at)}</span></div>
        <div class="row between"><span class="muted">Última actividad</span><span>${fmt.relativo(c.ultima_actividad_at)}</span></div>
        ${c.etiquetas ? html`<div class="row wrap" style="margin-top:4px">${c.etiquetas.split(',').map(t => html`<span class="tag">${icon('tag', 'sm')} ${t}</span>`)}</div>` : ''}
      </div></div>
    </div>
    ${c.descripcion || c.horarios ? html`<div class="card mt"><div class="card-body small">${c.descripcion ? html`<p>${c.descripcion}</p>` : ''}${c.horarios ? html`<p class="muted" style="margin-top:6px">${icon('clock', 'sm')} ${c.horarios}</p>` : ''}</div></div>` : ''}`;
  }

  async function actividad(cont) {
    const { rows } = await api.get(`/api/crm/${id}/historial`);
    render(cont, html`
      ${can('contactos.editar') ? html`<form class="card mb" data-nota><div class="card-body stack sm">
        <div class="seg" data-tipos>${[['comentario', 'Nota'], ['llamada', 'Llamada'], ['reunion', 'Reunión'], ['email', 'Correo'], ['visita', 'Visita']].map(([k, t], i) =>
          html`<button type="button" data-tipo="${k}" class="${i === 0 ? 'active' : ''}">${t}</button>`)}</div>
        <textarea class="input" name="contenido" rows="3" placeholder="¿Qué pasó? Ej.: Llamé, está interesado en el plan anual…" required></textarea>
        <div class="row"><button class="btn btn-primary btn-sm right" type="submit">Registrar</button></div></div></form>` : ''}
      ${rows.length ? html`<div class="timeline">${rows.map(h => {
        const [ic, label, tone] = TIPO_ACTIVIDAD[h.tipo] || TIPO_ACTIVIDAD.sistema;
        const borrable = ['comentario', 'llamada', 'reunion', 'email', 'whatsapp', 'visita'].includes(h.tipo) && h.usuario_id;
        return html`<div class="tl-item"><div class="tl-icon ${tone}">${icon(ic, 'sm')}</div><div class="tl-content">
          <div class="row"><b class="small">${label}</b><span class="xs muted">· ${h.usuario || 'Sistema'} · ${fmt.fechaHora(h.created_at)}</span>
          ${borrable ? html`<button class="btn btn-ghost btn-xs right" data-act="borrar-nota" data-id="${h.id}" aria-label="Borrar">${icon('trash', 'sm')}</button>` : ''}</div>
          <div class="text small" style="margin-top:2px">${h.contenido}</div></div></div>`;
      })}</div>` : vacio({ icono: 'activity', titulo: 'Sin actividad todavía', texto: 'Registra llamadas, notas y reuniones para tener el historial completo.' })}`);
    const form = $('[data-nota]', cont);
    if (form) {
      let tipo = 'comentario';
      $('[data-tipos]', form).addEventListener('click', e => {
        const b = e.target.closest('[data-tipo]'); if (!b) return;
        tipo = b.dataset.tipo; form.querySelectorAll('[data-tipo]').forEach(x => x.classList.toggle('active', x === b));
      });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        await conCarga(form.querySelector('[type=submit]'), async () => {
          try { await api.post(`/api/crm/${id}/actividad`, { tipo, contenido: form.contenido.value }); cambiado = true; actividad(cont); }
          catch (ex) { toastError(ex); }
        });
      });
    }
  }

  async function tareas(cont) {
    const { rows } = await api.get('/api/tareas', { negocio_id: id, estado: 'todas', asignado: can('contactos.ver_todos') ? 'todos' : 'yo' });
    render(cont, html`
      ${can('tareas.gestionar') ? html`<div class="row mb"><button class="btn btn-primary btn-sm" data-act="nueva-tarea">${icon('plus', 'sm')} Nueva tarea</button></div>` : ''}
      ${rows.length ? html`<div class="card">${rows.map(t => html`<div class="list-item">
        <label class="check"><input type="checkbox" data-act="toggle-tarea" data-id="${t.id}" ${t.estado === 'completada' ? raw('checked') : ''} ${can('tareas.gestionar') ? '' : raw('disabled')}></label>
        <div class="grow"><div class="strong" style="${t.estado === 'completada' ? 'text-decoration:line-through;opacity:.6' : ''}">${t.titulo}</div>
        <div class="xs muted">${t.vence_at ? `Vence ${fmt.fechaHora(t.vence_at)}` : 'Sin fecha'} · ${t.asignado_nombre || '—'}</div></div>
        <span class="badge ${t.prioridad === 'alta' ? 'danger' : t.prioridad === 'media' ? 'warning' : ''}">${t.prioridad}</span></div>`)}</div>`
        : vacio({ icono: 'checkSquare', titulo: 'Sin tareas', texto: 'Crea recordatorios de seguimiento para este contacto.' })}`);
  }

  async function reuniones(cont) {
    const { rows } = await api.get('/api/agenda', { negocio_id: id });
    render(cont, html`
      ${can('agenda.gestionar') ? html`<div class="row mb"><button class="btn btn-primary btn-sm" data-act="nueva-reunion">${icon('plus', 'sm')} Agendar reunión</button></div>` : ''}
      ${rows.length ? html`<div class="card">${rows.map(r => html`<div class="list-item">
        <div class="kpi-icon tone-primary">${icon(r.tipo === 'telefonica' ? 'phone' : r.tipo === 'presencial' ? 'pin' : 'video')}</div>
        <div class="grow"><div class="strong">${r.titulo}</div><div class="small muted">${fmt.dia(r.fecha_hora)} · ${fmt.hora(r.fecha_hora)} · ${r.duracion_min} min</div>
        ${r.enlace ? html`<a class="small" href="${r.enlace}" target="_blank" rel="noopener noreferrer">${r.enlace}</a>` : ''}</div>
        <span class="badge ${r.estado === 'realizada' ? 'success' : r.estado === 'agendada' ? 'primary' : ''}">${r.estado.replace('_', ' ')}</span></div>`)}</div>`
        : vacio({ icono: 'calendar', titulo: 'Sin reuniones', texto: 'Agenda una demo y el sistema enviará recordatorios automáticos.' })}`);
  }

  async function pintar() {
    render(drawer, html`${cabecera()}<div class="drawer-body" data-cont>${actual === 'resumen' ? resumen() : cargando()}</div>`);
    const cont = $('[data-cont]', drawer);
    try {
      if (actual === 'actividad') await actividad(cont);
      if (actual === 'tareas') await tareas(cont);
      if (actual === 'reuniones') await reuniones(cont);
    } catch (e) { toastError(e); }
    $('[data-etapa]', drawer)?.addEventListener('change', async e => {
      const etapa = e.target.value;
      const et = ets.find(x => x.clave === etapa);
      let motivo;
      if (et?.tipo === 'perdida') motivo = prompt('¿Por qué se perdió? (opcional)') ?? undefined;
      try { await api.patch(`/api/contactos/${id}/etapa`, { etapa, motivo }); toast(`Movido a ${et?.nombre}`); cambiado = true; c.estado_crm = etapa; }
      catch (ex) { toastError(ex); e.target.value = c.estado_crm; }
    });
  }

  acciones(drawer, {
    cerrar,
    chat: () => { cerrar(); location.hash = `#/bandeja/${id}`; },
    tab: el => { actual = el.dataset.tab; pintar(); },
    editar: async () => { if (await formContacto(c)) { cambiado = true; await cargar(); pintar(); toast('Contacto actualizado'); } },
    mas: el => menu(el, [
      ...(can('contactos.eliminar') ? [{ label: 'Eliminar contacto', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmar(`Se eliminará "${c.nombre}" con todo su historial, mensajes, tareas y reuniones.`, { titulo: 'Eliminar contacto', ok: 'Eliminar', peligro: true }))) return;
        try { await api.del(`/api/contactos/${id}`); toast('Contacto eliminado'); cambiado = true; cerrar(); } catch (e) { toastError(e); }
      } }] : []),
      { label: 'Copiar enlace de la ficha', icon: 'copy', onClick: () => navigator.clipboard?.writeText(`${location.origin}/#/contactos/${id}`).then(() => toast('Enlace copiado')) },
    ]),
    'borrar-nota': async el => {
      if (!(await confirmar('¿Borrar esta nota?', { ok: 'Borrar', peligro: true }))) return;
      try { await api.del(`/api/crm/actividad/${el.dataset.id}`); pintar(); } catch (e) { toastError(e); }
    },
    'nueva-tarea': async () => { if (await formTarea(null, { negocio: c })) { cambiado = true; await cargar(); pintar(); toast('Tarea creada'); } },
    'nueva-reunion': async () => { if (await formReunion(null, { negocio: c })) { cambiado = true; await cargar(); pintar(); toast('Reunión agendada'); } },
  });
  drawer.addEventListener('change', async e => {
    const el = e.target.closest('[data-act="toggle-tarea"]'); if (!el) return;
    try { await api.post(`/api/tareas/${el.dataset.id}/estado`, { estado: el.checked ? 'completada' : 'pendiente' }); cambiado = true; await cargar(); pintar(); }
    catch (ex) { toastError(ex); el.checked = !el.checked; }
  });

  if (await cargar()) pintar();
}
