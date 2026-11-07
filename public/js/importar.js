// Carga masiva de contactos desde Excel: guía → subir (arrastrar) → revisar → importar
import { html, raw, icon, api, render as dibujar, $, $$, modal, toast, toastError, conCarga, can, session, etapas, usuarios, opciones, fmt } from './core.js';

const MAX_MB = 5;
const ESTADOS = {
  nuevo: ['success', 'Nuevo'], duplicado: ['warning', 'Ya existe'], repetido: ['', 'Repetido en archivo'], error: ['danger', 'Con error'],
};

export async function importarContactos({ onFin } = {}) {
  const [ets, us] = await Promise.all([etapas(), can('contactos.asignar') ? usuarios() : []]);
  let st = { analisis: null, filtro: 'todos' };

  const m = modal({
    title: 'Importar contactos desde Excel', subtitle: 'Agrega muchos contactos a la vez. Nada se guarda hasta que confirmes.', size: 'xl',
    body: html`<div data-paso></div>`,
    foot: html`<div class="row grow" data-foot style="justify-content:flex-end"></div>`,
    onClose: v => { if (v) onFin?.(v); },
  });
  const paso = $('[data-paso]', m.el), foot = $('[data-foot]', m.el);

  // ── Paso 1: guía + plantilla + zona para soltar el archivo ───────────────
  function pasoSubir() {
    dibujar(paso, html`
      <div class="import-steps">
        <div class="import-step"><span class="import-num">1</span><div><b>Descarga la plantilla</b><p>Trae las columnas correctas, listas desplegables y una hoja de ejemplo.</p></div></div>
        <div class="import-step"><span class="import-num">2</span><div><b>Llena una fila por contacto</b><p>Solo el nombre es obligatorio. Puedes pegar datos desde otro Excel.</p></div></div>
        <div class="import-step"><span class="import-num">3</span><div><b>Súbela y revisa</b><p>Verás errores, avisos y duplicados fila por fila antes de importar.</p></div></div>
      </div>
      <div class="row mb"><a class="btn" href="/api/contactos/importar/plantilla" download>${icon('download', 'sm')} Descargar plantilla</a>
        <span class="xs muted">plantilla-contactos.xlsx</span></div>

      <label class="dropzone" data-drop tabindex="0">
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden data-file>
        <span class="dropzone-icon">${icon('upload')}</span>
        <b>Arrastra tu archivo de Excel aquí</b>
        <span class="muted small">o <u>haz clic para elegirlo</u></span>
        <span class="xs muted">Formato .xlsx · hasta 5.000 filas · máximo ${MAX_MB} MB</span>
      </label>

      <details class="import-guia">
        <summary>${icon('info', 'sm')} Cómo preparar el archivo y qué se valida</summary>
        <div class="grid c2" style="gap:18px;margin-top:12px">
          <div>
            <div class="label">Columnas de la plantilla</div>
            <table class="table compact"><tbody>
              <tr><td class="strong">Nombre del negocio *</td><td>Obligatorio.</td></tr>
              <tr><td class="strong">Persona de contacto</td><td>Se usa en los mensajes como [contacto].</td></tr>
              <tr><td class="strong">WhatsApp</td><td>987654321, 51987654321 o +51 987 654 321.</td></tr>
              <tr><td class="strong">Teléfono</td><td>Fijo u otro número. Si es celular y no hay WhatsApp, se usa como WhatsApp.</td></tr>
              <tr><td class="strong">Correo · Sitio web · Dirección</td><td>Opcionales.</td></tr>
              <tr><td class="strong">Departamento · Provincia · Distrito</td><td>Se corrigen al nombre oficial (sin importar tildes).</td></tr>
              <tr><td class="strong">Rubro · Notas</td><td>Texto libre.</td></tr>
              <tr><td class="strong">Etapa</td><td>Nombre de la etapa del pipeline (lista en la plantilla).</td></tr>
              <tr><td class="strong">Valor estimado</td><td>Solo números: 1500 o 1500.50</td></tr>
              <tr><td class="strong">Etiquetas</td><td>Separadas por coma: vip, feria-2026</td></tr>
              <tr><td class="strong">Responsable</td><td>Correo del vendedor en el CRM.</td></tr>
            </tbody></table>
          </div>
          <div class="stack sm">
            <div class="label">Validaciones al subir</div>
            <ul class="import-reglas">
              <li><span class="badge danger">Error</span> Sin nombre, WhatsApp mal escrito (letras, dígitos de menos o de más, celular que no empieza con 9), correo inválido o valor que no es número. <b>Esa fila no se importa.</b></li>
              <li><span class="badge warning">Ya existe</span> Hay un contacto en el CRM con el mismo WhatsApp, el mismo correo o el mismo nombre en el mismo distrito. Puedes omitirlo o completar sus datos vacíos.</li>
              <li><span class="badge">Repetido</span> La misma persona aparece dos veces en el archivo: solo se toma la primera.</li>
              <li><span class="badge info">Aviso</span> Se importa, pero revisa: distrito no reconocido, sin datos de contacto, web inválida, responsable desconocido…</li>
            </ul>
            <div class="label" style="margin-top:8px">Consejos</div>
            <ul class="import-reglas">
              <li>No cambies los títulos de la primera fila. Si usas tu propio Excel, nombra las columnas igual que en la plantilla.</li>
              <li>Si el archivo es .xls o .csv, ábrelo en Excel y usa <i>Guardar como → Libro de Excel (.xlsx)</i>.</li>
              <li>Para no perder ceros ni dígitos, deja las columnas de números con formato <i>Texto</i> (la plantilla ya lo trae).</li>
              <li>Después de revisar puedes descargar las filas que no se importaron con el motivo, corregirlas y volver a subirlas.</li>
            </ul>
          </div>
        </div>
      </details>`);
    dibujar(foot, html`<button class="btn" data-close>Cancelar</button>`);

    const drop = $('[data-drop]', paso), input = $('[data-file]', paso);
    input.addEventListener('change', () => input.files[0] && subir(input.files[0]));
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'dragend'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length > 1) toast('Suelta un solo archivo a la vez.', 'warning');
      if (files[0]) subir(files[0]);
    });
  }

  async function subir(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      return toast(/\.(xls|csv|ods)$/i.test(file.name) ? 'Ese formato no se acepta: guárdalo como "Libro de Excel (.xlsx)".' : 'El archivo debe ser de Excel (.xlsx).', 'warning', 6000);
    }
    if (file.size > MAX_MB * 1024 * 1024) return toast(`El archivo pesa ${(file.size / 1048576).toFixed(1)} MB; el máximo es ${MAX_MB} MB.`, 'warning', 6000);
    dibujar(paso, html`<div class="dropzone busy"><span class="spinner"></span><b>Revisando ${file.name}…</b><span class="xs muted">Validando filas y buscando duplicados</span></div>`);
    dibujar(foot, '');
    const fd = new FormData();
    fd.append('archivo', file);
    try {
      st.analisis = await api.form('POST', '/api/contactos/importar/analizar', fd);
      st.analisis.archivo = file.name;
      st.filtro = 'todos';
      pasoRevisar();
    } catch (e) { toastError(e); pasoSubir(); }
  }

  // ── Paso 2: revisión fila por fila y opciones ────────────────────────────
  function pasoRevisar() {
    const { resumen: r, filas } = st.analisis;
    const hoy = new Date().toISOString().slice(0, 10);
    const kpi = (t, n, tone, f) => html`<button type="button" class="import-kpi ${tone} ${st.filtro === f ? 'active' : ''}" data-filtro="${f}"><span>${t}</span><b>${fmt.num(n)}</b></button>`;
    dibujar(paso, html`
      <div class="row between wrap mb"><div class="small"><span class="muted">Archivo:</span> <b>${st.analisis.archivo}</b></div>
        <button type="button" class="btn btn-sm btn-ghost" data-otro>${icon('upload', 'sm')} Elegir otro archivo</button></div>
      <div class="import-kpis">
        ${kpi('Filas leídas', r.total, '', 'todos')}
        ${kpi('Nuevos', r.nuevos, 'success', 'nuevo')}
        ${kpi('Ya existen', r.duplicados, 'warning', 'duplicado')}
        ${kpi('Repetidos', r.repetidos, '', 'repetido')}
        ${kpi('Con error', r.errores, 'danger', 'error')}
        ${kpi('Con avisos', r.con_avisos, 'info', 'avisos')}
      </div>
      ${r.desconocidas?.length ? html`<div class="alert info small mt">${icon('info', 'sm')}<div>Estas columnas no son de la plantilla y se ignoran: <b>${r.desconocidas.join(', ')}</b>.</div></div>` : ''}

      <div class="card mt"><div class="card-body form-grid">
        <label class="field"><span>Contactos que ya existen</span><select class="select" name="duplicados" ${r.duplicados ? '' : raw('disabled')}>
          <option value="omitir">No tocarlos (omitir)</option>
          ${can('contactos.editar') ? html`<option value="actualizar">Completar solo sus datos vacíos</option>` : ''}</select></label>
        <label class="field"><span>Etapa si la fila no dice</span><select class="select" name="etapa">${opciones(ets.map(e => [e.clave, e.nombre]), ets[0]?.clave)}</select></label>
        ${us.length ? html`<label class="field"><span>Responsable si la fila no dice</span><select class="select" name="asignado_a">${opciones([['', 'Sin asignar'], ...us.map(u => [u.id, u.nombre])], session.user?.id ?? '')}</select></label>` : ''}
        <label class="field"><span>Etiqueta para este lote</span><input class="input" name="etiqueta" maxlength="40" value="importado-${hoy}"><span class="hint">Te sirve para filtrarlos o lanzarles una campaña.</span></label>
      </div></div>

      <div class="card mt"><div class="table-wrap" style="max-height:380px" data-tabla></div></div>`);

    pintarTabla();
    const pendientes = r.total - r.nuevos;
    const actualizar = () => $('[name=duplicados]', paso).value === 'actualizar';
    const botonImportar = () => { const n = r.nuevos + (actualizar() ? r.duplicados : 0); const b = $('[data-importar]', foot); b.disabled = !n; b.textContent = n ? `Importar ${fmt.num(n)} contacto${n === 1 ? '' : 's'}` : 'Nada para importar'; };
    dibujar(foot, html`
      ${pendientes ? html`<a class="btn btn-ghost" href="/api/contactos/importar/${st.analisis.token}/pendientes.xlsx" download style="margin-right:auto">${icon('download', 'sm')} Descargar ${fmt.num(pendientes)} no importados</a>` : ''}
      <button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-importar></button>`);
    botonImportar();

    $('[name=duplicados]', paso).addEventListener('change', botonImportar);
    $('[data-otro]', paso).addEventListener('click', pasoSubir);
    $$('[data-filtro]', paso).forEach(b => b.addEventListener('click', () => {
      st.filtro = b.dataset.filtro;
      $$('[data-filtro]', paso).forEach(x => x.classList.toggle('active', x === b));
      pintarTabla();
    }));
    $('[data-importar]', foot).addEventListener('click', e => importar(e.currentTarget));
  }

  function pintarTabla() {
    const filas = st.analisis.filas.filter(f => st.filtro === 'todos' ? true : st.filtro === 'avisos' ? f.avisos.length && f.estado !== 'error' : f.estado === st.filtro);
    const LIM = 300;
    const ub = d => [d.distrito, d.provincia, d.departamento].filter(Boolean).join(', ');
    dibujar($('[data-tabla]', paso), filas.length ? html`<table class="table compact"><thead><tr>
        <th style="width:52px">Fila</th><th>Nombre</th><th>WhatsApp / correo</th><th>Ubicación</th><th>Estado</th><th>Detalle</th></tr></thead><tbody>
      ${filas.slice(0, LIM).map(f => { const [tone, txt] = ESTADOS[f.estado]; const d = f.datos;
        return html`<tr>
          <td class="xs muted num">${f.fila}</td>
          <td class="small strong">${d.nombre || html`<span class="muted">—</span>`}${d.contacto_nombre ? html`<div class="xs muted">${d.contacto_nombre}</div>` : ''}</td>
          <td class="xs">${d.whatsapp || ''}${d.email ? html`<div class="muted">${d.email}</div>` : ''}</td>
          <td class="xs muted">${ub(d)}</td>
          <td><span class="badge ${tone}">${txt}</span></td>
          <td class="xs" style="max-width:320px">
            ${f.errores.map(x => html`<div style="color:var(--danger)">${x}</div>`)}
            ${f.motivo ? html`<div style="color:var(--warning)">${f.motivo}</div>` : ''}
            ${f.avisos.map(x => html`<div class="muted">${x}</div>`)}</td></tr>`; })}
      </tbody></table>${filas.length > LIM ? html`<p class="xs muted center" style="padding:10px">Se muestran ${LIM} de ${fmt.num(filas.length)} filas. Descarga los no importados para ver el detalle completo.</p>` : ''}`
      : html`<p class="muted small center" style="padding:24px">No hay filas en este grupo.</p>`);
  }

  async function importar(btn) {
    const v = n => $(`[name=${n}]`, paso)?.value;
    await conCarga(btn, async () => {
      try {
        const r = await api.post('/api/contactos/importar/confirmar', {
          token: st.analisis.token, duplicados: v('duplicados'), etapa: v('etapa'), etiqueta: v('etiqueta'),
          ...($('[name=asignado_a]', paso) ? { asignado_a: v('asignado_a') } : {}),
        });
        pasoFin(r, v('etiqueta'));
      } catch (e) { toastError(e); if (e.status === 410) pasoSubir(); }
    });
  }

  // ── Paso 3: resultado ────────────────────────────────────────────────────
  function pasoFin(r, etiqueta) {
    dibujar(paso, html`<div class="center stack" style="padding:20px 0">
      <div class="import-ok">${icon('check')}</div>
      <h3 style="margin:0">Importación terminada${r.segundos != null ? html` <span class="muted small" style="font-weight:400">en ${r.segundos} s</span>` : ''}</h3>
      <div class="import-kpis" style="max-width:520px;margin:8px auto 0">
        <div class="import-kpi success"><span>Creados</span><b>${fmt.num(r.creados)}</b></div>
        <div class="import-kpi warning"><span>Completados</span><b>${fmt.num(r.actualizados)}</b></div>
        <div class="import-kpi"><span>No importados</span><b>${fmt.num(r.omitidos)}</b></div>
      </div>
      ${etiqueta ? html`<p class="small muted">Todos llevan la etiqueta <span class="tag">${icon('tag', 'sm')} ${etiqueta}</span></p>` : ''}
    </div>`);
    dibujar(foot, html`<button class="btn" data-otra>Importar otro archivo</button><button class="btn btn-primary" data-listo>Ver contactos</button>`);
    $('[data-otra]', foot).addEventListener('click', pasoSubir);
    $('[data-listo]', foot).addEventListener('click', () => m.close({ ...r, etiqueta }));
    onFin?.({ ...r, etiqueta, parcial: true });
  }

  pasoSubir();
  return m.done;
}

