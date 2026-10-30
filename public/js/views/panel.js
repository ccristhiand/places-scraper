import { html, raw, icon, api, render as dibujar, acciones, fmt, session, can, vacio, toastError, bus } from '../core.js';
import { barras, serieDias, formTarea, formReunion } from '../ui.js';
import { abrirContacto } from '../contacto.js';
import { dinero, fechaCorta } from '../proyecto.js';

let subs = [];
export function destroy() { subs.forEach(f => f()); subs = []; }

const kpi = (ic, tone, label, valor, sub, href) => html`<a class="card kpi" href="${href || '#'}" style="color:inherit;text-decoration:none">
  <div class="kpi-icon ${tone}">${icon(ic)}</div><div class="grow"><div class="kpi-label">${label}</div><div class="kpi-value">${valor}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div></a>`;

const hoy = () => { const s = fmt.dia(new Date()); return s.charAt(0).toUpperCase() + s.slice(1); };

export async function render_(el) {
  const [d, pr] = await Promise.all([
    api.get('/api/dashboard'),
    can('proyectos.ver') ? api.get('/api/proyectos').then(r => ({
      resumen: r.resumen,
      proximas: r.rows.filter(p => ['aprobado', 'desarrollo', 'pruebas'].includes(p.estado) && p.fecha_entrega_estimada)
        .sort((a, b) => a.fecha_entrega_estimada.localeCompare(b.fecha_entrega_estimada)).slice(0, 3),
    })).catch(() => null) : null,
  ]);
  const k = d.kpi;
  const maxEmbudo = Math.max(1, ...d.embudo.map(e => e.total));
  const pendientesHoy = Number(d.tareas_resumen?.vencidas || 0) + Number(d.tareas_resumen?.hoy || 0);

  dibujar(el, html`
    <div class="page-head"><div><h1>Resumen</h1>
      <p>${hoy()}${pendientesHoy ? ` · ${pendientesHoy} tarea(s) para hoy o vencidas` : ''}</p></div>
      <div class="actions">
        ${can('tareas.gestionar') ? html`<button class="btn" data-act="tarea">${icon('checkSquare', 'sm')} Nueva tarea</button>` : ''}
        ${can('agenda.gestionar') ? html`<button class="btn btn-primary" data-act="reunion">${icon('calendar', 'sm')} Agendar reunión</button>` : ''}
      </div></div>

    ${!session.meta && can('config.ver') ? html`<div class="alert warning mb">${icon('alert')}<div><b>WhatsApp no está configurado.</b> Conecta tu cuenta de WhatsApp Business (Meta) para enviar y recibir mensajes. <a href="#/whatsapp/conexion">Conectar WhatsApp</a></div></div>` : ''}

    <div class="grid c4 mb">
      ${kpi('users', 'tone-primary', 'Contactos', fmt.num(k.contactos), `+${fmt.num(k.nuevos_7d)} en los últimos 7 días`, '#/contactos')}
      ${kpi('target', 'tone-warning', 'Oportunidades abiertas', fmt.num(k.abiertos), `${fmt.moneda(k.valor_abierto)} en juego`, '#/pipeline')}
      ${kpi('trophy', 'tone-success', 'Ganados', fmt.num(k.ganados), fmt.moneda(k.valor_ganado), '#/pipeline')}
      ${kpi('chat', 'tone-info', 'Mensajes sin leer', fmt.num(d.mensajes?.sin_leer), `${fmt.num(d.mensajes?.recibidos_7d)} recibidos en 7 días`, '#/bandeja')}
    </div>

    <div class="grid side">
      <div class="stack">
        <div class="card"><div class="card-head"><h3>${icon('kanban', 'sm')} Embudo de ventas</h3><a class="small" href="#/pipeline">Ver pipeline</a></div>
          <div class="card-body">${d.embudo.map(e => html`<div class="funnel-row">
            <div style="width:120px" class="small truncate row"><span class="dot" style="background:${raw(e.color)}"></span>${e.nombre}</div>
            <div class="grow"><div class="funnel-bar" style="width:${raw(Math.max(6, (e.total / maxEmbudo) * 100))}%;background:${raw(e.tipo === 'ganada' ? 'var(--success)' : e.tipo === 'perdida' ? 'var(--danger)' : 'var(--primary)')}">${fmt.num(e.total)}</div></div>
            <div class="small muted nowrap" style="width:90px;text-align:right">${Number(e.valor) ? fmt.moneda(e.valor) : ''}</div></div>`)}</div></div>

        <div class="card"><div class="card-head"><h3>${icon('activity', 'sm')} Mensajes de WhatsApp · 14 días</h3></div>
          <div class="card-body">${barras(serieDias(d.serie, 14, ['enviados', 'recibidos']), [
            { clave: 'enviados', nombre: 'Enviados', color: '#2459c6' }, { clave: 'recibidos', nombre: 'Recibidos', color: '#a1a1aa' }])}</div></div>

        <div class="card"><div class="card-head"><h3>${icon('activity', 'sm')} Actividad reciente</h3></div>
          <div class="card-body flush">${d.actividad.length ? d.actividad.map(a => html`<a class="list-item" href="#" data-act="contacto" data-id="${a.negocio_id}">
            <div class="grow"><div class="small"><b>${a.nombre}</b> <span class="muted">· ${a.usuario || 'Sistema'}</span></div>
            <div class="small muted truncate">${a.contenido}</div></div><span class="xs muted nowrap">${fmt.relativo(a.created_at)}</span></a>`)
            : vacio({ icono: 'activity', titulo: 'Sin actividad aún' })}</div></div>
      </div>

      <div class="stack">
        ${d.envios ? html`<div class="card"><div class="card-body">
          <div class="row between"><b>${icon('send', 'sm')} Envíos de hoy</b><a class="small" href="#/envios">Gestionar</a></div>
          <div class="row between mt"><span class="kpi-value">${fmt.num(d.envios.hoy)}</span><span class="muted">de ${fmt.num(d.envios.limite)}</span></div>
          <div class="progress" style="margin-top:8px"><div style="width:${raw(Math.min(100, (d.envios.hoy / Math.max(1, d.envios.limite)) * 100))}%"></div></div>
          <div class="xs muted" style="margin-top:8px">${d.envios.cola.corriendo ? '● Enviando campaña…' : d.envios.cola.mensaje || 'Sin envíos en curso'}</div>
        </div></div>` : ''}

        <div class="card"><div class="card-head"><h3>${icon('checkSquare', 'sm')} Mis tareas</h3><a class="small" href="#/tareas">Ver todas</a></div>
          <div class="card-body flush">${d.tareas.length ? d.tareas.map(t => {
            const vencida = t.vence_at && new Date(t.vence_at) < new Date();
            return html`<div class="list-item"><span class="dot ${vencida ? 'bad' : t.prioridad === 'alta' ? 'warn' : ''}" style="margin-top:7px"></span>
              <div class="grow"><div class="small strong">${t.titulo}</div><div class="xs ${vencida ? '' : 'muted'}" style="${vencida ? 'color:var(--danger)' : ''}">${t.vence_at ? (vencida ? 'Vencida · ' : '') + fmt.fechaHora(t.vence_at) : 'Sin fecha'}${t.negocio_nombre ? ` · ${t.negocio_nombre}` : ''}</div></div></div>`;
          }) : vacio({ icono: 'checkSquare', titulo: '¡Todo al día!', texto: 'No tienes tareas pendientes.' })}</div></div>

        <div class="card"><div class="card-head"><h3>${icon('calendar', 'sm')} Próximas reuniones</h3><a class="small" href="#/agenda">Agenda</a></div>
          <div class="card-body flush">${d.reuniones.length ? d.reuniones.map(r => html`<a class="list-item" href="#" data-act="contacto" data-id="${r.negocio_id}">
            <div class="center" style="width:44px;flex-shrink:0"><div class="xs muted">${new Date(r.fecha_hora).toLocaleDateString('es-PE', { month: 'short', timeZone: 'America/Lima' })}</div>
            <div style="font-size:20px;font-weight:700;line-height:1">${new Date(r.fecha_hora).toLocaleDateString('es-PE', { day: 'numeric', timeZone: 'America/Lima' })}</div></div>
            <div class="grow"><div class="small strong truncate">${r.nombre}</div><div class="xs muted">${fmt.hora(r.fecha_hora)} · ${r.titulo}</div></div></a>`)
            : vacio({ icono: 'calendar', titulo: 'Sin reuniones próximas' })}</div></div>

        ${pr ? html`<div class="card"><div class="card-head"><h3>${icon('layers', 'sm')} Proyectos</h3><a class="small" href="#/proyectos">Ver todos</a></div>
          <div class="card-body" style="padding-bottom:6px">
            <div class="row between small"><span class="muted">En curso</span><b>${pr.resumen.activos}</b></div>
            ${pr.resumen.por_cobrar ? html`<div class="row between small" style="margin-top:6px"><span class="muted">Por cobrar</span>
              <b style="${pr.resumen.cuotas_vencidas ? 'color:var(--warning)' : ''}">${Object.entries(pr.resumen.por_cobrar).map(([m, v]) => dinero(v, m)).join(' + ') || dinero(0)}</b></div>` : ''}
            ${pr.resumen.atrasados ? html`<div class="row between small" style="margin-top:6px"><span class="muted">Atrasados</span><b style="color:var(--danger)">${pr.resumen.atrasados}</b></div>` : ''}
          </div>
          ${pr.proximas.map(p => html`<a class="list-item" href="#/proyectos/${p.id}"><div class="grow"><div class="small strong truncate">${p.nombre}</div>
            <div class="xs ${p.atrasado ? '' : 'muted'}" style="${p.atrasado ? 'color:var(--danger)' : ''}">${p.cliente} · entrega ${fechaCorta(p.fecha_entrega_estimada)}</div></div></a>`)}
        </div>` : ''}

        ${d.leads ? html`<a class="card kpi" href="#/leads" style="color:inherit;text-decoration:none"><div class="kpi-icon tone-warning">${icon('inbox')}</div>
          <div><div class="kpi-label">Leads web nuevos</div><div class="kpi-value">${fmt.num(d.leads.nuevos)}</div><div class="kpi-sub">${fmt.num(d.leads.total)} en total</div></div></a>` : ''}
      </div>
    </div>`);
}

export async function render(el) {
  try { await render_(el); } catch (e) { toastError(e); }
  acciones(el, {
    contacto: a => abrirContacto(a.dataset.id, { onCambio: () => render_(el) }),
    tarea: async () => { if (await formTarea()) render_(el); },
    reunion: async () => { if (await formReunion()) render_(el); },
  });
  subs.push(bus.on('lead:nuevo', () => render_(el).catch(() => {})));
}
