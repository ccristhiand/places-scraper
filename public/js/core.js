// ── Plantillas seguras: todo valor interpolado se escapa salvo raw() ────────
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Safe(String(s ?? ''));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return new Safe(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function render(el, tpl) { el.innerHTML = String(tpl); return el; }

// ── Íconos (trazos estilo Lucide) ───────────────────────────────────────────
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  kanban: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkSquare: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8M16 13H8M16 17H8"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  tag: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-14.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  play: '<path d="m6 3 14 9-14 9V3z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  whatsapp: '<path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  dollar: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  note: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
};
export function icon(name, cls = '') {
  return raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.info}</svg>`);
}

// ── API ─────────────────────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(msg, status, codigo) { super(msg); this.status = status; this.codigo = codigo; }
}
async function request(method, url, body, { form = false } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'crm' }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (form) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new ApiError('No hay conexión con el servidor.', 0); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => ({})) : {};
  if (res.status === 401 && data.codigo === 'NO_AUTH') { location.href = '/login.html'; throw new ApiError(data.error, 401); }
  if (res.status === 403 && data.codigo === 'CAMBIO_PASSWORD') { location.href = '/login.html?cambio=1'; throw new ApiError(data.error, 403); }
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status, data.codigo);
  return data;
}
export const api = {
  get:   (u, q) => request('GET', q ? `${u}?${qs(q)}` : u),
  post:  (u, b = {}) => request('POST', u, b),
  put:   (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del:   (u, b) => request('DELETE', u, b),
  form:  (m, u, fd) => request(m, u, fd, { form: true }),
};
export function qs(obj) {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return p.toString();
}

// ── Sesión ─────────────────────────────────────────────────────────────────
export const session = { user: null, empresa: '', moneda: 'PEN', meta: false };
export const can = p => !!session.user?.permisos?.includes(p);

// ── Toasts ─────────────────────────────────────────────────────────────────
export function toast(msg, tipo = 'success', ms = 3800) {
  let wrap = $('.toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.setAttribute('role', 'status');
  render(t, html`${icon(tipo === 'error' ? 'alert' : tipo === 'warning' ? 'alert' : tipo === 'info' ? 'info' : 'check')}<div>${msg}</div>`);
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}
export const toastError = e => toast(e?.message || String(e), 'error', 6000);

// ── Modal ──────────────────────────────────────────────────────────────────
// modal({ title, subtitle, body, foot, size, onMount }) → { el, close, done }
export function modal({ title, subtitle, body, foot, size = '', onMount, onClose }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  render(ov, html`<div class="modal ${size}" role="dialog" aria-modal="true">
    <div class="modal-head"><div><h2>${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>
      <button class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? html`<div class="modal-foot">${foot}</div>` : ''}
  </div>`);
  document.body.appendChild(ov);
  let resolver;
  const done = new Promise(r => { resolver = r; });
  const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); onClose?.(v); resolver(v); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  const m = { el: ov.firstElementChild, close, done };
  onMount?.(m);
  setTimeout(() => $('input:not([type=hidden]):not([type=checkbox]),textarea,select', ov)?.focus(), 30);
  return m;
}

export function confirmar(mensaje, { titulo = '¿Confirmas?', ok = 'Confirmar', peligro = false } = {}) {
  const m = modal({
    title: titulo, size: 'sm',
    body: html`<p class="muted">${mensaje}</p>`,
    foot: html`<button class="btn" data-close>Cancelar</button><button class="btn ${peligro ? 'btn-danger solid' : 'btn-primary'}" data-ok>${ok}</button>`,
    onMount: m => m.el.querySelector('[data-ok]').addEventListener('click', () => m.close(true)),
  });
  return m.done.then(v => v === true);
}

// Formulario en modal: onSubmit(datos) puede lanzar error para mantenerlo abierto
export function formModal({ title, subtitle, fields, submit = 'Guardar', size = '', onSubmit, onMount }) {
  return modal({
    title, subtitle, size,
    body: html`<form class="form-grid" novalidate>${fields}<button type="submit" hidden></button></form>`,
    foot: html`<button class="btn" data-close type="button">Cancelar</button><button class="btn btn-primary" data-submit type="button">${submit}</button>`,
    onMount: m => {
      const form = m.el.querySelector('form');
      const btn = m.el.querySelector('[data-submit]');
      const go = async e => {
        e?.preventDefault();
        if (!form.reportValidity()) return;
        await conCarga(btn, async () => {
          try { const r = await onSubmit(formData(form), form, m); if (r !== false) m.close(r ?? true); }
          catch (err) { toastError(err); }
        });
      };
      form.addEventListener('submit', go);
      btn.addEventListener('click', go);
      onMount?.(m, form);
    },
  });
}

export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) { o[el.name] = o[el.name] || []; if (el.checked) o[el.name].push(el.value); }
      else o[el.name] = el.checked;
    } else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type === 'file') continue;
    else o[el.name] = el.value;
  }
  return o;
}

export async function conCarga(btn, fn) {
  if (!btn) return fn();
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>' + btn.textContent.trim();
  try { return await fn(); }
  finally { btn.disabled = false; btn.innerHTML = prev; }
}

// ── Menú contextual ────────────────────────────────────────────────────────
export function menu(anchor, items, { align = 'right', className = '' } = {}) {
  $('.menu')?.remove();
  const m = document.createElement('div');
  m.className = `menu ${className}`;
  render(m, html`${items.map((it, i) => it === '-' ? raw('<hr>') : it.html ? it.html : html`
    <button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon, 'sm') : ''}${it.label}</button>`)}`);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  Object.assign(m.style, { left: left + 'px', top: top + 'px' });
  m.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (b) { m.remove(); items[+b.dataset.i].onClick?.(); }
  });
  setTimeout(() => {
    const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
    document.addEventListener('mousedown', off);
  });
  return m;
}

// ── Delegación de eventos ──────────────────────────────────────────────────
// acciones(root, { nombre: (el, ev) => {} }) para elementos con data-act="nombre"
export function acciones(root, mapa, evento = 'click') {
  root.addEventListener(evento, e => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.dataset.act === 'noop') return;
    const fn = mapa[el.dataset.act];
    if (fn) { if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault(); fn(el, e); }
    else if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
  });
}

export function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Formato ────────────────────────────────────────────────────────────────
const TZ = 'America/Lima';
const d = v => (v instanceof Date ? v : new Date(v));
export const fmt = {
  fecha: v => v ? d(v).toLocaleDateString('es-PE', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }) : '—',
  fechaCorta: v => v ? d(v).toLocaleDateString('es-PE', { timeZone: TZ, day: '2-digit', month: 'short' }) : '—',
  fechaHora: v => v ? d(v).toLocaleString('es-PE', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—',
  hora: v => v ? d(v).toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '',
  dia: v => d(v).toLocaleDateString('es-PE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }),
  relativo(v) {
    if (!v) return '—';
    const s = (Date.now() - d(v).getTime()) / 1000;
    const fut = s < 0, a = Math.abs(s);
    const t = a < 60 ? 'un momento' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : a < 2592000 ? `${Math.round(a / 86400)} d` : null;
    if (!t) return fmt.fecha(v);
    if (t === 'un momento') return fut ? 'en un momento' : 'ahora';
    return fut ? `en ${t}` : `hace ${t}`;
  },
  num: v => Number(v || 0).toLocaleString('es-PE'),
  moneda: v => Number(v || 0).toLocaleString('es-PE', { style: 'currency', currency: session.moneda || 'PEN', maximumFractionDigits: 0 }),
  pct: (a, b) => b ? `${Math.round((a / b) * 100)}%` : '0%',
};
// Fecha local "YYYY-MM-DDTHH:mm" para inputs datetime-local
export function inputFecha(v) {
  if (!v) return '';
  const x = d(v);
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
export function iniciales(nombre) {
  return String(nombre || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('') || '?';
}
// Tonos apagados: el avatar identifica, no decora
const PALETA = ['#3b5b92', '#2f6f6a', '#6b5a8e', '#8a5a3c', '#4f6b3a', '#7a4a5c', '#3f6a8a', '#5c5c66'];
export function colorDe(s) {
  let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETA[h % PALETA.length];
}
export const avatar = (nombre, cls = '') => {
  const c = colorDe(nombre);
  return html`<span class="avatar ${cls}" style="background:color-mix(in srgb, ${raw(c)} 14%, var(--surface));color:${raw(c)}" aria-hidden="true">${iniciales(nombre)}</span>`;
};

// ── Catálogos compartidos ──────────────────────────────────────────────────
let _etapas = null, _usuarios = null;
export async function etapas(forzar = false) {
  if (!_etapas || forzar) _etapas = (await api.get('/api/crm/etapas')).rows;
  return _etapas;
}
export function etapaDe(clave) { return _etapas?.find(e => e.clave === clave); }
export function etapaBadge(clave) {
  const e = etapaDe(clave);
  if (!e) return html`<span class="badge">${clave || '—'}</span>`;
  return html`<span class="badge stage"><span class="dot" style="background:${raw(e.color)}"></span>${e.nombre}</span>`;
}
export async function usuarios(forzar = false) {
  if (!_usuarios || forzar) _usuarios = (await api.get('/api/usuarios/opciones')).rows;
  return _usuarios;
}
export const opciones = (lista, sel, { vacio } = {}) => html`${vacio !== undefined ? html`<option value="">${vacio}</option>` : ''}${lista.map(o => {
  const [v, t] = Array.isArray(o) ? o : [o.value ?? o.id ?? o.clave, o.label ?? o.nombre];
  return html`<option value="${v}" ${String(v) === String(sel ?? '') ? raw('selected') : ''}>${t}</option>`;
})}`;

export function vacio({ icono = 'inbox', titulo, texto, accion }) {
  return html`<div class="empty"><div class="empty-icon">${icon(icono, 'lg')}</div><h3>${titulo}</h3>${texto ? html`<p>${texto}</p>` : ''}${accion || ''}</div>`;
}
export const cargando = (t = 'Cargando…') => html`<div class="loading"><span class="spinner"></span>${t}</div>`;

// ── Eventos en tiempo real (socket.io) ─────────────────────────────────────
const handlers = new Map();
export const bus = {
  socket: null,
  on(evento, fn) { if (!handlers.has(evento)) handlers.set(evento, new Set()); handlers.get(evento).add(fn); return () => handlers.get(evento).delete(fn); },
  emit(evento, data) { handlers.get(evento)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
};
