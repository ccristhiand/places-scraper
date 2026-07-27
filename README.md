# Places CRM — Sistema completo de ventas con WhatsApp 🚀

## Módulos incluidos

| Módulo | Descripción |
|---|---|
| 🔍 **Buscar** | Búsqueda Google Places por departamento/provincia/distrito |
| 👥 **Contactos** | Base de datos con historial CRM y notas |
| 📝 **Campañas** | Plantillas de mensajes con imágenes y variables |
| 📤 **Envíos** | Envío masivo WhatsApp con cola y progreso en tiempo real |
| 💬 **Chat** | Historial de conversaciones por cliente |
| 📊 **CRM** | Embudo de ventas drag & drop |
| 📅 **Demos** | Agendamiento con recordatorios automáticos por WA |

---

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar entorno
cp .env.example .env
# Edita .env con tu API Key de Google y credenciales MySQL

# 3. Crear base de datos
npm run setup-db

# 4. Iniciar
npm start
```

Abre: **http://localhost:3000**

---

## Configuración .env

```env
GOOGLE_API_KEY=AIzaSy...
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=places_crm
PORT=3000
```

---

## WhatsApp

1. Haz clic en **"Conectar"** en la esquina inferior del menú lateral
2. Escanea el QR con tu WhatsApp → Dispositivos vinculados → Vincular dispositivo
3. La sesión se guarda en `.wa_auth/` — no necesitas escanear cada vez

**Recomendaciones:**
- Usa un número secundario dedicado para ventas
- El sistema usa delay de 10 segundos entre mensajes masivos para evitar bloqueos
- Los recordatorios de demos se envían automáticamente 24h y 1h antes

---

## Recordatorios automáticos

El scheduler revisa cada minuto si hay demos próximas y envía WA automáticamente:
- **24 horas antes**: mensaje con fecha completa y link
- **1 hora antes**: mensaje de recordatorio urgente

---

## Variables en campañas

En el diseñador de campañas puedes usar:
- `{{nombre}}` → Nombre del negocio
- `{{telefono}}` → Teléfono
- `{{distrito}}` → Distrito
- `{{provincia}}` → Provincia  
- `{{departamento}}` → Departamento

---

## Flujo recomendado

1. **Buscar** negocios por distrito → **Guardar** en BD
2. Diseñar **campaña** con mensaje + imagen
3. **Envío masivo** seleccionando contactos
4. Mover en **CRM** según respuesta
5. **Agendar demo** → recordatorio automático por WA
6. Ver **historial de chat** por cliente
