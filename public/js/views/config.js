import { html, raw, icon, api, render as dibujar, acciones, can, toast, toastError, $, $$, cargando, opciones, etapas, conCarga, formData, session, confirmar } from '../core.js';

const TABS = [
  ['empresa', 'Empresa', 'settings'], ['meta', 'WhatsApp (Meta)', 'whatsapp'], ['google', 'Google Places', 'search'],
  ['envios', 'Envíos masivos', 'send'], ['chat', 'Bandeja y recordatorios', 'chat'], ['pipeline', 'Etapas del pipeline', 'kanban'],
  ['leads', 'Formulario de leads', 'inbox'], ['proyectos', 'Proyectos', 'layers'], ['seguridad', 'Seguridad', 'shield'],
];
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const ZONAS = ['America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Guayaquil', 'America/La_Paz', 'America/Caracas', 'Europe/Madrid'];
let st;

export async function render(el, params) {
  st = { tab: TABS.some(t => t[0] === params[0]) ? params[0] : 'empresa', cfg: null, editable: can('config.editar') };
  dibujar(el, html`
    <div class="page-head"><div><h1>Configuración</h1><p>Integraciones, reglas de envío y preferencias del CRM.</p></div></div>
    ${st.editable ? '' : html`<div class="alert info mb">${icon('lock')}<div>Tu rol permite ver la configuración pero no modificarla.</div></div>`}
    <div class="grid" style="grid-template-columns:230px minmax(0,1fr);align-items:start" data-layout>
      <nav class="card" style="padding:6px">${TABS.map(([k, t, i]) => html`<a class="nav-link" style="color:var(--text-2)" href="#/config/${k}" data-tab="${k}">${icon(i)} ${t}</a>`)}</nav>
      <div data-cont>${cargando()}</div>
    </div>`);
  if (innerWidth < 900) $('[data-layout]', el).style.gridTemplateColumns = 'minmax(0,1fr)';
  try { st.cfg = await api.get('/api/config'); } catch (e) { toastError(e); return; }
  acciones(el, {
    'probar-meta': b => conCarga(b, async () => {
      try {
        const r = await api.post('/api/whatsapp/probar-app');
        dibujar($('[data-meta-res]', el), html`<div class="alert success">${icon('check')}<div><b>Conexión correcta con la app "${r.app}".</b>
          ${r.config_id_ok ? 'Ya puedes conectar el número en WhatsApp → Conexión.' : 'Falta el Configuration ID correcto de Embedded Signup (no es el App ID).'}</div></div>`);
      } catch (e) { dibujar($('[data-meta-res]', el), html`<div class="alert danger">${icon('alert')}<div>${e.message}</div></div>`); }
    }),
    'probar-google': b => conCarga(b, async () => {
      try { const r = await api.post('/api/config/google/probar'); toast(`Google Places responde correctamente (${r.resultados} resultados de prueba)`); }
      catch (e) { toastError(e); }
    }),
    'regenerar-token': async () => {
      if (!(await confirmar('Tendrás que actualizar el verify token también en Meta.', { titulo: 'Regenerar verify token', ok: 'Regenerar' }))) return;
      try { const r = await api.post('/api/config/meta/verify-token'); st.cfg.valores.meta_verify_token = r.token; pintar(el); toast('Token regenerado'); } catch (e) { toastError(e); }
    },
    copiar: b => navigator.clipboard?.writeText(b.dataset.v).then(() => toast('Copiado')),
    'etapa-add': () => { const lista = $('[data-etapas]', el); lista.insertAdjacentHTML('beforeend', String(filaEtapa({ nombre: '', color: '#64748b', tipo: 'abierta' }))); },
    'etapa-del': b => b.closest('[data-etapa]').remove(),
    'etapa-up': b => { const f = b.closest('[data-etapa]'); f.previousElementSibling && f.parentNode.insertBefore(f, f.previousElementSibling); },
    'etapa-down': b => { const f = b.closest('[data-etapa]'); f.nextElementSibling && f.parentNode.insertBefore(f.nextElementSibling, f); },
    'guardar-etapas': b => conCarga(b, async () => {
      const lista = $$('[data-etapa]', el).map(f => ({ clave: f.dataset.clave || undefined, nombre: $('[name=nombre]', f).value, color: $('[name=color]', f).value, tipo: $('[name=tipo]', f).value }));
      try { await api.put('/api/crm/etapas', { etapas: lista }); await etapas(true); toast('Etapas guardadas'); pintar(el); } catch (e) { toastError(e); }
    }),
  });
  pintar(el);
}

const v = k => st.cfg.valores[k];
const def = k => st.cfg.definiciones[k];
const dis = () => (st.editable ? '' : raw('disabled'));

function campo(k, { hint, tipo, placeholder, opts, span } = {}) {
  const d = def(k), val = v(k);
  const t = tipo || d.tipo;
  let input;
  if (t === 'bool') input = html`<label class="switch"><input type="checkbox" name="${k}" ${val === '1' ? raw('checked') : ''} ${dis()}><span class="track"></span> ${d.label}</label>`;
  else if (t === 'secret') input = html`<input class="input" type="password" name="${k}" autocomplete="new-password" placeholder="${val.configurado ? `Configurado (${val.valor}) — escribe para reemplazar` : 'No configurado'}" ${dis()}>`;
  else if (opts) input = html`<select class="select" name="${k}" ${dis()}>${opciones(opts, val)}</select>`;
  else input = html`<input class="input" name="${k}" value="${val}" ${t === 'int' ? raw(`type="number" min="${d.min ?? ''}" max="${d.max ?? ''}"`) : ''} placeholder="${placeholder || ''}" ${dis()}>`;
  if (t === 'bool') return html`<div class="field ${span ? 'span-2' : ''}">${input}${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
  return html`<label class="field ${span ? 'span-2' : ''}"><span>${d.label}${t === 'secret' && val.configurado ? html` <span class="badge success">${icon('check', 'sm')} guardado</span>` : ''}</span>${input}${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
}

const copia = (label, val) => html`<div class="field"><span class="label">${label}</span><div class="copy-box"><code>${val}</code><button type="button" class="btn btn-sm" data-act="copiar" data-v="${val}">${icon('copy', 'sm')}</button></div></div>`;
const seccion = (titulo, desc, cuerpo, { form = true, extra = '' } = {}) => html`<div class="card"><div class="card-head"><div><h3>${titulo}</h3>${desc ? html`<p class="small muted" style="margin-top:3px">${desc}</p>` : ''}</div>${extra}</div>
  <div class="card-body">${form ? html`<form class="form-grid" data-cfg>${cuerpo}${st.editable ? html`<div class="span-2 row"><button class="btn btn-primary right" type="submit">Guardar cambios</button></div>` : ''}</form>` : cuerpo}</div></div>`;

function filaEtapa(e) {
  return html`<div class="row" data-etapa data-clave="${e.clave || ''}" style="padding:8px 0;border-bottom:1px solid var(--border)">
    <input type="color" name="color" value="${e.color}" style="width:38px;height:34px;border:0;background:none;padding:0" aria-label="Color" ${dis()}>
    <input class="input sm grow" name="nombre" value="${e.nombre}" placeholder="Nombre de la etapa" ${dis()}>
    <select class="select sm" name="tipo" style="width:130px" ${dis()}>${opciones([['abierta', 'En curso'], ['ganada', 'Ganada'], ['perdida', 'Perdida']], e.tipo)}</select>
    <span class="xs muted nowrap" style="width:80px">${e.contactos !== undefined ? `${e.contactos} contactos` : 'nueva'}</span>
    ${st.editable ? html`<button class="btn btn-ghost btn-xs btn-icon" data-act="etapa-up" aria-label="Subir">↑</button><button class="btn btn-ghost btn-xs btn-icon" data-act="etapa-down" aria-label="Bajar">↓</button>
    <button class="btn btn-ghost btn-xs btn-icon" data-act="etapa-del" aria-label="Quitar" ${e.contactos ? raw('disabled title="Tiene contactos"') : ''}>${icon('trash', 'sm')}</button>` : ''}</div>`;
}

async function pintar(el) {
  $$('[data-tab]', el).forEach(a => { a.classList.toggle('active', a.dataset.tab === st.tab); a.style.color = a.dataset.tab === st.tab ? 'var(--primary)' : 'var(--text-2)'; a.style.background = a.dataset.tab === st.tab ? 'var(--primary-soft)' : ''; });
  const cont = $('[data-cont]', el);
  const ets = await etapas();
  let cuerpo;
  switch (st.tab) {
    case 'empresa': cuerpo = seccion('Datos de la empresa', 'Se usan en el panel y en los formatos de fecha y moneda.', html`
      ${campo('empresa_nombre')}${campo('empresa_moneda', { opts: [['PEN', 'Soles (PEN)'], ['USD', 'Dólares (USD)'], ['COP', 'Pesos colombianos (COP)'], ['MXN', 'Pesos mexicanos (MXN)'], ['CLP', 'Pesos chilenos (CLP)'], ['EUR', 'Euros (EUR)']] })}
      ${campo('empresa_zona_horaria', { opts: ZONAS.map(z => [z, z]) })}${campo('empresa_codigo_pais', { hint: 'Se antepone a números locales (ej. 51 para Perú).' })}`); break;

    case 'meta': cuerpo = html`${seccion('App de Meta', 'Datos de tu app en developers.facebook.com (tipo Empresa, con el producto WhatsApp y el inicio de sesión de Facebook para empresas). El número se conecta después en WhatsApp → Conexión.', html`
      ${campo('meta_app_id', { placeholder: 'ej. 1234567890123456', hint: 'Panel de la app → Configuración → Básica.' })}
      ${campo('meta_config_id', { placeholder: 'ej. 987654321098765', hint: 'Inicio de sesión de Facebook para empresas → Configuraciones (Embedded Signup de WhatsApp).' })}
      ${campo('meta_app_secret', { span: true, hint: 'Configuración → Básica → Clave secreta. Valida los avisos del webhook y el intercambio del código de Embedded Signup.' })}
      ${campo('meta_api_version', { hint: 'Ej. v25.0' })}
      ${campo('meta_public_url', { placeholder: 'https://crm.tu-dominio.com', hint: 'Dirección https con la que Meta llega a este CRM. Vacío = la del navegador.' })}
      ${campo('meta_alerta_mensual', { hint: 'Se muestra un aviso en Consumo al superar esta cantidad.' })}
      <div class="span-2" data-meta-res></div>`, { extra: st.editable ? html`<button class="btn" data-act="probar-meta">${icon('zap', 'sm')} Probar app</button>` : '' })}
      <div class="card mt"><div class="card-head"><div><h3>Webhook</h3><p class="small muted" style="margin-top:3px">En la app de Meta → WhatsApp → Configuración → Webhook, pega estos datos y suscríbete a <b>messages</b>, <b>message_template_status_update</b> y <b>template_category_update</b>.</p></div>
        ${st.editable ? html`<button class="btn btn-sm" data-act="regenerar-token">${icon('refresh', 'sm')} Regenerar token</button>` : ''}</div>
        <div class="card-body stack">${copia('URL de devolución de llamada', st.cfg.webhook_url)}${copia('Token de verificación', v('meta_verify_token'))}
        <div class="alert info small">${icon('info', 'sm')}<div>Meta exige <b>HTTPS</b> con dominio público. Agrega también ese dominio en "Dominios permitidos para el SDK de JavaScript" del inicio de sesión de Facebook.</div></div></div></div>`; break;

    case 'google': cuerpo = seccion('Google Places', 'Permite buscar negocios en Prospección.', html`
      ${campo('google_api_key', { span: true, hint: 'Google Cloud Console → APIs y servicios → Credenciales. Habilita "Places API". Restringe la clave por IP del servidor.' })}`,
      { extra: st.editable ? html`<button class="btn" data-act="probar-google">${icon('zap', 'sm')} Probar</button>` : '' }); break;

    case 'envios': cuerpo = seccion('Reglas de envío masivo', 'Protegen la reputación de tu número. Meta limita los mensajes según la calidad y el nivel de tu cuenta.', html`
      ${campo('envios_activo', { span: true, hint: 'Si lo desactivas, la cola se detiene hasta volver a activarlo.' })}
      ${campo('limite_diario', { hint: 'Máximo de mensajes de campaña por día.' })}${campo('delay_entre_mensajes', { hint: '8000 = 8 segundos entre mensajes.' })}
      ${campo('hora_inicio', { opts: Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, '0')}:00`]) })}
      ${campo('hora_fin', { opts: Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, '0')}:59`]) })}
      <div class="field span-2"><span class="label">Días permitidos</span><div class="row wrap">${DIAS.map((dn, i) => html`<label class="check"><input type="checkbox" data-dia="${i}" ${String(v('dias_envio')).split(',').includes(String(i)) ? raw('checked') : ''} ${dis()}> ${dn}</label>`)}</div></div>
      ${campo('envios_max_intentos', { hint: 'Reintentos ante errores temporales de Meta o de red.' })}`); break;

    case 'chat': cuerpo = html`${seccion('Bandeja de WhatsApp', null, html`
      ${campo('chat_crear_contacto', { span: true, hint: 'Si alguien que no está en el CRM te escribe, se crea como contacto con origen "WhatsApp".' })}
      ${campo('chat_etapa_respuesta', { span: true, opts: [['', 'No mover'], ...ets.map(e => [e.clave, e.nombre])], hint: 'Solo aplica a contactos que estén en la primera etapa del pipeline.' })}`)}
      <div class="mt">${seccion('Recordatorios de reuniones', 'Se envían 24 h y 1 h antes. Si la ventana de 24 h está cerrada se usa la plantilla del sistema "crm_recordatorio_reunion".', html`
      ${campo('recordatorios_activo', { span: true, hint: html`Envía la plantilla a revisión de Meta en <a href="#/whatsapp/recordatorios">WhatsApp → Recordatorios</a>.` })}`)}</div>`; break;

    case 'pipeline': cuerpo = html`<div class="card"><div class="card-head"><div><h3>Etapas del pipeline</h3><p class="small muted" style="margin-top:3px">Ordénalas según tu proceso de venta. Marca cuáles cuentan como ganadas o perdidas para los reportes.</p></div></div>
      <div class="card-body"><div data-etapas>${ets.map(filaEtapa)}</div>
      ${st.editable ? html`<div class="row mt"><button class="btn btn-sm" data-act="etapa-add">${icon('plus', 'sm')} Agregar etapa</button><button class="btn btn-primary right" data-act="guardar-etapas">Guardar etapas</button></div>` : ''}</div></div>`; break;

    case 'leads': cuerpo = html`${seccion('Formulario público de leads', 'Tu landing envía los datos con POST a esta URL (JSON con nombre, whatsapp, clinica, plan, ciclo, email, pais, mensaje).', html`
      <div class="span-2">${copia('URL del formulario', st.cfg.leads_url)}</div>
      ${campo('leads_origenes', { span: true, hint: 'Dominios desde los que se acepta el formulario, separados por coma (ej. https://mi-landing.com). * = cualquiera (no recomendado).' })}
      ${campo('leads_alerta_numero', { span: true, hint: html`Número que recibe un aviso por cada lead nuevo (opcional). Usa la plantilla del sistema "crm_alerta_lead" de <a href="#/whatsapp/recordatorios">WhatsApp → Recordatorios</a>.` })}`)}`; break;

    case 'proyectos': cuerpo = seccion('Proyectos de desarrollo', 'Rentabilidad y avisos automáticos a tus clientes.', html`
      ${campo('proyectos_costo_hora', { span: true, tipo: 'text', placeholder: 'Ej. 25', hint: 'Cuánto te cuesta una hora de trabajo del equipo (sueldo, herramientas…). Cada proyecto puede tener su propio costo.' })}
      ${campo('proyectos_wa_cobros', { span: true, hint: html`Envía la plantilla "crm_proyecto_cuota" 3 días antes de cada vencimiento. Envíala a revisión en <a href="#/whatsapp/recordatorios">WhatsApp → Recordatorios</a>.` })}
      ${campo('proyectos_wa_entrega', { span: true, hint: html`Envía la plantilla "crm_proyecto_entrega" al marcar el proyecto como entregado.` })}`); break;

    case 'seguridad': cuerpo = seccion('Políticas de seguridad', 'Aplican a todos los usuarios.', html`
      ${campo('seguridad_sesion_horas', { hint: 'Al vencer, el usuario debe volver a iniciar sesión.' })}${campo('seguridad_password_min')}
      ${campo('seguridad_intentos_max')}${campo('seguridad_bloqueo_min')}
      <div class="alert info span-2 small">${icon('shield', 'sm')}<div>Las contraseñas se guardan cifradas con bcrypt, los tokens de integraciones con AES-256 y cada acción sensible queda en <a href="#/auditoria">Auditoría</a>.</div></div>`); break;
  }
  dibujar(cont, cuerpo);

  const form = $('[data-cfg]', cont);
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = formData(form);
    for (const [k, val] of Object.entries(d)) if (typeof val === 'boolean') d[k] = val ? '1' : '0';
    const dias = $$('[data-dia]', form);
    if (dias.length) d.dias_envio = dias.filter(x => x.checked).map(x => x.dataset.dia).join(',');
    await conCarga(form.querySelector('[type=submit]'), async () => {
      try {
        await api.put('/api/config', { valores: d });
        st.cfg = await api.get('/api/config');
        toast('Configuración guardada'); pintar(el);
      } catch (ex) { toastError(ex); }
    });
  });
}
