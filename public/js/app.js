import { html, render, icon, api, session, can, $, acciones, toast, toastError, bus, cargando, vacio, avatar, menu, etapas, etapaBadge, debounce, fmt, iniciales } from './core.js';

// Rutas: cada vista es un módulo en /js/views/<archivo>.js que exporta render(el, params)
const RUTAS = [
  { grupo: 'Principal' },
  { id: 'panel',      titulo: 'Panel',        icono: 'dashboard',   perm: 'dashboard.ver' },
  { id: 'bandeja',    titulo: 'Bandeja',      icono: 'chat',        perm: 'chat.ver', full: true },
  { id: 'contactos',  titulo: 'Contactos',    icono: 'users',       perm: 'contactos.ver' },
  { id: 'pipeline',   titulo: 'Pipeline',     icono: 'kanban',      perm: 'pipeline.ver' },
  { id: 'agenda',     titulo: 'Agenda',       icono: 'calendar',    perm: 'agenda.ver' },
  { id: 'tareas',     titulo: 'Tareas',       icono: 'checkSquare', perm: 'tareas.ver' },
  { id: 'proyectos',  titulo: 'Proyectos',    icono: 'layers',      perm: 'proyectos.ver' },
  { grupo: 'Captación' },
  { id: 'prospeccion',titulo: 'Prospección',  icono: 'search',      perm: 'prospeccion.buscar' },
  { id: 'leads',      titulo: 'Leads web',    icono: 'inbox',       perm: 'leads.ver' },
  { grupo: 'Marketing' },
  { id: 'whatsapp',   titulo: 'WhatsApp',     icono: 'whatsapp',    perm: ['config.ver', 'campanas.ver'] },
  { id: 'campanas',   titulo: 'Campañas',     icono: 'megaphone',   perm: 'campanas.ver' },
  { id: 'envios',     titulo: 'Envíos',       icono: 'send',        perm: 'envios.ver' },
  { grupo: 'Análisis' },
  { id: 'reportes',   titulo: 'Reportes',     icono: 'chart',       perm: 'reportes.ver' },
  { grupo: 'Administración' },
  { id: 'usuarios',   titulo: 'Usuarios y roles', icono: 'shield',  perm: ['usuarios.gestionar', 'roles.gestionar'] },
  { id: 'config',     titulo: 'Configuración',icono: 'settings',    perm: 'config.ver' },
  { id: 'auditoria',  titulo: 'Auditoría',    icono: 'file',        perm: 'auditoria.ver' },
  { id: 'perfil',     titulo: 'Mi perfil',    icono: 'user',        oculto: true },
];
const permitida = r => !r.perm || [].concat(r.perm).some(can);

function pintarSidebar(actual) {
  const items = [];
  let grupo = null;
  for (const r of RUTAS) {
    if (r.grupo) { grupo = r.grupo; continue; }
    if (r.oculto || !permitida(r)) continue;
    if (grupo) { items.push(html`<div class="nav-group">${grupo}</div>`); grupo = null; }
    items.push(html`<a class="nav-link ${r.id === actual ? 'active' : ''}" href="#/${r.id}">${icon(r.icono)}<span>${r.titulo}</span>${r.id === 'bandeja' ? html`<span class="nav-badge hidden" id="badge-chat"></span>` : ''}</a>`);
  }
  render($('#sidebar'), html`
    <div class="brand"><div class="brand-logo">${iniciales(session.empresa || 'CRM')}</div><div class="grow"><div class="brand-name truncate">${session.empresa || 'CRM'}</div><div class="brand-sub">Ventas</div></div></div>
    <nav class="nav">${items}</nav>
    <div class="sidebar-foot"><a class="wa-pill" href="#/whatsapp/conexion">
      <span class="dot ${session.meta ? 'ok' : 'warn'}"></span>
      <span>${session.meta ? 'WhatsApp conectado' : 'WhatsApp sin conectar'}</span></a></div>`);
}

function pintarTopbar() {
  const u = session.user;
  render($('#topbar'), html`
    <button class="icon-btn menu-btn" data-act="menu" aria-label="Menú">${icon('menu')}</button>
    ${can('contactos.ver') ? html`<div class="search-global">${icon('search', 'sm')}
      <input class="input" id="buscar-global" placeholder="Buscar contactos" autocomplete="off" aria-label="Buscar contactos">
      <div class="search-results hidden" id="buscar-res"></div></div>` : ''}
    <div class="top-actions">
      <button class="icon-btn" data-act="notificaciones" aria-label="Notificaciones">${icon('bell')}<span class="count hidden" id="notif-count"></span></button>
      <button class="user-btn" data-act="usuario">${avatar(u.nombre, 'sm')}<span class="user-name">${u.nombre}</span>${icon('chevronDown', 'sm')}</button>
    </div>`);
  enlazarBusqueda();
}

// ── Búsqueda global ─────────────────────────────────────────────────────────
function enlazarBusqueda() {
  const inp = $('#buscar-global'), res = $('#buscar-res');
  if (!inp) return;
  let sel = -1;
  const buscar = debounce(async () => {
    const q = inp.value.trim();
    if (q.length < 2) { res.classList.add('hidden'); return; }
    try {
      const r = await api.get('/api/buscar', { q });
      sel = -1;
      render(res, r.contactos.length ? html`${r.contactos.map(c => html`<a href="#/contactos/${c.id}" data-ir>${avatar(c.nombre, 'sm')}
        <div class="grow"><div class="strong truncate">${c.nombre}</div><div class="xs muted">${[c.distrito, c.whatsapp || c.telefono].filter(Boolean).join(' · ')}</div></div>${etapaBadge(c.estado_crm)}</a>`)}`
        : html`<div class="list-item muted small">Sin resultados para "${q}"</div>`);
      res.classList.remove('hidden');
    } catch (e) { toastError(e); }
  }, 250);
  inp.addEventListener('input', buscar);
  inp.addEventListener('keydown', e => {
    const items = [...res.querySelectorAll('[data-ir]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      items.forEach((x, i) => x.classList.toggle('sel', i === sel));
    } else if (e.key === 'Enter' && items[Math.max(0, sel)]) { items[Math.max(0, sel)].click(); }
    else if (e.key === 'Escape') { inp.blur(); }
  });
  res.addEventListener('click', e => { if (e.target.closest('[data-ir]')) { res.classList.add('hidden'); inp.value = ''; } });
  inp.addEventListener('blur', () => setTimeout(() => res.classList.add('hidden'), 150));
  addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inp.focus(); } });
}

// ── Notificaciones y contadores ─────────────────────────────────────────────
async function contarNotificaciones() {
  try {
    const r = await api.get('/api/notificaciones');
    const c = $('#notif-count');
    c.textContent = r.sin_leer > 99 ? '99+' : r.sin_leer;
    c.classList.toggle('hidden', !r.sin_leer);
    return r;
  } catch { return null; }
}
async function contarChat() {
  if (!can('chat.ver')) return;
  try {
    const r = await api.get('/api/chat/no-leidos');
    const b = $('#badge-chat');
    if (b) { b.textContent = r.total > 99 ? '99+' : r.total; b.classList.toggle('hidden', !r.total); }
  } catch { /* sin conexión */ }
}
const ICONO_NOTIF = { mensaje: 'chat', tarea: 'checkSquare', reunion: 'calendar', lead: 'inbox', alerta: 'alert' };
async function abrirNotificaciones(btn) {
  const r = await contarNotificaciones();
  if (!r) return;
  const m = menu(btn, [{ html: html`<div class="row between" style="padding:12px 14px;border-bottom:1px solid var(--border)"><b>Notificaciones</b>
      ${r.sin_leer ? html`<button class="btn btn-xs btn-ghost" data-leer-todas>Marcar todo como leído</button>` : ''}</div>
    ${r.rows.length ? r.rows.map(n => html`<div class="notif ${n.leida ? '' : 'unread'}" data-notif="${n.id}" data-enlace="${n.enlace || ''}">
      <div class="kpi-icon tone-primary" style="width:32px;height:32px">${icon(ICONO_NOTIF[n.tipo] || 'bell', 'sm')}</div>
      <div class="grow"><div class="small strong">${n.titulo}</div>${n.cuerpo ? html`<div class="xs muted">${n.cuerpo}</div>` : ''}<div class="xs muted">${fmt.relativo(n.created_at)}</div></div></div>`)
      : html`<div class="empty small">No tienes notificaciones.</div>`}` }], { className: 'notif-panel' });
  m.addEventListener('click', async e => {
    if (e.target.closest('[data-leer-todas]')) { await api.post('/api/notificaciones/leer'); m.remove(); contarNotificaciones(); return; }
    const n = e.target.closest('[data-notif]');
    if (n) { await api.post('/api/notificaciones/leer', { id: n.dataset.notif }); m.remove(); contarNotificaciones(); if (n.dataset.enlace) location.hash = n.dataset.enlace; }
  });
}

acciones($('#topbar'), {
  notificaciones: b => abrirNotificaciones(b),
  menu: () => $('#sidebar').classList.toggle('open'),
  usuario: el => menu(el, [
    { html: html`<div class="menu-head"><div class="strong">${session.user.nombre}</div><div class="xs muted">${session.user.email} · ${session.user.rol}</div></div>` },
    '-',
    { label: 'Mi perfil y contraseña', icon: 'user', onClick: () => { location.hash = '#/perfil'; } },
    '-',
    { label: 'Cerrar sesión', icon: 'logout', danger: true, onClick: async () => {
      await api.post('/api/auth/logout').catch(() => {});
      location.href = '/login.html?salio=1';
    } },
  ]),
});
$('#backdrop').addEventListener('click', () => $('#sidebar').classList.remove('open'));

let vistaActual = null;
async function navegar() {
  const [id = 'panel', ...params] = location.hash.replace(/^#\/?/, '').split('/');
  let ruta = RUTAS.find(r => r.id === id && !r.grupo);
  if (!ruta || !permitida(ruta)) ruta = RUTAS.find(r => r.id && permitida(r));
  pintarSidebar(ruta.id);
  contarChat();
  $('#sidebar').classList.remove('open');
  document.title = `${ruta.titulo} · ${session.empresa || 'CRM'}`;
  vistaActual?.destroy?.();
  // Elemento nuevo en cada navegación: así no se acumulan listeners de vistas anteriores
  const viejo = $('#view');
  const el = viejo.cloneNode(false);
  viejo.replaceWith(el);
  el.className = `view ${ruta.full ? 'full' : ''}`;
  render(el, cargando());
  try {
    const mod = await import(`./views/${ruta.id}.js`);
    vistaActual = mod;
    await mod.render(el, params);
  } catch (e) {
    vistaActual = null;
    if (e instanceof TypeError && /import|module|fetch/i.test(e.message)) {
      render(el, vacio({ icono: 'layers', titulo: `${ruta.titulo}: módulo en construcción`, texto: 'La API de este módulo ya está lista; falta su pantalla.' }));
    } else { console.error(e); toastError(e); }
  }
}

(async () => {
  try {
    const me = await api.get('/api/auth/me');
    Object.assign(session, { user: me.usuario, empresa: me.empresa, moneda: me.moneda, meta: me.meta });
    const tema = me.usuario.tema;
    if (tema === 'oscuro') document.documentElement.dataset.theme = 'dark';
    else if (tema === 'claro') document.documentElement.dataset.theme = 'light';
    await etapas().catch(() => {});
    pintarTopbar();
    if (window.io) {
      const s = window.io({ transports: ['websocket', 'polling'] });
      bus.socket = s;
      s.onAny((ev, data) => bus.emit(ev, data));
    }
    bus.on('notificacion', n => { contarNotificaciones(); toast(n.titulo, 'info'); });
    bus.on('chat:mensaje', m => { if (m.direccion === 'entrante') contarChat(); });
    bus.on('lead:nuevo', () => contarNotificaciones());
    addEventListener('hashchange', navegar);
    await navegar();
    contarNotificaciones();
    contarChat();
    setInterval(contarChat, 60000);
  } catch (e) { if (e.status !== 401) toastError(e); }
})();
