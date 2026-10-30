import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, usuarios, opciones, $, $$, conCarga } from '../core.js';
import { camposUbigeo, enlazarUbigeo } from '../ui.js';

let st;
const SUGERENCIAS = ['restaurantes', 'veterinarias', 'ferreterías', 'farmacias', 'gimnasios', 'clínicas dentales', 'colegios', 'hoteles', 'bodegas', 'salones de belleza'];

export async function render(el) {
  st = { res: [], sel: new Set(), query: '', rubro: '' };
  const us = can('contactos.asignar') ? await usuarios() : [];
  dibujar(el, html`
    <div class="page-head"><div><h1>Prospección</h1><p>Encuentra negocios en Google Maps por rubro y ubicación, e impórtalos a tu CRM.</p></div></div>
    <form class="card mb" data-form><div class="card-body stack">
      <div class="form-grid" style="grid-template-columns:2fr 1fr 1fr 1fr">
        <label class="field"><span>¿Qué negocios buscas?</span><input class="input" name="busqueda" required maxlength="120" placeholder="ej. veterinarias" list="sug"></label>
        ${camposUbigeo({}, { vacio: 'Elegir' })}
      </div>
      <datalist id="sug">${SUGERENCIAS.map(s => html`<option value="${s}">`)}</datalist>
      <div class="row wrap"><span class="xs muted">Prueba:</span>${SUGERENCIAS.slice(0, 6).map(s => html`<button type="button" class="tag" data-act="sug" data-s="${s}" style="border:0;cursor:pointer">${s}</button>`)}
        <button class="btn btn-primary right" type="submit">${icon('search', 'sm')} Buscar en Google</button></div>
      <p class="xs muted">Cada búsqueda consume créditos de tu API key de Google Places (hasta 60 resultados con detalle).</p>
    </div></form>
    <div data-res></div>`);
  const form = $('[data-form]', el);
  // envolver los selects de ubigeo con etiqueta
  $$('select[data-ubi]', form).forEach((s, i) => {
    const l = document.createElement('label'); l.className = 'field';
    l.innerHTML = `<span>${['Departamento', 'Provincia', 'Distrito'][i]}</span>`; s.before(l); l.appendChild(s);
  });
  await enlazarUbigeo(form);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = { busqueda: form.busqueda.value, departamento: form.departamento.value, provincia: form.provincia.value, distrito: form.distrito.value };
    if (!d.departamento) { toast('Elige al menos el departamento.', 'warning'); return; }
    st.rubro = d.busqueda;
    dibujar($('[data-res]', el), html`<div class="card"><div class="loading"><span class="spinner"></span>Buscando "${d.busqueda}" en ${d.distrito || d.provincia || d.departamento}… puede tardar unos segundos.</div></div>`);
    await conCarga(form.querySelector('[type=submit]'), async () => {
      try {
        const r = await api.post('/api/contactos/buscar', d);
        st.res = r.resultados; st.query = r.query;
        st.sel = new Set(r.resultados.map((x, i) => (!x.existe && (x.telefono || x.telefono_int)) ? i : -1).filter(i => i >= 0));
        pintar(el, us);
      } catch (ex) { toastError(ex); dibujar($('[data-res]', el), ''); }
    });
  });

  acciones(el, {
    sug: b => { form.busqueda.value = b.dataset.s; form.busqueda.focus(); },
    'sel-todos': () => { st.res.forEach((x, i) => !x.existe && st.sel.add(i)); pintar(el, us); },
    'sel-telefono': () => { st.sel = new Set(st.res.map((x, i) => (!x.existe && (x.telefono || x.telefono_int)) ? i : -1).filter(i => i >= 0)); pintar(el, us); },
    'sel-ninguno': () => { st.sel.clear(); pintar(el, us); },
    importar: async b => {
      if (!st.sel.size) return toast('Selecciona al menos un negocio.', 'warning');
      const registros = [...st.sel].map(i => st.res[i]);
      await conCarga(b, async () => {
        try {
          const r = await api.post('/api/contactos/importar', { registros, rubro: st.rubro, etiquetas: $('[data-etq]', el)?.value, asignado_a: $('[data-asig]', el)?.value });
          toast(`${r.insertados} contacto(s) nuevos · ${r.actualizados} actualizados${r.errores ? ` · ${r.errores} con error` : ''}`);
          [...st.sel].forEach(i => { st.res[i].existe = true; }); st.sel.clear(); pintar(el, us);
        } catch (ex) { toastError(ex); }
      });
    },
  });
  el.addEventListener('change', e => {
    if (!e.target.matches('[data-i]')) return;
    const i = +e.target.dataset.i; e.target.checked ? st.sel.add(i) : st.sel.delete(i);
    $('[data-n]', el).textContent = st.sel.size;
  });
}

function pintar(el, us) {
  const nuevos = st.res.filter(x => !x.existe).length;
  dibujar($('[data-res]', el), st.res.length ? html`<div class="card">
    <div class="card-head"><div><h3>${fmt.num(st.res.length)} resultados</h3><div class="xs muted">${st.query} · ${fmt.num(nuevos)} nuevos</div></div>
      <div class="row wrap"><button class="btn btn-xs btn-ghost" data-act="sel-telefono">Con teléfono</button><button class="btn btn-xs btn-ghost" data-act="sel-todos">Todos los nuevos</button><button class="btn btn-xs btn-ghost" data-act="sel-ninguno">Ninguno</button></div></div>
    <div class="table-wrap" style="max-height:60vh"><table class="table"><thead><tr><th class="w-check"></th><th>Negocio</th><th>Teléfono</th><th>Web</th><th>Rating</th><th>Estado</th></tr></thead><tbody>
      ${st.res.map((x, i) => html`<tr style="${x.existe ? 'opacity:.55' : ''}">
        <td class="w-check"><input type="checkbox" data-i="${i}" ${st.sel.has(i) ? raw('checked') : ''} ${x.existe ? raw('disabled') : ''} aria-label="Seleccionar"></td>
        <td><div class="strong">${x.nombre}</div><div class="xs muted truncate" style="max-width:360px">${x.direccion}</div></td>
        <td class="nowrap small">${x.telefono_int || x.telefono || html`<span class="muted">—</span>`}</td>
        <td class="small">${x.website ? html`<a href="${x.website}" target="_blank" rel="noopener noreferrer">${icon('globe', 'sm')}</a>` : '—'}</td>
        <td class="small nowrap">${x.rating ? html`${icon('star', 'sm')} ${x.rating} <span class="muted">(${x.resenas})</span>` : '—'}</td>
        <td>${x.existe ? html`<span class="badge">Ya en CRM</span>` : x.estado === 'Activo' ? html`<span class="badge success">Activo</span>` : html`<span class="badge warning">${x.estado || '—'}</span>`}</td></tr>`)}
    </tbody></table></div>
    <div class="pager"><span><b data-n>${st.sel.size}</b> seleccionados</span>
      <div class="row wrap">
        <input class="input sm" data-etq placeholder="Etiquetas (opcional)" style="width:180px">
        ${us.length ? html`<select class="select sm" data-asig style="width:auto">${opciones(us, '', { vacio: 'Asignarme a mí' })}</select>` : ''}
        <button class="btn btn-primary" data-act="importar">${icon('download', 'sm')} Importar al CRM</button></div></div></div>`
    : html`<div class="card">${vacio({ icono: 'search', titulo: 'Sin resultados', texto: 'Prueba con otro rubro o una ubicación más amplia.' })}</div>`);
}
