import { html, raw, icon, api, render as dibujar, toast, toastError, $, session, avatar, opciones, conCarga, formData } from '../core.js';
import { campoPassword, enlazarPassword } from '../password.js';

export async function render(el) {
  const u = session.user;
  dibujar(el, html`
    <div class="page-head"><div class="row">${avatar(u.nombre, 'lg')}<div><h1>${u.nombre}</h1><p>${u.email} · ${u.rol}</p></div></div></div>
    <div class="grid c2">
      <div class="card"><div class="card-head"><h3>${icon('user', 'sm')} Mis datos</h3></div><div class="card-body">
        <form class="form-grid" data-perfil>
          <label class="field span-2"><span>Nombre</span><input class="input" name="nombre" required maxlength="150" value="${u.nombre}"></label>
          <label class="field"><span>Teléfono</span><input class="input" name="telefono" maxlength="30" value="${u.telefono || ''}"></label>
          <label class="field"><span>Tema</span><select class="select" name="tema">${opciones([['auto', 'Automático (sistema)'], ['claro', 'Claro'], ['oscuro', 'Oscuro']], u.tema || 'auto')}</select></label>
          <div class="span-2 row"><button class="btn btn-primary right" type="submit">Guardar</button></div>
        </form></div></div>
      <div class="card"><div class="card-head"><h3>${icon('key', 'sm')} Cambiar contraseña</h3></div><div class="card-body">
        <form class="stack" data-pass>
          <label class="field"><span>Contraseña actual</span><input class="input" type="password" name="actual" required autocomplete="current-password"></label>
          ${campoPassword('nueva', 'Nueva contraseña', u.email)}
          <label class="field"><span>Repite la nueva contraseña</span><input class="input" type="password" name="repetir" required autocomplete="new-password"></label>
          <p class="xs muted">Al cambiarla se cerrarán tus sesiones en otros dispositivos.</p>
          <div class="row"><button class="btn btn-primary right" type="submit">Actualizar contraseña</button></div>
        </form></div></div>
    </div>
    <div class="card mt"><div class="card-head"><h3>${icon('shield', 'sm')} Mis permisos</h3></div><div class="card-body row wrap">
      ${u.permisos.map(p => html`<span class="tag">${p}</span>`)}</div></div>`);

  const fp = $('[data-perfil]', el);
  fp.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formData(fp);
    await conCarga(fp.querySelector('[type=submit]'), async () => {
      try {
        await api.put('/api/auth/perfil', d);
        Object.assign(session.user, d);
        document.documentElement.dataset.theme = d.tema === 'oscuro' ? 'dark' : d.tema === 'claro' ? 'light' : '';
        if (!document.documentElement.dataset.theme) delete document.documentElement.dataset.theme;
        toast('Perfil actualizado');
      } catch (ex) { toastError(ex); }
    });
  });
  const fw = $('[data-pass]', el);
  enlazarPassword(fw, 'nueva', u.email);
  fw.addEventListener('submit', async e => {
    e.preventDefault();
    if (fw.nueva.value !== fw.repetir.value) return toastError(new Error('Las contraseñas no coinciden.'));
    await conCarga(fw.querySelector('[type=submit]'), async () => {
      try { await api.post('/api/auth/cambiar-password', { actual: fw.actual.value, nueva: fw.nueva.value }); fw.reset(); toast('Contraseña actualizada'); }
      catch (ex) { toastError(ex); }
    });
  });
  return raw('');
}
