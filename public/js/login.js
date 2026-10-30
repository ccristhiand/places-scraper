import { html, render, icon, api, toastError, $, conCarga, iniciales } from './core.js';
import { campoPassword, enlazarPassword } from './password.js';

const card = $('#card');

fetch('/api/auth/marca').then(r => r.json()).then(({ empresa }) => {
  const nombre = empresa || 'CRM';
  $('#empresa').textContent = nombre;
  $('#logo').textContent = iniciales(nombre);
  document.title = `Iniciar sesión · ${nombre}`;
}).catch(() => {});

function vistaLogin(msg) {
  render(card, html`
    <h1>Iniciar sesión</h1>
    <p class="muted small" style="margin-bottom:20px">Usa el correo con el que te registró tu administrador.</p>
    ${msg ? html`<div class="alert info mb">${icon('info')}<div>${msg}</div></div>` : ''}
    <form class="stack" id="f" novalidate>
      <label class="field"><span>Correo electrónico</span>
        <input class="input" name="email" type="email" autocomplete="username" required autofocus placeholder="tu@empresa.com"></label>
      <label class="field"><span>Contraseña</span>
        <div class="pass-wrap"><input class="input" name="password" type="password" autocomplete="current-password" required placeholder="••••••••">
        <button type="button" class="btn btn-ghost btn-sm btn-icon" data-ver aria-label="Mostrar contraseña">${icon('eye', 'sm')}</button></div></label>
      <div id="err" class="alert danger hidden"></div>
      <button class="btn btn-primary btn-block" style="height:36px;margin-top:4px" type="submit">Continuar</button>
    </form>`);
  const f = $('#f');
  $('[data-ver]', f).addEventListener('click', e => {
    const inp = f.password; inp.type = inp.type === 'password' ? 'text' : 'password';
    e.currentTarget.innerHTML = String(icon(inp.type === 'password' ? 'eye' : 'eyeOff', 'sm'));
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#err');
    err.classList.add('hidden');
    await conCarga($('button[type=submit]', f), async () => {
      try {
        const r = await api.post('/api/auth/login', { email: f.email.value, password: f.password.value });
        if (r.usuario.debe_cambiar_password) vistaCambio(r.usuario, f.password.value);
        else location.href = '/';
      } catch (ex) {
        render(err, html`${icon('alert')}<div>${ex.message}</div>`);
        err.classList.remove('hidden');
        f.password.select();
      }
    });
  });
}

function vistaCambio(usuario, actualConocida = '') {
  render(card, html`
    <h1>Crea tu nueva contraseña</h1>
    <p class="muted" style="margin-bottom:22px">Hola ${usuario?.nombre || ''}. Por seguridad, debes reemplazar la contraseña temporal antes de entrar.</p>
    <form class="stack" id="f" novalidate>
      ${actualConocida ? '' : html`<label class="field"><span>Contraseña actual</span>
        <input class="input" name="actual" type="password" autocomplete="current-password" required></label>`}
      ${campoPassword('nueva', 'Nueva contraseña', usuario?.email)}
      <label class="field"><span>Repite la nueva contraseña</span>
        <input class="input" name="repetir" type="password" autocomplete="new-password" required></label>
      <div id="err" class="alert danger hidden"></div>
      <button class="btn btn-primary btn-block" style="height:36px" type="submit">Guardar y entrar</button>
      <button class="btn btn-ghost btn-block" type="button" data-salir>Cerrar sesión</button>
    </form>`);
  const f = $('#f');
  enlazarPassword(f, 'nueva', usuario?.email);
  $('[data-salir]', f).addEventListener('click', async () => { await api.post('/api/auth/logout').catch(() => {}); vistaLogin(); });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#err');
    const mostrar = m => { render(err, html`${icon('alert')}<div>${m}</div>`); err.classList.remove('hidden'); };
    err.classList.add('hidden');
    if (f.nueva.value !== f.repetir.value) return mostrar('Las contraseñas no coinciden.');
    await conCarga($('button[type=submit]', f), async () => {
      try {
        await api.post('/api/auth/cambiar-password', { actual: actualConocida || f.actual.value, nueva: f.nueva.value });
        location.href = '/';
      } catch (ex) { mostrar(ex.message); }
    });
  });
}

// Si ya hay sesión, decidir a dónde ir
(async () => {
  const params = new URLSearchParams(location.search);
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.ok) {
      const { usuario } = await r.json();
      if (!usuario.debe_cambiar_password) { location.href = '/'; return; }
      return vistaCambio(usuario);
    }
    if (r.status === 403 && params.get('cambio')) return vistaCambio(null);
  } catch (e) { toastError(e); }
  vistaLogin(params.get('salio') ? 'Cerraste sesión correctamente.' : null);
})();
