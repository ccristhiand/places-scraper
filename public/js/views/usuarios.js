import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, $, $$, cargando, modal, formModal, opciones, avatar, session, usuarios as usuariosCache } from '../core.js';

let st;

export async function render(el, params) {
  st = { tab: params[0] === 'roles' || !can('usuarios.gestionar') ? 'roles' : 'usuarios', usuarios: [], roles: [], catalogo: {} };
  dibujar(el, html`
    <div class="page-head"><div><h1>Usuarios y roles</h1><p>Controla quién accede al CRM y qué puede hacer cada uno.</p></div>
      <div class="actions" data-acciones></div></div>
    <div class="tabs">
      ${can('usuarios.gestionar') ? html`<button class="tab" data-act="tab" data-t="usuarios">${icon('users', 'sm')} Usuarios</button>` : ''}
      ${can('roles.gestionar') ? html`<button class="tab" data-act="tab" data-t="roles">${icon('shield', 'sm')} Roles y permisos</button>` : ''}
    </div>
    <div data-cont>${cargando()}</div>`);
  acciones(el, {
    tab: b => { st.tab = b.dataset.t; pintar(el); },
    'nuevo-usuario': () => editarUsuario(el),
    'editar-usuario': b => editarUsuario(el, st.usuarios.find(u => u.id === +b.dataset.id)),
    'menu-usuario': b => menuUsuario(el, b, st.usuarios.find(u => u.id === +b.dataset.id)),
    'nuevo-rol': () => editarRol(el),
    'editar-rol': b => editarRol(el, st.roles.find(r => r.id === +b.dataset.id)),
    'borrar-rol': async b => {
      const r = st.roles.find(x => x.id === +b.dataset.id);
      if (!(await confirmar(`¿Eliminar el rol "${r.nombre}"?`, { ok: 'Eliminar', peligro: true }))) return;
      try { await api.del(`/api/roles/${r.id}`); toast('Rol eliminado'); cargar(el); } catch (e) { toastError(e); }
    },
  });
  await cargar(el);
}

async function cargar(el) {
  try {
    const [u, r] = await Promise.all([
      can('usuarios.gestionar') ? api.get('/api/usuarios') : { rows: [] },
      api.get('/api/roles'),
    ]);
    st.usuarios = u.rows; st.roles = r.rows; st.catalogo = r.catalogo;
    usuariosCache(true).catch(() => {});
    pintar(el);
  } catch (e) { toastError(e); }
}

function pintar(el) {
  $$('.tab', el).forEach(t => t.classList.toggle('active', t.dataset.t === st.tab));
  dibujar($('[data-acciones]', el), st.tab === 'usuarios'
    ? html`<button class="btn btn-primary" data-act="nuevo-usuario">${icon('userPlus', 'sm')} Nuevo usuario</button>`
    : can('roles.gestionar') ? html`<button class="btn btn-primary" data-act="nuevo-rol">${icon('plus', 'sm')} Nuevo rol</button>` : '');
  const cont = $('[data-cont]', el);
  if (st.tab === 'usuarios') {
    dibujar(cont, html`<div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Usuario</th><th>Rol</th><th>Contactos</th><th>Último acceso</th><th>Estado</th><th></th></tr></thead><tbody>
      ${st.usuarios.map(u => html`<tr>
        <td><div class="row">${avatar(u.nombre)}<div><div class="strong">${u.nombre} ${u.id === session.user.id ? html`<span class="badge">Tú</span>` : ''}</div><div class="xs muted">${u.email}</div></div></div></td>
        <td><span class="badge primary">${u.rol}</span></td>
        <td>${fmt.num(u.contactos)}</td>
        <td class="small">${u.ultimo_acceso ? fmt.relativo(u.ultimo_acceso) : html`<span class="muted">Nunca</span>`}</td>
        <td>${!u.activo ? html`<span class="badge">Inactivo</span>` : u.bloqueado ? html`<span class="badge danger">Bloqueado</span>` : u.debe_cambiar_password ? html`<span class="badge warning">Contraseña temporal</span>` : html`<span class="badge success">Activo</span>`}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm" data-act="editar-usuario" data-id="${u.id}">${icon('edit', 'sm')} Editar</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="menu-usuario" data-id="${u.id}" aria-label="Más">${icon('more')}</button></td></tr>`)}
    </tbody></table></div></div>`);
  } else {
    const total = Object.values(st.catalogo).reduce((s, g) => s + Object.keys(g).length, 0);
    dibujar(cont, html`<div class="grid c2">${st.roles.map(r => {
      const todos = r.permisos.includes('*');
      return html`<div class="card"><div class="card-body">
        <div class="row between"><h3>${icon('shield', 'sm')} ${r.nombre}</h3>${r.es_sistema ? html`<span class="badge">${icon('lock', 'sm')} Sistema</span>` : ''}</div>
        <p class="small muted" style="margin:6px 0 12px">${r.descripcion || ''}</p>
        <div class="row small"><span>${fmt.num(r.usuarios)} usuario(s)</span><span class="muted">·</span><span>${todos ? 'Todos los permisos' : `${r.permisos.length} de ${total} permisos`}</span></div>
        <div class="progress" style="margin-top:8px"><div style="width:${raw(todos ? 100 : (r.permisos.length / total) * 100)}%"></div></div>
        ${can('roles.gestionar') && !r.es_sistema ? html`<div class="row mt"><button class="btn btn-sm" data-act="editar-rol" data-id="${r.id}">${icon('edit', 'sm')} Editar permisos</button>
          <button class="btn btn-sm btn-ghost btn-icon right" data-act="borrar-rol" data-id="${r.id}" aria-label="Eliminar">${icon('trash', 'sm')}</button></div>` : ''}
      </div></div>`;
    })}</div>`);
  }
}

function mostrarTemporal(nombre, pass) {
  modal({
    title: 'Contraseña temporal', size: 'sm',
    body: html`<p class="small muted mb">Comparte esta contraseña con <b>${nombre}</b> por un canal seguro. Solo se muestra esta vez; al ingresar deberá cambiarla.</p>
      <div class="copy-box"><code>${pass}</code><button class="btn btn-sm" data-copiar>${icon('copy', 'sm')} Copiar</button></div>`,
    foot: html`<button class="btn btn-primary" data-close>Listo</button>`,
    onMount: m => $('[data-copiar]', m.el).addEventListener('click', () => navigator.clipboard?.writeText(pass).then(() => toast('Copiada'))),
  });
}

function editarUsuario(el, u = null) {
  const propio = u?.id === session.user.id;
  formModal({
    title: u ? 'Editar usuario' : 'Nuevo usuario', submit: u ? 'Guardar' : 'Crear usuario',
    subtitle: u ? null : 'Se generará una contraseña temporal que deberá cambiar al primer ingreso.',
    fields: html`
      <label class="field span-2"><span>Nombre completo *</span><input class="input" name="nombre" required maxlength="150" value="${u?.nombre || ''}"></label>
      <label class="field"><span>Correo *</span><input class="input" type="email" name="email" required value="${u?.email || ''}"></label>
      <label class="field"><span>Teléfono</span><input class="input" name="telefono" value="${u?.telefono || ''}"></label>
      <label class="field span-2"><span>Rol</span><select class="select" name="rol_id" ${propio ? raw('disabled') : ''}>${opciones(st.roles.map(r => [r.id, `${r.nombre}${r.descripcion ? ' — ' + r.descripcion : ''}`]), u?.rol_id || st.roles.find(r => r.nombre === 'Vendedor')?.id)}</select></label>
      ${u && !propio ? html`<label class="switch span-2"><input type="checkbox" name="activo" ${u.activo ? raw('checked') : ''}><span class="track"></span> Usuario activo (puede iniciar sesión)</label>` : ''}`,
    onSubmit: async d => {
      if (u) { await api.put(`/api/usuarios/${u.id}`, d); toast('Usuario actualizado'); }
      else { const r = await api.post('/api/usuarios', d); toast('Usuario creado'); if (r.password_temporal) mostrarTemporal(d.nombre, r.password_temporal); }
      cargar(el);
    },
  });
}

function menuUsuario(el, b, u) {
  import('../core.js').then(({ menu }) => menu(b, [
    { label: 'Restablecer contraseña', icon: 'key', onClick: async () => {
      if (!(await confirmar(`Se generará una nueva contraseña temporal para ${u.nombre} y se cerrarán sus sesiones.`, { ok: 'Restablecer' }))) return;
      try { const r = await api.post(`/api/usuarios/${u.id}/reset-password`); mostrarTemporal(u.nombre, r.password_temporal); cargar(el); } catch (e) { toastError(e); }
    } },
    ...(u.bloqueado ? [{ label: 'Desbloquear', icon: 'lock', onClick: async () => { await api.post(`/api/usuarios/${u.id}/desbloquear`); toast('Usuario desbloqueado'); cargar(el); } }] : []),
    { label: 'Cerrar todas sus sesiones', icon: 'logout', onClick: async () => { await api.post(`/api/usuarios/${u.id}/cerrar-sesiones`); toast('Sesiones cerradas'); } },
    ...(u.id !== session.user.id ? ['-', { label: 'Eliminar usuario', icon: 'trash', danger: true, onClick: () => eliminarUsuario(el, u) }] : []),
  ]));
}

function eliminarUsuario(el, u) {
  formModal({
    title: `Eliminar a ${u.nombre}`, submit: 'Eliminar', size: 'sm',
    fields: html`<p class="span-2 small muted">Tiene ${fmt.num(u.contactos)} contacto(s) asignados. ¿A quién se los pasamos? (También sus tareas y reuniones.)</p>
      <label class="field span-2"><span>Reasignar a</span><select class="select" name="reasignar_a">${opciones(st.usuarios.filter(x => x.id !== u.id && x.activo), '', { vacio: 'Dejar sin asignar' })}</select></label>
      <div class="alert warning span-2 small">${icon('alert', 'sm')}<div>Si solo quieres quitarle el acceso, mejor desactívalo desde Editar.</div></div>`,
    onSubmit: async d => { await api.del(`/api/usuarios/${u.id}`, d); toast('Usuario eliminado'); cargar(el); },
  });
}

function editarRol(el, r = null) {
  const sel = new Set(r?.permisos || []);
  formModal({
    title: r ? `Rol: ${r.nombre}` : 'Nuevo rol', size: 'lg', submit: r ? 'Guardar rol' : 'Crear rol',
    fields: html`
      <label class="field"><span>Nombre *</span><input class="input" name="nombre" required maxlength="80" value="${r?.nombre || ''}"></label>
      <label class="field"><span>Descripción</span><input class="input" name="descripcion" maxlength="255" value="${r?.descripcion || ''}"></label>
      <div class="span-2">${Object.entries(st.catalogo).map(([grupo, perms]) => html`<div class="perm-group">
        <div class="perm-group-head"><span>${grupo}</span><label class="check small"><input type="checkbox" data-grupo="${grupo}"> Todos</label></div>
        <div class="perm-list">${Object.entries(perms).map(([p, desc]) => html`<label class="check small"><input type="checkbox" name="permisos" data-multi value="${p}" data-g="${grupo}" ${sel.has(p) ? raw('checked') : ''}> ${desc}</label>`)}</div></div>`)}</div>`,
    onMount: (m, form) => {
      const sync = () => $$('[data-grupo]', form).forEach(g => { const hs = $$(`[data-g="${CSS.escape(g.dataset.grupo)}"]`, form); g.checked = hs.every(h => h.checked); g.indeterminate = !g.checked && hs.some(h => h.checked); });
      form.addEventListener('change', e => {
        if (e.target.dataset.grupo) $$(`[data-g="${CSS.escape(e.target.dataset.grupo)}"]`, form).forEach(h => { h.checked = e.target.checked; });
        sync();
      });
      sync();
    },
    onSubmit: async d => {
      if (r) await api.put(`/api/roles/${r.id}`, d); else await api.post('/api/roles', d);
      toast(r ? 'Rol actualizado' : 'Rol creado'); cargar(el);
    },
  });
}
