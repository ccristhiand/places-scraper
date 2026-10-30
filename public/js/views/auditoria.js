import { html, icon, api, render as dibujar, acciones, fmt, toastError, debounce, $, cargando, vacio } from '../core.js';
import { pager } from '../ui.js';

const LIM = 50;
let st;
const NOMBRES = {
  login: ['Inicio de sesión', 'success'], login_fallido: ['Login fallido', 'danger'], login_bloqueado: ['Login bloqueado', 'danger'], logout: ['Cierre de sesión', ''],
  cambio_password: ['Cambio de contraseña', 'info'], password_reseteada: ['Contraseña restablecida', 'warning'],
  usuario_creado: ['Usuario creado', 'info'], usuario_editado: ['Usuario editado', 'info'], usuario_eliminado: ['Usuario eliminado', 'danger'],
  rol_creado: ['Rol creado', 'info'], rol_editado: ['Rol editado', 'info'], rol_eliminado: ['Rol eliminado', 'danger'],
  config_editada: ['Configuración', 'warning'], envio_masivo: ['Envío masivo', 'primary'], contacto_eliminado: ['Contacto eliminado', 'danger'],
  contactos_exportados: ['Exportación CSV', 'warning'], contactos_importados: ['Importación', 'info'],
  proyecto_creado: ['Proyecto creado', 'info'], proyecto_estado: ['Estado de proyecto', 'primary'], proyecto_pago: ['Cobro registrado', 'success'],
  proyecto_pago_eliminado: ['Cobro anulado', 'danger'], proyecto_eliminado: ['Proyecto eliminado', 'danger'],
};

export async function render(el) {
  st = { accion: '', offset: 0 };
  dibujar(el, html`
    <div class="page-head"><div><h1>Auditoría</h1><p>Registro de accesos y acciones sensibles.</p></div></div>
    <div class="toolbar"><div class="search">${icon('search', 'sm')}<input class="input" data-q placeholder="Filtrar por acción (ej. login, config, eliminado)…"></div></div>
    <div class="card"><div class="table-wrap" data-tabla>${cargando()}</div><div data-pager></div></div>`);
  $('[data-q]', el).addEventListener('input', debounce(e => { st.accion = e.target.value; st.offset = 0; cargar(el); }, 300));
  acciones(el, { prev: () => { st.offset = Math.max(0, st.offset - LIM); cargar(el); }, next: () => { st.offset += LIM; cargar(el); } });
  await cargar(el);
}

async function cargar(el) {
  try {
    const r = await api.get('/api/config/auditoria', { accion: st.accion, limit: LIM, offset: st.offset });
    dibujar($('[data-tabla]', el), r.rows.length ? html`<table class="table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead><tbody>
      ${r.rows.map(a => { const [n, tone] = NOMBRES[a.accion] || [a.accion.replace(/_/g, ' '), ''];
        return html`<tr><td class="small nowrap">${fmt.fechaHora(a.created_at)}</td><td class="small">${a.usuario_email || '—'}</td>
          <td><span class="badge ${tone}">${n}</span></td>
          <td class="xs muted" style="max-width:420px;word-break:break-word">${a.entidad ? `${a.entidad} #${a.entidad_id} ` : ''}${a.detalle || ''}</td>
          <td class="xs mono muted">${a.ip || ''}</td></tr>`; })}</tbody></table>` : vacio({ icono: 'file', titulo: 'Sin registros' }));
    dibujar($('[data-pager]', el), r.total > LIM ? pager(r.total, st.offset, LIM) : '');
  } catch (e) { toastError(e); }
}
