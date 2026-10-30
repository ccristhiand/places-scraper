// WhatsApp (API oficial de Meta): conexión con Embedded Signup, plantillas, recordatorios y consumo
import { html, raw, icon, api, render as dibujar, acciones, fmt, can, vacio, toast, toastError, confirmar, $, $$, cargando, modal, formModal, conCarga, session, esc } from '../core.js';

const TABS = [['conexion', 'Conexión', 'link'], ['plantillas', 'Plantillas', 'template'], ['recordatorios', 'Recordatorios', 'clock'], ['consumo', 'Consumo', 'chart']];
const ESTADO_PL = {
  APPROVED: ['success', 'Aprobada'], PENDING: ['warning', 'En revisión'], IN_APPEAL: ['warning', 'En apelación'],
  REJECTED: ['danger', 'Rechazada'], PAUSED: ['danger', 'Pausada'], DISABLED: ['', 'Deshabilitada'],
  aprobada: ['success', 'Aprobada'], pendiente: ['warning', 'En revisión'], rechazada: ['danger', 'Rechazada'],
  pausada: ['danger', 'Pausada'], deshabilitada: ['', 'Deshabilitada'], sin_crear: ['', 'Sin crear'],
};
const DATOS = { contacto: 'Persona de contacto', nombre: 'Nombre del negocio', distrito: 'Distrito', provincia: 'Provincia', rubro: 'Rubro', responsable: 'Vendedor asignado' };
const EJEMPLO = { contacto: 'María', nombre: 'Ferretería San Martín', distrito: 'Miraflores', provincia: 'Lima', rubro: 'ferreterías', responsable: 'Carlos' };

let st;

export async function render(el, params) {
  st = { tab: TABS.some(t => t[0] === params[0]) ? params[0] : 'conexion', estado: null };
  dibujar(el, html`
    <div class="page-head"><div><h1>WhatsApp</h1><p>Conexión con la API oficial de Meta, plantillas de mensajes y consumo.</p></div></div>
    <div class="tabs">${TABS.map(([k, t, i]) => html`<a class="tab ${st.tab === k ? 'active' : ''}" href="#/whatsapp/${k}">${icon(i, 'sm')} ${t}</a>`)}</div>
    <div data-cont>${cargando()}</div>`);
  acciones(el, ACCIONES(el));
  await pintar(el);
}

async function pintar(el) {
  const cont = $('[data-cont]', el);
  try {
    st.estado = await api.get('/api/whatsapp/estado');
    session.meta = st.estado.cuenta.estado === 'conectado';
    if (st.tab === 'conexion') return conexion(cont);
    if (st.estado.cuenta.estado !== 'conectado')
      return dibujar(cont, html`<div class="card">${vacio({ icono: 'link', titulo: 'Primero conecta tu número', texto: 'Las plantillas y el consumo se leen de tu cuenta de WhatsApp Business en Meta.',
        accion: html`<a class="btn btn-primary" href="#/whatsapp/conexion">Ir a Conexión</a>` })}</div>`);
    if (st.tab === 'plantillas') return plantillas(cont);
    if (st.tab === 'recordatorios') return recordatorios(cont);
    if (st.tab === 'consumo') return consumo(cont);
  } catch (e) { toastError(e); dibujar(cont, ''); }
}

// ── Conexión ──────────────────────────────────────────────────────────────
function conexion(cont) {
  const { cuenta: c, plataforma: p } = st.estado;
  const editable = can('config.editar');
  const fila = (k, v) => html`<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border)"><span class="muted">${k}</span><span class="strong">${v ?? '—'}</span></div>`;
  const calidad = { GREEN: ['success', 'Alta'], YELLOW: ['warning', 'Media'], RED: ['danger', 'Baja'] }[c.calidad] || ['', c.calidad || '—'];

  dibujar(cont, html`
    ${p.config_invalido ? html`<div class="alert danger mb">${icon('alert')}<div><b>El Configuration ID guardado es el App ID.</b> Copia el ID de la configuración de WhatsApp Embedded Signup (Inicio de sesión con Facebook para empresas → Configuraciones).
      ${can('config.ver') ? html`<a href="#/config/meta">Corregir en Configuración → WhatsApp</a>` : ''}</div></div>` : !p.lista ? html`<div class="alert warning mb">${icon('alert')}<div><b>Falta configurar la app de Meta.</b> Para el botón de conexión se necesitan el App ID, la clave secreta y el Configuration ID de Embedded Signup.
      ${can('config.ver') ? html`<a href="#/config/meta">Ir a Configuración → WhatsApp</a>` : 'Pídeselo al administrador.'}</div></div>` : ''}
    <div class="grid side">
      <div class="card"><div class="card-head"><h3>${icon('whatsapp', 'sm')} Número de la empresa</h3>
        <span class="badge ${c.estado === 'conectado' ? 'success' : c.estado === 'error' ? 'danger' : c.estado === 'conectando' ? 'warning' : ''}">${{ conectado: 'Conectado', desconectado: 'Sin conectar', conectando: 'Conectando…', error: 'Error' }[c.estado] || c.estado}</span></div>
        <div class="card-body">
          ${c.estado === 'conectado' ? html`
            ${fila('Número', c.numero_display)}${fila('Nombre verificado', c.nombre_verificado)}
            ${fila('Calidad', raw(`<span class="badge ${calidad[0]}">${esc(calidad[1])}</span>`))}
            ${fila('Uso con la app WhatsApp Business', c.coexistencia ? 'Sí (coexistencia)' : 'No')}
            ${c.coexistencia ? fila('Historial y contactos', { en_proceso: 'Sincronizando', pendiente: 'Pendiente', no_aplica: '—', completo: 'Sincronizado' }[c.historial_sync] || c.historial_sync) : ''}
            ${fila('Avisos de Meta (webhook)', c.webhook_ok ? 'Suscrito' : 'Sin suscribir')}
            ${fila('Conectado', fmt.fechaHora(c.conectado_at))}${fila('Modo', c.modo === 'manual' ? 'Token manual' : 'Embedded Signup')}
            ${c.ultimo_error ? html`<div class="alert warning mt small">${icon('alert', 'sm')}<div>${c.ultimo_error}</div></div>` : ''}
            ${editable ? html`<div class="row wrap mt">
              <button class="btn" data-act="diagnostico">${icon('refresh', 'sm')} Revisar número con Meta</button>
              <button class="btn" data-act="registrar">${icon('key', 'sm')} Registrar número</button>
              <button class="btn btn-danger right" data-act="desconectar">Desconectar</button></div>` : ''}
          ` : html`
            <p class="muted mb">Conecta el número de WhatsApp Business de tu empresa con la API oficial de Meta. Se abrirá una ventana de Facebook para iniciar sesión, elegir tu cuenta de negocio y el número.</p>
            ${editable ? html`<div class="stack">
              <button class="btn btn-primary" data-act="conectar" data-modo="nuevo" ${p.lista ? '' : raw('disabled')} style="height:40px">${icon('whatsapp', 'sm')} Conectar con WhatsApp</button>
              <button class="btn" data-act="conectar" data-modo="coexistencia" ${p.lista ? '' : raw('disabled')}>${icon('phone', 'sm')} Ya uso este número en la app WhatsApp Business</button>
              <p class="xs muted">La segunda opción mantiene tu número funcionando en el celular (coexistencia) y trae tus contactos e historial de los últimos 6 meses.</p>
              <button class="btn btn-ghost btn-sm" data-act="manual" style="align-self:flex-start">Conexión manual con token (avanzado)</button>
            </div>` : html`<p class="small muted">Solo un administrador puede conectar el número.</p>`}
            ${c.ultimo_error ? html`<div class="alert danger mt small">${icon('alert', 'sm')}<div>${c.ultimo_error}</div></div>` : ''}
          `}
        </div></div>
      <div class="stack">
        <div class="card"><div class="card-head"><h3>${icon('info', 'sm')} Cómo funciona</h3></div><div class="card-body small stack sm">
          <p>1. Pulsa <b>Conectar con WhatsApp</b> e inicia sesión con la cuenta de Facebook que administra tu negocio.</p>
          <p>2. Elige o crea tu cuenta de WhatsApp Business y el número.</p>
          <p>3. Crea tus <b>plantillas</b> y espera la aprobación de Meta (minutos u horas).</p>
          <p>4. Responde desde la <b>Bandeja</b> y lanza <b>Campañas</b> con plantillas aprobadas.</p>
          <p class="muted">WhatsApp solo permite escribir libremente hasta 24 h después del último mensaje del cliente; fuera de ese plazo se usan plantillas.</p>
        </div></div>
        <div class="card"><div class="card-head"><h3>${icon('zap', 'sm')} Webhook</h3></div><div class="card-body small stack sm">
          <div class="copy-box"><code>${p.webhook_url}</code><button class="btn btn-sm" data-act="copiar" data-v="${p.webhook_url}">${icon('copy', 'sm')}</button></div>
          <p class="muted">${p.webhook_verificado_at ? `Verificado por Meta el ${fmt.fechaHora(p.webhook_verificado_at)}.` : 'Meta aún no verificó esta URL. Configúrala en tu app de Meta → WhatsApp → Configuración.'}</p>
        </div></div>
      </div>
    </div>`);
}

// SDK de Facebook (Embedded Signup)
let sdk = null, sesionSignup = {};
function cargarSdk(appId, version) {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(window.FB); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/es_LA/sdk.js'; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => { sdk = null; reject(new Error('No se pudo cargar el SDK de Facebook. Revisa tu conexión o el bloqueador de anuncios.')); };
    document.head.appendChild(s);
  });
  return sdk;
}
// La ventana de Meta informa el WABA y el número elegidos por postMessage
window.addEventListener('message', ev => {
  if (!/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(ev.origin)) return;
  let d = ev.data;
  try { if (typeof d === 'string') d = JSON.parse(d); } catch { return; }
  if (d?.type !== 'WA_EMBEDDED_SIGNUP') return;
  if (String(d.event || '').startsWith('FINISH')) {
    sesionSignup = { evento: d.event, waba_id: d.data?.waba_id, phone_number_id: d.data?.phone_number_id, business_id: d.data?.business_id };
  } else if (d.event === 'CANCEL') {
    sesionSignup = { cancelado: true, paso: d.data?.current_step };
  } else if (d.event === 'ERROR') {
    sesionSignup = { error: d.data?.error_message };
  }
});

async function conectar(el, modo, btn) {
  const p = st.estado.plataforma;
  await conCarga(btn, async () => {
    let FB;
    try { FB = await cargarSdk(p.app_id, p.graph_ver); } catch (e) { return toastError(e); }
    sesionSignup = {};
    const code = await new Promise(resolve => {
      FB.login(r => resolve(r?.authResponse?.code || null), {
        config_id: p.config_id, response_type: 'code', override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: '3', ...(modo === 'coexistencia' ? { featureType: 'whatsapp_business_app_onboarding' } : {}) },
      });
    });
    if (!code) {
      toast(sesionSignup.error ? `Meta: ${sesionSignup.error}` : 'Se cerró la ventana de Meta sin terminar la conexión.', 'warning', 6000);
      return;
    }
    try {
      // La ventana puede enviar los ids un instante después del code
      await new Promise(r => setTimeout(r, 600));
      const r = await api.post('/api/whatsapp/conectar', { code, ...sesionSignup });
      toast(`WhatsApp conectado: ${r.cuenta.numero_display || ''}`);
      if (r.pin || r.avisos?.length) mostrarResultado(r);
      pintar(el);
    } catch (e) { toastError(e); pintar(el); }
  });
}

function mostrarResultado(r) {
  modal({
    title: 'Número conectado', size: 'sm',
    body: html`${r.pin ? html`<p class="small">Se activó la verificación en dos pasos con este PIN. <b>Guárdalo</b>: Meta lo pedirá si vuelves a registrar el número.</p>
      <div class="copy-box mt"><code style="font-size:18px;letter-spacing:.2em">${r.pin}</code><button class="btn btn-sm" data-copiar>${icon('copy', 'sm')}</button></div>` : ''}
      ${(r.avisos || []).map(a => html`<div class="alert warning small mt">${icon('alert', 'sm')}<div>${a}</div></div>`)}`,
    foot: html`<button class="btn btn-primary" data-close>Entendido</button>`,
    onMount: m => $('[data-copiar]', m.el)?.addEventListener('click', () => navigator.clipboard?.writeText(r.pin).then(() => toast('PIN copiado'))),
  });
}

// ── Plantillas ────────────────────────────────────────────────────────────
async function plantillas(cont) {
  dibujar(cont, cargando('Leyendo plantillas de Meta…'));
  const { rows } = await api.get('/api/whatsapp/plantillas');
  const gestionar = can('campanas.gestionar');
  dibujar(cont, html`
    <div class="row mb"><p class="small muted grow">Meta revisa cada plantilla antes de permitir su uso. Las de <b>Marketing</b> sirven para campañas; las de <b>Utilidad</b> para avisos y seguimiento.</p>
      <button class="btn" data-act="recargar">${icon('refresh', 'sm')} Actualizar</button>
      ${gestionar ? html`<button class="btn btn-primary" data-act="nueva-plantilla">${icon('plus', 'sm')} Nueva plantilla</button>` : ''}</div>
    <div class="card">${rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Plantilla</th><th>Categoría</th><th>Estado</th><th>Mensaje</th><th></th></tr></thead><tbody>
      ${rows.map(t => { const [tone, txt] = ESTADO_PL[t.estado] || ['', t.estado];
        return html`<tr><td><div class="strong mono">${t.nombre}</div><div class="xs muted">${t.idioma}${t.es_sistema ? ' · del sistema' : ''}${t.header && t.header !== 'TEXT' ? ` · encabezado ${t.header.toLowerCase()}` : ''}</div></td>
          <td class="small">${{ MARKETING: 'Marketing', UTILITY: 'Utilidad', AUTHENTICATION: 'Autenticación' }[t.categoria] || t.categoria}</td>
          <td><span class="badge ${tone}">${txt}</span>${t.motivo_rechazo ? html`<div class="xs" style="color:var(--danger);max-width:200px">${t.motivo_rechazo}</div>` : ''}</td>
          <td class="small" style="max-width:420px;white-space:pre-wrap">${t.cuerpo}</td>
          <td class="actions">${gestionar && !t.es_sistema ? html`<button class="btn btn-ghost btn-sm btn-icon" data-act="borrar-plantilla" data-n="${t.nombre}" aria-label="Eliminar">${icon('trash', 'sm')}</button>` : ''}</td></tr>`; })}
      </tbody></table></div>` : vacio({ icono: 'template', titulo: 'Aún no tienes plantillas', texto: 'Crea tu primera plantilla para iniciar conversaciones y lanzar campañas.',
        accion: gestionar ? html`<button class="btn btn-primary" data-act="nueva-plantilla">${icon('plus', 'sm')} Nueva plantilla</button>` : '' })}</div>`);
}

function nuevaPlantilla(el) {
  const m = modal({
    title: 'Nueva plantilla', subtitle: 'Se envía a revisión de Meta. Usa los botones para insertar datos del contacto.', size: 'lg',
    body: html`<form class="form-grid" data-f novalidate>
      <label class="field"><span>Nombre interno *</span><input class="input mono" name="nombre" required maxlength="100" placeholder="promo_noviembre"><span class="hint">Minúsculas, números y guion bajo.</span></label>
      <label class="field"><span>Categoría *</span><select class="select" name="categoria"><option value="MARKETING">Marketing (promociones, campañas)</option><option value="UTILITY">Utilidad (avisos, seguimiento)</option></select></label>
      <div class="field span-2"><span>Encabezado</span><div class="seg" data-enc>
        <button type="button" class="active" data-e="ninguno">Sin encabezado</button><button type="button" data-e="texto">Texto</button><button type="button" data-e="imagen">Imagen</button></div></div>
      <label class="field span-2 hidden" data-enc-texto><input class="input" name="encabezado" maxlength="60" placeholder="Título corto (sin datos variables)"></label>
      <label class="field span-2 hidden" data-enc-imagen><input class="input" type="file" name="imagen" accept="image/jpeg,image/png" style="padding:5px"><span class="hint">Imagen de ejemplo para la revisión (JPG o PNG, máx. 5 MB). En cada campaña eliges la imagen real.</span></label>
      <label class="field span-2"><span>Mensaje *</span><textarea class="input" name="cuerpo" rows="6" maxlength="1024" placeholder="Hola [contacto], te escribimos de [empresa]…"></textarea>
        <div class="row wrap">${Object.entries(DATOS).map(([k, t]) => html`<button type="button" class="tag" data-tag="${k}" title="${t}" style="cursor:pointer">[${k}]</button>`)}
          <button type="button" class="tag" data-tag="empresa" title="Nombre de tu empresa (fijo)" style="cursor:pointer">[empresa]</button></div></label>
      <label class="field span-2"><span>Pie (opcional)</span><input class="input" name="pie" maxlength="60" placeholder="Responde SALIR si no deseas recibir mensajes"></label>
      <div class="span-2"><div class="label" style="margin-bottom:6px">Vista previa</div><div class="bubble out" style="max-width:100%" data-prev>…</div><ul class="reqs" data-problemas></ul></div>
    </form>`,
    foot: html`<button class="btn" data-close>Cancelar</button><button class="btn btn-primary" data-enviar>Enviar a revisión</button>`,
    onMount: m => {
      const f = $('[data-f]', m.el);
      let enc = 'ninguno';
      const prev = () => {
        const empresa = session.empresa || 'tu empresa';
        const cuerpo = f.cuerpo.value.replace(/\[([a-z_]+)\]/gi, (x, k) => k.toLowerCase() === 'empresa' ? empresa : (EJEMPLO[k.toLowerCase()] ?? x));
        $('[data-prev]', f).textContent = [enc === 'texto' ? f.encabezado.value : '', cuerpo, f.pie.value].filter(Boolean).join('\n\n') || '…';
        // Las mismas reglas que revisa el servidor (y que más rechaza Meta)
        const t = f.cuerpo.value.trim(), p = [];
        if (/^\[(?!empresa\])[a-z_]+\]/i.test(t)) p.push('No empieces el mensaje con un dato.');
        if (/\[(?!empresa\])[a-z_]+\][\s.!?¡¿]*$/i.test(t)) p.push('No termines el mensaje con un dato: agrega texto después.');
        if (/\[(?!empresa\])[a-z_]+\]\s*\[(?!empresa\])[a-z_]+\]/i.test(t)) p.push('No pongas dos datos seguidos.');
        dibujar($('[data-problemas]', f), html`${p.map(x => html`<li style="color:var(--warning)">• ${x}</li>`)}`);
      };
      f.addEventListener('input', prev);
      f.nombre.addEventListener('input', () => { f.nombre.value = f.nombre.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''); });
      f.addEventListener('click', e => {
        const b = e.target.closest('[data-e]');
        if (b) {
          enc = b.dataset.e;
          $$('[data-e]', f).forEach(x => x.classList.toggle('active', x === b));
          $('[data-enc-texto]', f).classList.toggle('hidden', enc !== 'texto');
          $('[data-enc-imagen]', f).classList.toggle('hidden', enc !== 'imagen');
          prev();
        }
        const tg = e.target.closest('[data-tag]');
        if (tg) {
          const ta = f.cuerpo, pos = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, pos) + `[${tg.dataset.tag}]` + ta.value.slice(ta.selectionEnd ?? pos);
          ta.focus(); prev();
        }
      });
      $('[data-enviar]', m.el).addEventListener('click', async e => {
        if (!f.nombre.value || !f.cuerpo.value.trim()) return toast('Completa el nombre y el mensaje.', 'warning');
        const fd = new FormData();
        ['nombre', 'categoria', 'cuerpo', 'pie'].forEach(k => fd.append(k, f[k].value));
        fd.append('encabezado_tipo', enc);
        if (enc === 'texto') fd.append('encabezado', f.encabezado.value);
        if (enc === 'imagen' && f.imagen.files[0]) fd.append('imagen', f.imagen.files[0]);
        await conCarga(e.currentTarget, async () => {
          try { await api.form('POST', '/api/whatsapp/plantillas', fd); toast('Plantilla enviada a revisión de Meta'); m.close(true); pintar(el); }
          catch (ex) { toastError(ex); }
        });
      });
    },
  });
  return m;
}

// ── Recordatorios (plantillas del sistema) ────────────────────────────────
async function recordatorios(cont) {
  dibujar(cont, cargando());
  const { rows } = await api.get('/api/whatsapp/plantillas-sistema');
  const editable = can('config.editar');
  dibujar(cont, html`
    <p class="small muted mb">Fuera de la ventana de 24 h, WhatsApp solo permite plantillas aprobadas. Estas plantillas del sistema se usan para los avisos automáticos; envíalas a revisión una sola vez.</p>
    <div class="grid c2">${rows.map(s => { const [tone, txt] = ESTADO_PL[s.estado] || ['', s.estado];
      return html`<div class="card"><div class="card-head"><h3>${s.titulo}</h3><span class="badge ${tone}">${txt}</span></div><div class="card-body stack sm">
        <p class="small muted">${s.descripcion}</p>
        <div class="bubble out small" style="max-width:100%">${s.texto}</div>
        <div class="xs muted mono">${s.nombre_meta}</div>
        ${s.motivo_rechazo ? html`<div class="alert danger small">${icon('alert', 'sm')}<div>${s.motivo_rechazo}</div></div>` : ''}
        ${editable && ['sin_crear', 'rechazada', 'deshabilitada'].includes(s.estado) ? html`<button class="btn btn-primary btn-sm" data-act="crear-sistema" data-uso="${s.uso}" style="align-self:flex-start">Enviar a revisión</button>` : ''}
      </div></div>`; })}</div>
    <div class="card mt"><div class="card-body small row wrap">${icon('settings', 'sm')}
      <span class="grow">Activa o desactiva los recordatorios y el número que recibe los avisos de leads en Configuración.</span>
      <a class="btn btn-sm" href="#/config/chat">Recordatorios</a><a class="btn btn-sm" href="#/config/leads">Avisos de leads</a></div></div>`);
}

// ── Consumo ───────────────────────────────────────────────────────────────
async function consumo(cont) {
  const r = await api.get('/api/whatsapp/consumo');
  const nombres = { manual: 'Bandeja (manual)', campana: 'Campañas', recordatorio: 'Recordatorios', alerta: 'Alertas' };
  dibujar(cont, html`
    ${r.supera ? html`<div class="alert warning mb">${icon('alert')}<div>Este mes ya se enviaron <b>${fmt.num(r.total)}</b> mensajes, por encima del aviso configurado (${fmt.num(r.alerta)}). Meta cobra las conversaciones según su tarifa vigente.</div></div>` : ''}
    <div class="grid c3 mb">
      <div class="card kpi"><div><div class="kpi-label">Mensajes enviados en ${r.mes}</div><div class="kpi-value">${fmt.num(r.total)}</div><div class="kpi-sub">Aviso al llegar a ${fmt.num(r.alerta)}</div></div></div>
      <div class="card kpi"><div><div class="kpi-label">Con plantilla</div><div class="kpi-value">${fmt.num(r.plantillas)}</div><div class="kpi-sub">Inician conversación (con costo)</div></div></div>
      <div class="card kpi"><div><div class="kpi-label">Dentro de la ventana de 24 h</div><div class="kpi-value">${fmt.num(r.total - r.plantillas)}</div><div class="kpi-sub">Respuestas a clientes</div></div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Por origen</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Origen</th><th>Enviados</th><th>Fallidos</th></tr></thead><tbody>
      ${Object.entries(r.por_origen).map(([k, v]) => html`<tr><td>${nombres[k] || k}</td><td>${fmt.num(v.enviados)}</td><td>${v.fallidos ? html`<span class="badge danger">${fmt.num(v.fallidos)}</span>` : '0'}</td></tr>`)}
      ${Object.keys(r.por_origen).length ? '' : html`<tr><td colspan="3" class="muted center">Sin mensajes este mes.</td></tr>`}
    </tbody></table></div></div>`);
}

// ── Acciones ──────────────────────────────────────────────────────────────
const ACCIONES = el => ({
  conectar: b => conectar(el, b.dataset.modo, b),
  copiar: b => navigator.clipboard?.writeText(b.dataset.v).then(() => toast('Copiado')),
  recargar: () => pintar(el),
  manual: () => formModal({
    title: 'Conexión manual', subtitle: 'Solo si no puedes usar el botón de Meta. Necesitas un token permanente de un usuario del sistema.',
    fields: html`<label class="field"><span>Phone Number ID</span><input class="input" name="phone_number_id" required inputmode="numeric"></label>
      <label class="field"><span>WhatsApp Business Account ID</span><input class="input" name="waba_id" required inputmode="numeric"></label>
      <label class="field span-2"><span>Token permanente</span><input class="input" type="password" name="token" required autocomplete="off"></label>`,
    submit: 'Conectar',
    onSubmit: async d => { await api.post('/api/whatsapp/conectar-manual', d); toast('WhatsApp conectado'); pintar(el); },
  }),
  diagnostico: async b => conCarga(b, async () => {
    try {
      const { diagnostico: d } = await api.post('/api/whatsapp/diagnostico');
      modal({ title: 'Revisión del número', size: 'sm',
        body: html`<div class="stack sm small">
          ${[['Número', d.numero], ['Nombre', d.nombre], ['Estado del número', d.estado_numero], ['Estado del nombre', d.estado_nombre], ['Verificación', d.verificacion],
             ['Calidad', d.calidad], ['Límite de mensajes', d.limite], ['Plataforma', d.plataforma], ['Coexistencia', d.coexistencia ? 'Sí' : 'No'], ['Webhook suscrito', d.suscrito ? 'Sí' : 'No']]
            .map(([k, v]) => html`<div class="row between"><span class="muted">${k}</span><b>${v ?? '—'}</b></div>`)}
          ${d.avisos.map(a => html`<div class="alert warning">${icon('alert', 'sm')}<div>${a}</div></div>`)}</div>`,
        foot: html`<button class="btn btn-primary" data-close>Cerrar</button>` });
      pintar(el);
    } catch (e) { toastError(e); }
  }),
  registrar: () => formModal({
    title: 'Registrar número en la API', size: 'sm', submit: 'Registrar',
    subtitle: 'Úsalo si Meta responde "Account not registered" (133010). Si el número ya tiene PIN de verificación en dos pasos, escríbelo.',
    fields: html`<label class="field span-2"><span>PIN de 6 dígitos (opcional)</span><input class="input" name="pin" inputmode="numeric" maxlength="6" pattern="\\d{6}"></label>`,
    onSubmit: async d => { const r = await api.post('/api/whatsapp/registrar', d); toast('Número registrado en Meta'); if (r.pin) mostrarResultado({ pin: r.pin }); pintar(el); },
  }),
  desconectar: async () => {
    if (!(await confirmar('Dejarás de recibir y enviar mensajes por la API hasta volver a conectar. Las campañas en curso quedarán en espera.', { titulo: 'Desconectar WhatsApp', ok: 'Desconectar', peligro: true }))) return;
    try { await api.post('/api/whatsapp/desconectar'); toast('WhatsApp desconectado'); pintar(el); } catch (e) { toastError(e); }
  },
  'nueva-plantilla': () => nuevaPlantilla(el),
  'borrar-plantilla': async b => {
    if (!(await confirmar(`Se eliminará "${b.dataset.n}" de tu cuenta de Meta. Las campañas que la usen se pausarán.`, { titulo: 'Eliminar plantilla', ok: 'Eliminar', peligro: true }))) return;
    try { await api.del(`/api/whatsapp/plantillas/${encodeURIComponent(b.dataset.n)}`); toast('Plantilla eliminada'); pintar(el); } catch (e) { toastError(e); }
  },
  'crear-sistema': async b => conCarga(b, async () => {
    try {
      const { resultados } = await api.post('/api/whatsapp/plantillas-sistema', { uso: b.dataset.uso });
      const r = resultados[0];
      r.ok ? toast('Plantilla enviada a revisión de Meta') : toastError(new Error(r.error));
      pintar(el);
    } catch (e) { toastError(e); }
  }),
});
