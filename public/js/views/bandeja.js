import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, bus, $, $$, debounce, avatar, etapaBadge, cargando, modal, formModal, conCarga, confirmar } from '../core.js';
import { abrirContacto } from '../contacto.js';

let subs = [], st;
export function destroy() { subs.forEach(f => f()); subs = []; }

// Checks estilo WhatsApp (SVG): uno = enviado, dos = entregado, dos azules = leído
const SVG_1 = '<svg class="tick" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 6l3.2 3.2L11.5 1.8"/></svg>';
const SVG_2 = '<svg class="tick" viewBox="0 0 18 11" aria-hidden="true"><path d="M1 6l3.2 3.2L11 1.8"/><path d="M7.4 8.8l.4.4L14.6 1.8"/></svg>';
const SVG_X = '<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v3.6M8 11h.01"/></svg>';
const TICK = { enviado: SVG_1, entregado: SVG_2, leido: SVG_2, fallido: SVG_X };
const tick = estado => raw(`<span data-estado class="ticks ${TICK[estado] ? estado : ''}">${TICK[estado] || ''}</span>`);

const TZ = 'America/Lima';
const claveDia = v => new Date(v).toLocaleDateString('en-CA', { timeZone: TZ });
const diasAtras = v => Math.round((new Date(claveDia(Date.now())) - new Date(claveDia(v))) / 864e5);
const diaSemana = v => new Date(v).toLocaleDateString('es-PE', { timeZone: TZ, weekday: 'long' });
// Hora de la lista: hoy → 14:05 · ayer → Ayer · esta semana → lunes · antes → 03/11/26
function horaLista(v) {
  if (!v) return '';
  const n = diasAtras(v);
  if (n <= 0) return fmt.hora(v);
  if (n === 1) return 'Ayer';
  if (n < 7) return diaSemana(v);
  return new Date(v).toLocaleDateString('es-PE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' });
}
function diaSep(v) {
  const n = diasAtras(v);
  if (n <= 0) return 'Hoy';
  if (n === 1) return 'Ayer';
  if (n < 7) { const t = diaSemana(v); return t[0].toUpperCase() + t.slice(1); }
  return new Date(v).toLocaleDateString('es-PE', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
}

export async function render(el, params) {
  st = { id: params[0] ? +params[0] : null, q: '', filtro: '', convs: [], contacto: null, respuestas: [] };
  dibujar(el, html`<div class="inbox wa ${st.id ? 'has-chat' : ''}" data-inbox>
    <aside class="inbox-list">
      <div class="wa-list-head">
        <h2>Chats</h2>
        ${can('chat.enviar') ? html`<button class="wa-icon-btn" data-act="nueva" title="Nueva conversación" aria-label="Nueva conversación">${icon('edit')}</button>` : ''}
      </div>
      <div class="wa-search">${icon('search', 'sm')}<input data-q placeholder="Buscar un chat" aria-label="Buscar conversación"></div>
      <div class="wa-chips"><button class="active" data-act="filtro" data-f="">Todos</button><button data-act="filtro" data-f="no_leidos">No leídos</button></div>
      <div class="conv-list" data-convs>${cargando()}</div>
    </aside>
    <section class="chat" data-chat>${vacioChat()}</section></div>`);

  $('[data-q]', el).addEventListener('input', debounce(e => { st.q = e.target.value; cargarLista(el); }, 300));
  acciones(el, {
    filtro: b => { st.filtro = b.dataset.f; $$('[data-act=filtro]', el).forEach(x => x.classList.toggle('active', x === b)); cargarLista(el); },
    conv: a => { location.hash = `#/bandeja/${a.dataset.id}`; },
    volver: () => { location.hash = '#/bandeja'; },
    ficha: () => abrirContacto(st.id, { onCambio: () => abrirChat(el) }),
    nueva: () => nuevaConversacion(),
    plantilla: () => elegirPlantilla(el),
    imagen: () => $('[data-file]', el).click(),
    respuesta: b => insertar(el, st.respuestas.find(r => r.id === +b.dataset.id)?.texto || ''),
    'gestionar-respuestas': () => gestionarRespuestas(el),
    'menu-respuestas': () => toggleRespuestas(el),
    abajo: () => { const c = $('[data-msgs]', el); c?.scrollTo({ top: c.scrollHeight, behavior: 'smooth' }); },
  });

  subs.push(bus.on('chat:mensaje', m => {
    if (m.negocio_id && m.negocio_id === st.id) {
      if (m.direccion === 'entrante') { st.contacto.ultimo_entrante_at = new Date(); st.contacto.ventana_abierta = true; pintarComposer(el); }
      if (!$(`[data-wa="${CSS.escape(m.wa_id || '')}"]`, el) || !m.wa_id) agregarBurbuja(el, m);
    }
    cargarListaD(el);
  }));
  subs.push(bus.on('chat:estado', s => {
    const b = $(`[data-wa="${CSS.escape(s.wa_id)}"] [data-estado]`, el);
    if (b) { b.className = `ticks ${s.estado}`; b.innerHTML = TICK[s.estado] || ''; if (s.estado === 'fallido') b.closest('.bubble').classList.add('failed'); }
  }));

  await cargarLista(el);
  if (st.id) abrirChat(el);
}

const vacioChat = () => html`<div class="wa-intro">
  <div class="wa-intro-icon">${icon('whatsapp')}</div>
  <h3>Bandeja de WhatsApp</h3>
  <p>Selecciona un chat para ver la conversación. Los mensajes de tus contactos llegan aquí en tiempo real.</p>
  <div class="wa-intro-foot">${icon('lock', 'sm')} Las conversaciones se sincronizan con tu número de WhatsApp</div></div>`;

const cargarListaD = debounce(el => cargarLista(el), 600);
async function cargarLista(el) {
  try {
    const { rows } = await api.get('/api/chat', { q: st.q, filtro: st.filtro });
    st.convs = rows;
    dibujar($('[data-convs]', el), rows.length ? html`${rows.map(c => {
      const ventana = c.ventana_abierta && c.proveedor !== 'baileys';
      return html`<a class="conv ${c.id === st.id ? 'active' : ''} ${c.no_leidos ? 'unread-row' : ''}" href="#/bandeja/${c.id}" data-act="conv" data-id="${c.id}">
      ${avatar(c.nombre, 'lg')}
      <div class="conv-main">
        <div class="conv-top"><span class="conv-name truncate">${c.nombre}</span><span class="conv-time">${horaLista(c.ultimo_msg)}</span></div>
        <div class="conv-bottom"><span class="conv-last truncate">${c.ultima_direccion === 'saliente' ? tick(c.ultimo_estado) : ''}${c.ultimo_texto || ''}</span>
          ${c.no_leidos ? html`<span class="unread">${c.no_leidos}</span>` : ''}</div>
        ${ventana || c.asignado_nombre ? html`<div class="conv-tags">${ventana ? html`<span class="wa-tag ok">Ventana abierta</span>` : ''}${c.asignado_nombre ? html`<span class="wa-tag">${icon('user', 'sm')} ${c.asignado_nombre}</span>` : ''}</div>` : ''}
      </div></a>`;
    })}`
      : html`<div class="wa-list-empty">${vacio({ icono: 'chat', titulo: st.q || st.filtro ? 'Sin resultados' : 'Aún no hay conversaciones', texto: st.q || st.filtro ? '' : 'Cuando un contacto te escriba o le envíes una campaña, aparecerá aquí.' })}</div>`);
  } catch (e) { toastError(e); }
}

async function abrirChat(el) {
  const chat = $('[data-chat]', el);
  dibujar(chat, cargando());
  try {
    const r = await api.get(`/api/chat/${st.id}`);
    st.contacto = r.contacto;
    if (can('chat.enviar')) st.respuestas = (await api.get('/api/chat/respuestas')).rows;
    const c = r.contacto;
    dibujar(chat, html`
      <header class="chat-head">
        <button class="wa-icon-btn chat-back" data-act="volver" aria-label="Volver">${icon('chevronLeft')}</button>
        <button class="chat-who" data-act="ficha" title="Ver ficha del contacto">
          ${avatar(c.nombre, 'lg')}
          <span class="chat-who-text"><span class="chat-who-name truncate">${c.nombre}</span>
          <span class="chat-who-sub truncate">${c.whatsapp || c.telefono_int || c.telefono || 'Sin número'}${c.asignado_nombre ? ` · ${c.asignado_nombre}` : ''}</span></span>
        </button>
        <span class="hide-mobile">${etapaBadge(c.estado_crm)}</span>
        <button class="wa-icon-btn" data-act="ficha" title="Ficha del contacto" aria-label="Ficha del contacto">${icon('user')}</button>
      </header>
      <div class="chat-wrap">
        <div class="chat-body" data-msgs></div>
        <button class="wa-fab hidden" data-act="abajo" aria-label="Ir al último mensaje">${icon('chevronDown')}</button>
      </div>
      <div data-composer></div>`);
    const cont = $('[data-msgs]', chat);
    const fab = $('.wa-fab', chat);
    cont.addEventListener('scroll', () => fab.classList.toggle('hidden', cont.scrollHeight - cont.scrollTop - cont.clientHeight < 240), { passive: true });
    if (!r.msgs.length) dibujar(cont, html`<div class="wa-sys">${icon('lock', 'sm')} Aún no hay mensajes. ${c.proveedor === 'baileys' ? 'Escribe el primero abajo.' : 'Inicia la conversación con una plantilla aprobada por Meta.'}</div>`);
    else r.msgs.forEach(m => agregarBurbuja(el, m, false));
    cont.scrollTop = cont.scrollHeight;
    pintarComposer(el);
    cargarLista(el);
  } catch (e) { toastError(e); dibujar(chat, vacioChat()); }
}

function burbuja(m, inicioGrupo) {
  const out = m.direccion === 'saliente';
  const img = m.media_url && /\.(jpe?g|png|webp)$/i.test(m.media_url);
  const soloImg = img && !m.contenido;
  return html`<div class="bubble ${out ? 'out' : 'in'} ${inicioGrupo ? 'tail' : ''} ${img ? 'has-img' : ''} ${soloImg ? 'only-img' : ''} ${m.estado_entrega === 'fallido' ? 'failed' : ''}" data-wa="${m.wa_id || ''}" title="${m.error_msg || ''}">
    ${out && inicioGrupo && m.usuario_nombre ? html`<div class="bubble-author">${m.usuario_nombre}</div>` : ''}
    ${m.tipo === 'plantilla' ? html`<div class="bubble-tpl">${icon('template', 'sm')} Plantilla</div>` : ''}
    ${img ? html`<a class="bubble-img" href="${m.media_url}" target="_blank" rel="noopener"><img src="${m.media_url}" alt="Imagen" loading="lazy"></a>` : ''}
    ${m.media_url && !img ? html`<a class="bubble-file" href="${m.media_url}" target="_blank" rel="noopener">${icon('paperclip', 'sm')} <span>Abrir archivo</span></a>` : ''}
    ${m.contenido ? html`<span class="bubble-text ${out ? 'sp-out' : 'sp-in'}">${m.contenido}</span>` : ''}
    <span class="bubble-meta"><span>${fmt.hora(m.created_at)}</span>${out ? tick(m.estado_entrega) : ''}</span>
    ${m.estado_entrega === 'fallido' && m.error_msg ? html`<div class="bubble-error">${m.error_msg}</div>` : ''}</div>`;
}

// Agrupa mensajes seguidos del mismo lado (como WhatsApp: la "colita" solo en el primero)
function agregarBurbuja(el, m, scroll = true) {
  const cont = $('[data-msgs]', el);
  if (!cont) return;
  const pegado = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 120;
  cont.querySelector('.wa-sys')?.remove();
  const dia = claveDia(m.created_at);
  const t = new Date(m.created_at).getTime();
  let nuevoGrupo = cont.dataset.lado !== m.direccion || Math.abs(t - Number(cont.dataset.t || 0)) > 10 * 60e3;
  if (dia !== cont.dataset.dia) { cont.insertAdjacentHTML('beforeend', String(html`<div class="day-sep"><span>${diaSep(m.created_at)}</span></div>`)); nuevoGrupo = true; }
  Object.assign(cont.dataset, { dia, lado: m.direccion, t });
  cont.insertAdjacentHTML('beforeend', String(burbuja(m, nuevoGrupo)));
  if (scroll && (pegado || m.direccion === 'saliente')) cont.scrollTop = cont.scrollHeight;
}

function pintarComposer(el) {
  const box = $('[data-composer]', el);
  if (!box) return;
  const c = st.contacto;
  if (!can('chat.enviar')) { dibujar(box, html`<div class="composer wa-composer-note">${icon('lock', 'sm')} Tu rol solo permite ver conversaciones.</div>`); return; }
  if (!c.ventana_abierta) {
    dibujar(box, html`<div class="composer wa-closed">
      <div class="wa-closed-text">${icon('clock', 'sm')}<span><b>Ventana de 24 h cerrada.</b> WhatsApp solo permite escribir libremente hasta 24 h después del último mensaje del cliente. Para retomar la conversación usa una plantilla aprobada.</span></div>
      <button class="btn btn-primary wa-btn" data-act="plantilla">${icon('template', 'sm')} Enviar plantilla</button></div>`);
    return;
  }
  const qr = c.proveedor === 'baileys';
  const restante = 24 * 3600e3 - (Date.now() - new Date(c.ultimo_entrante_at).getTime());
  const aviso = qr ? (c.no_contactar ? 'Este contacto pidió no recibir campañas' : '')
    : `Ventana abierta · quedan ${Math.max(0, Math.floor(restante / 3600e3))} h ${Math.max(0, Math.floor((restante % 3600e3) / 60e3))} min`;
  dibujar(box, html`<div class="composer">
    ${aviso ? html`<div class="wa-composer-hint">${icon(qr ? 'alert' : 'clock', 'sm')} ${aviso}</div>` : ''}
    <form class="wa-form" data-form>
      <div class="quick-menu hidden" data-quick></div>
      <button type="button" class="wa-icon-btn" data-act="menu-respuestas" title="Respuestas rápidas (escribe /)" aria-label="Respuestas rápidas">${icon('zap')}</button>
      <button type="button" class="wa-icon-btn" data-act="imagen" title="Adjuntar imagen" aria-label="Adjuntar imagen">${icon('paperclip')}</button>
      ${qr ? '' : html`<button type="button" class="wa-icon-btn" data-act="plantilla" title="Plantilla" aria-label="Plantilla">${icon('template')}</button>`}
      <input type="file" accept="image/jpeg,image/png,image/webp" data-file hidden>
      <div class="wa-input"><textarea name="texto" rows="1" placeholder="Escribe un mensaje" title="Enter envía · Shift+Enter nueva línea · / respuestas rápidas" maxlength="4096"></textarea></div>
      <button class="wa-send" type="submit" aria-label="Enviar">${icon('send')}</button>
    </form></div>`);
  const form = $('[data-form]', box), ta = form.texto;
  ta.focus();
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', () => {
    autosize();
    if (ta.value.startsWith('/')) toggleRespuestas(el, ta.value.slice(1));
    else $('[data-quick]', el)?.classList.add('hidden');
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const texto = ta.value.trim();
    if (!texto) return;
    await conCarga(form.querySelector('[type=submit]'), async () => {
      try {
        const r = await api.post(`/api/chat/${st.id}/texto`, { texto });
        ta.value = ''; autosize();
        if (!$(`[data-wa="${CSS.escape(r.msg.wa_id || '')}"]`, el)) agregarBurbuja(el, r.msg);
      } catch (ex) { toastError(ex); if (ex.codigo === 'VENTANA_CERRADA') { st.contacto.ventana_abierta = false; pintarComposer(el); } }
    });
  });
  $('[data-file]', box).addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('imagen', f); fd.append('texto', ta.value.trim());
    try { const r = await api.form('POST', `/api/chat/${st.id}/imagen`, fd); ta.value = ''; autosize(); agregarBurbuja(el, r.msg); toast('Imagen enviada'); }
    catch (ex) { toastError(ex); }
  });
}

function toggleRespuestas(el, filtro = null) {
  const q = $('[data-quick]', el);
  if (!q) return;
  if (filtro === null && !q.classList.contains('hidden')) { q.classList.add('hidden'); return; }
  const lista = st.respuestas.filter(r => !filtro || r.atajo.toLowerCase().includes(filtro.toLowerCase()));
  dibujar(q, html`${lista.map(r => html`<button type="button" data-act="respuesta" data-id="${r.id}"><b>/${r.atajo}</b> <span class="muted small">${r.texto.slice(0, 80)}</span></button>`)}
    <button type="button" data-act="gestionar-respuestas" class="small" style="color:var(--primary)">${icon('settings', 'sm')} Gestionar respuestas rápidas</button>`);
  q.classList.remove('hidden');
}

function insertar(el, texto) {
  const ta = $('[data-form] textarea', el);
  if (!ta) return;
  ta.value = texto.replace(/{{\s*nombre\s*}}/gi, st.contacto?.contacto_nombre || st.contacto?.nombre || '');
  $('[data-quick]', el).classList.add('hidden');
  ta.focus(); ta.dispatchEvent(new Event('input'));
}

async function gestionarRespuestas(el) {
  const pintar = m => dibujar($('[data-lista]', m.el), st.respuestas.length ? html`${st.respuestas.map(r => html`<div class="list-item" style="padding:10px 0">
    <div class="grow"><b>/${r.atajo}</b><div class="small muted" style="white-space:pre-wrap">${r.texto}</div></div>
    <button class="btn btn-ghost btn-sm btn-icon" data-borrar="${r.id}" aria-label="Borrar">${icon('trash', 'sm')}</button></div>`)}` : html`<p class="muted small">Aún no hay respuestas rápidas.</p>`);
  modal({
    title: 'Respuestas rápidas', subtitle: 'Escribe / en el chat para usarlas. {{nombre}} se reemplaza por el nombre del contacto.',
    body: html`<form class="stack sm" data-nueva><div class="row"><input class="input" name="atajo" placeholder="atajo (ej. precios)" style="max-width:170px" required maxlength="40">
      <button class="btn btn-primary right" type="submit">Agregar</button></div>
      <textarea class="input" name="texto" rows="3" placeholder="Texto de la respuesta…" required></textarea></form><div class="divider"></div><div data-lista></div>`,
    onMount: m => {
      pintar(m);
      $('[data-nueva]', m.el).addEventListener('submit', async e => {
        e.preventDefault();
        try { await api.post('/api/chat/respuestas', { atajo: e.target.atajo.value, texto: e.target.texto.value }); e.target.reset();
          st.respuestas = (await api.get('/api/chat/respuestas')).rows; pintar(m); } catch (ex) { toastError(ex); }
      });
      m.el.addEventListener('click', async e => {
        const b = e.target.closest('[data-borrar]'); if (!b) return;
        if (!(await confirmar('¿Borrar esta respuesta rápida?', { ok: 'Borrar', peligro: true }))) return;
        await api.del(`/api/chat/respuestas/${b.dataset.borrar}`);
        st.respuestas = st.respuestas.filter(r => r.id !== +b.dataset.borrar); pintar(m);
      });
    },
  });
}

async function elegirPlantilla(el) {
  let plantillas;
  try { plantillas = (await api.get('/api/campanas/plantillas')).rows.filter(t => t.estado === 'APPROVED'); }
  catch (e) { toastError(e); return; }
  if (!plantillas.length) { toast('No hay plantillas aprobadas. Créalas en el Administrador de WhatsApp de Meta.', 'warning', 7000); return; }
  const c = st.contacto;
  formModal({
    title: 'Enviar plantilla', subtitle: 'Mensaje aprobado por Meta para iniciar o retomar la conversación.', size: 'lg', submit: 'Enviar',
    fields: html`<label class="field span-2"><span>Plantilla</span><select class="select" name="tpl">${plantillas.map((t, i) => html`<option value="${i}">${t.nombre} · ${t.idioma} · ${t.categoria}</option>`)}</select></label>
      <div class="span-2" data-vars></div>
      <div class="span-2"><div class="label" style="margin-bottom:6px">Vista previa</div><div class="bubble out" data-prev style="max-width:100%"></div></div>`,
    onMount: (m, form) => {
      const pintar = () => {
        const t = plantillas[+form.tpl.value];
        dibujar($('[data-vars]', form), t.variables ? html`<div class="form-grid">${Array.from({ length: t.variables }, (_, i) => html`<label class="field"><span>Variable {{${i + 1}}}</span>
          <input class="input" name="p${i}" required value="${i === 0 ? (c.contacto_nombre || c.nombre) : ''}"></label>`)}</div>` : '');
        const prev = () => { $('[data-prev]', form).textContent = t.cuerpo.replace(/{{(\d+)}}/g, (x, n) => form[`p${n - 1}`]?.value || x); };
        form.oninput = prev; prev();
        if (t.header && t.header !== 'TEXT') $('[data-vars]', form).insertAdjacentHTML('beforeend', String(html`<div class="alert warning small mt">${icon('alert', 'sm')}<div>Esta plantilla tiene cabecera ${t.header}; úsala desde Campañas, donde puedes adjuntar la imagen.</div></div>`));
      };
      form.tpl.addEventListener('change', pintar); pintar();
    },
    onSubmit: async d => {
      const t = plantillas[+d.tpl];
      const params = Array.from({ length: t.variables }, (_, i) => d[`p${i}`]);
      const r = await api.post(`/api/chat/${st.id}/plantilla`, { nombre: t.nombre, idioma: t.idioma, params });
      agregarBurbuja(el, r.msg); toast('Plantilla enviada');
    },
  });
}

function nuevaConversacion() {
  const m = modal({
    title: 'Nueva conversación', subtitle: 'Busca el contacto al que quieres escribir.',
    body: html`<input class="input" data-buscar placeholder="Nombre o teléfono…" autocomplete="off"><div class="stack sm mt" data-res></div>`,
    onMount: m => {
      const inp = $('[data-buscar]', m.el), res = $('[data-res]', m.el);
      inp.addEventListener('input', debounce(async () => {
        if (inp.value.trim().length < 2) { res.innerHTML = ''; return; }
        const r = await api.get('/api/contactos', { q: inp.value.trim(), limit: 8 });
        dibujar(res, r.rows.length ? html`${r.rows.map(c => html`<a class="list-item card" href="#/bandeja/${c.id}" data-ir style="padding:10px 12px">${avatar(c.nombre, 'sm')}
          <div class="grow"><div class="strong">${c.nombre}</div><div class="xs muted">${c.whatsapp || c.telefono || 'Sin número'} · ${c.distrito || ''}</div></div>${icon('chevronRight', 'sm')}</a>`)}`
          : html`<p class="muted small">Sin resultados.</p>`);
      }, 250));
      res.addEventListener('click', e => { if (e.target.closest('[data-ir]')) m.close(); });
    },
  });
  return m;
}
