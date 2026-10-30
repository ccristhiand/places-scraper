# CRM Comercial — Prospección, WhatsApp y ventas

CRM web para equipos comerciales: prospecta negocios con Google Places, conversa y lanza campañas con la **API oficial de WhatsApp (Meta Cloud API)** y gestiona el embudo de ventas con tareas, agenda y reportes.

## Módulos

| Módulo | Qué hace |
|---|---|
| **Panel** | KPIs, embudo, mensajes de 14 días, mis tareas, próximas reuniones y actividad reciente |
| **Bandeja** | Conversaciones de WhatsApp en tiempo real, ventana de 24 h, plantillas, imágenes y respuestas rápidas (`/`) |
| **Contactos** | Búsqueda y filtros avanzados, ficha con historial, etiquetas, asignación, acciones masivas y exportación CSV |
| **Pipeline** | Kanban con etapas configurables, valor estimado y motivo de pérdida |
| **Agenda** | Calendario mensual de reuniones con recordatorios automáticos por WhatsApp (24 h y 1 h antes) |
| **Tareas** | Seguimientos con prioridad, vencimiento y aviso antes de vencer |
| **Prospección** | Búsqueda en Google Places por departamento/provincia/distrito e importación al CRM |
| **Leads web** | Formulario público de la landing; conversión a contacto en un clic |
| **Campañas** | Plantillas aprobadas por Meta con variables mapeadas a datos del contacto, o texto libre (ventana 24 h) |
| **Envíos** | Cola única con horario, días, límite diario, reintentos y reanudación automática; estados entregado/leído |
| **Reportes** | Entrega y lectura de campañas, respuestas, conversión, rubros, distritos y rendimiento por vendedor |
| **Usuarios y roles** | Usuarios, roles con 30 permisos granulares, contraseñas temporales y bloqueo de cuentas |
| **Configuración** | Empresa, Meta, Google, envíos, bandeja, recordatorios, etapas, leads y políticas de seguridad |
| **Auditoría** | Registro de accesos y acciones sensibles |

## Instalación

```bash
npm install
cp .env.example .env   # completa la conexión MySQL y el administrador inicial
npm start
```

Al arrancar, el servidor aplica automáticamente las migraciones de la base de datos (solo **agregan** tablas, columnas e índices; no borran datos). También puedes ejecutarlas por separado con `npm run setup-db`.

Abre `http://localhost:3010` e ingresa con `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Se pedirá cambiar la contraseña en el primer ingreso.

En producción (PM2): `pm2 start ecosystem.config.js`, detrás de nginx con HTTPS y `COOKIE_SECURE=1`.

## Conectar WhatsApp (Meta Cloud API)

1. En [developers.facebook.com](https://developers.facebook.com) crea una app de tipo *Empresa* y agrega el producto **WhatsApp**.
2. Registra tu número y anota el **Phone Number ID** y el **WhatsApp Business Account ID**.
3. Crea un **usuario del sistema** en el Business Manager y genera un **token permanente** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
4. Copia la **clave secreta de la app** (Configuración → Básica).
5. En el CRM: **Configuración → WhatsApp (Meta)**, pega los datos y pulsa **Probar conexión**.
6. En Meta → WhatsApp → Configuración → **Webhook**, pega la URL y el token de verificación que muestra el CRM y suscríbete al campo `messages`. Meta exige HTTPS público.
7. Crea tus **plantillas** en el Administrador de WhatsApp; cuando estén aprobadas aparecerán en Campañas y en la Bandeja.

> WhatsApp solo permite mensajes libres hasta 24 h después del último mensaje del cliente. Fuera de esa ventana se usan plantillas aprobadas. El CRM lo controla automáticamente.

## Seguridad

- Contraseñas con **bcrypt**; sesión en cookie `httpOnly` + `SameSite=Strict` (y `Secure` con HTTPS).
- Cambio de contraseña obligatorio en el primer ingreso y tras un restablecimiento; política de largo mínimo configurable.
- Bloqueo temporal tras intentos fallidos y límite de peticiones en el login, la API y el formulario público.
- Roles y permisos verificados en el servidor; los vendedores solo ven sus contactos asignados.
- Protección CSRF (cabecera propia + SameSite), cabeceras de seguridad con Helmet y CSP estricta.
- Tokens de Meta y Google **cifrados con AES-256-GCM** en la base de datos (clave `APP_KEY`).
- Webhook validado con la firma HMAC `X-Hub-Signature-256` de Meta.
- Archivos subidos solo imágenes, con nombre aleatorio y servidos únicamente con sesión.
- Auditoría de inicios de sesión, cambios de usuarios/roles/configuración, exportaciones y envíos masivos.

## Formulario de leads

La landing envía `POST /api/leads` con JSON: `nombre`, `whatsapp`, `clinica` (o `empresa`), `plan`, y opcionalmente `ciclo`, `email`, `pais`, `mensaje`. Configura los dominios permitidos en **Configuración → Formulario de leads**.

## Variables en campañas

`{{nombre}}` negocio · `{{contacto}}` persona · `{{telefono}}` · `{{distrito}}` · `{{provincia}}` · `{{departamento}}` · `{{rubro}}` · `{{responsable}}` vendedor asignado.
