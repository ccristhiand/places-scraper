import { html, $, render } from './core.js';

// Campo de contraseña con medidor de fortaleza y requisitos en vivo
export function campoPassword(nombre, etiqueta, email) {
  return html`<label class="field"><span>${etiqueta}</span>
    <input class="input" name="${nombre}" type="password" autocomplete="new-password" required minlength="8">
    <div class="strength"><div data-bar style="width:0"></div></div>
    <ul class="reqs" data-reqs></ul></label>`;
}

export function enlazarPassword(form, nombre, email) {
  const inp = form.elements[nombre];
  const bar = $('[data-bar]', inp.parentElement);
  const reqs = $('[data-reqs]', inp.parentElement);
  const usuario = String(email || '').split('@')[0].toLowerCase();
  const pintar = () => {
    const v = inp.value;
    const r = [
      [v.length >= 8, 'Al menos 8 caracteres'],
      [/[A-Za-z]/.test(v) && /\d/.test(v), 'Letras y números'],
      [!usuario || !v.toLowerCase().includes(usuario), 'No contiene tu usuario de correo'],
    ];
    let puntos = r.filter(x => x[0]).length + (v.length >= 12 ? 1 : 0) + (/[^A-Za-z0-9]/.test(v) ? 1 : 0);
    if (!v) puntos = 0;
    const colores = ['#dc2626', '#dc2626', '#f59e0b', '#eab308', '#22c55e', '#16a34a'];
    bar.style.width = `${(puntos / 5) * 100}%`;
    bar.style.background = colores[puntos];
    render(reqs, html`${r.map(([ok, t]) => html`<li class="${ok && v ? 'ok' : ''}">${ok && v ? '✓' : '•'} ${t}</li>`)}`);
  };
  inp.addEventListener('input', pintar);
  pintar();
}
