require('dotenv').config();
require('./lib/env').ensureSecrets();
const mysql = require('mysql2/promise');

// Migraciones idempotentes y NO destructivas: solo crean tablas/columnas/índices
// y amplían tipos (ENUM → VARCHAR) conservando los datos existentes.
async function migrar({ log = console.log } = {}) {
  const dbName = process.env.DB_NAME || 'places_crm';
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: false,
  });

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${dbName}\``);

  const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

  async function columna(tabla, col) {
    const [r] = await conn.query(
      'SELECT DATA_TYPE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?',
      [dbName, tabla, col]);
    return r[0] || null;
  }
  async function addCol(tabla, col, def) {
    if (!(await columna(tabla, col))) { await conn.query(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${col}\` ${def}`); log(`  + ${tabla}.${col}`); }
  }
  async function enumAVarchar(tabla, col, def) {
    const c = await columna(tabla, col);
    if (c && c.DATA_TYPE === 'enum') { await conn.query(`ALTER TABLE \`${tabla}\` MODIFY \`${col}\` ${def}`); log(`  ~ ${tabla}.${col} → VARCHAR`); }
  }
  async function addIdx(tabla, nombre, cols) {
    const [r] = await conn.query(
      'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1',
      [dbName, tabla, nombre]);
    if (!r.length) { await conn.query(`ALTER TABLE \`${tabla}\` ADD INDEX \`${nombre}\` (${cols})`); log(`  + índice ${tabla}.${nombre}`); }
  }

  // ── Seguridad ───────────────────────────────────────────────────────────
  await conn.query(`CREATE TABLE IF NOT EXISTS roles (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    nombre      VARCHAR(80) NOT NULL UNIQUE,
    descripcion VARCHAR(255),
    permisos    TEXT NOT NULL,
    es_sistema  TINYINT(1) DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS usuarios (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    nombre                VARCHAR(150) NOT NULL,
    email                 VARCHAR(190) NOT NULL UNIQUE,
    telefono              VARCHAR(30),
    password_hash         VARCHAR(100) NOT NULL,
    rol_id                INT NOT NULL,
    activo                TINYINT(1) DEFAULT 1,
    debe_cambiar_password TINYINT(1) DEFAULT 1,
    token_version         INT DEFAULT 0,
    intentos_fallidos     INT DEFAULT 0,
    bloqueado_hasta       DATETIME NULL,
    ultimo_acceso         DATETIME NULL,
    password_cambiado_at  DATETIME NULL,
    tema                  VARCHAR(10) DEFAULT 'auto',
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rol_id) REFERENCES roles(id)
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS auditoria (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario_id    INT NULL,
    usuario_email VARCHAR(190),
    accion        VARCHAR(80) NOT NULL,
    entidad       VARCHAR(50),
    entidad_id    VARCHAR(50),
    detalle       TEXT,
    ip            VARCHAR(64),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_aud_fecha (created_at),
    INDEX idx_aud_usuario (usuario_id)
  ) ${T}`);

  // ── CRM base (tablas existentes) ────────────────────────────────────────
  await conn.query(`CREATE TABLE IF NOT EXISTS negocios (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    place_id       VARCHAR(255) UNIQUE NOT NULL,
    nombre         VARCHAR(500),
    telefono       VARCHAR(100),
    telefono_int   VARCHAR(100),
    whatsapp       VARCHAR(50),
    wa_jid         VARCHAR(50),
    wa_verificado  TINYINT(1) DEFAULT NULL,
    website        VARCHAR(500),
    direccion      TEXT,
    rating         DECIMAL(3,1),
    resenas        INT DEFAULT 0,
    estado         VARCHAR(100),
    horarios       TEXT,
    categorias     VARCHAR(500),
    descripcion    TEXT,
    maps_url       TEXT,
    lat            DECIMAL(10,7),
    lng            DECIMAL(10,7),
    departamento   VARCHAR(100),
    provincia      VARCHAR(100),
    distrito       VARCHAR(100),
    rubro_busqueda VARCHAR(200),
    estado_crm     VARCHAR(40) DEFAULT 'nuevo',
    responsable    VARCHAR(200),
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_estado_crm (estado_crm),
    INDEX idx_departamento (departamento)
  ) ${T}`);
  await enumAVarchar('negocios', 'estado_crm', "VARCHAR(40) DEFAULT 'nuevo'");
  await addCol('negocios', 'email',              'VARCHAR(190) NULL');
  await addCol('negocios', 'contacto_nombre',    'VARCHAR(200) NULL');
  await addCol('negocios', 'valor_estimado',     'DECIMAL(12,2) NULL');
  await addCol('negocios', 'asignado_a',         'INT NULL');
  await addCol('negocios', 'etiquetas',          'VARCHAR(500) NULL');
  await addCol('negocios', 'origen',             "VARCHAR(30) DEFAULT 'google'");
  await addCol('negocios', 'ultimo_entrante_at', 'DATETIME NULL');
  await addCol('negocios', 'ultima_actividad_at','DATETIME NULL');
  await addIdx('negocios', 'idx_asignado', 'asignado_a');
  await addIdx('negocios', 'idx_ventana', 'ultimo_entrante_at');
  await addIdx('negocios', 'idx_whatsapp', 'whatsapp');
  await addIdx('negocios', 'idx_created', 'created_at');

  await conn.query(`CREATE TABLE IF NOT EXISTS etapas (
    id     INT AUTO_INCREMENT PRIMARY KEY,
    clave  VARCHAR(40) NOT NULL UNIQUE,
    nombre VARCHAR(80) NOT NULL,
    color  VARCHAR(20) DEFAULT '#64748b',
    tipo   VARCHAR(10) DEFAULT 'abierta',
    orden  INT DEFAULT 0
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS crm_historial (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    negocio_id      INT NOT NULL,
    tipo            VARCHAR(30) DEFAULT 'comentario',
    estado_anterior VARCHAR(50),
    estado_nuevo    VARCHAR(50),
    contenido       TEXT,
    usuario         VARCHAR(200),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
  ) ${T}`);
  await enumAVarchar('crm_historial', 'tipo', "VARCHAR(30) DEFAULT 'comentario'");
  await addCol('crm_historial', 'usuario_id', 'INT NULL');
  await addIdx('crm_historial', 'idx_hist_neg', 'negocio_id, created_at');

  await conn.query(`CREATE TABLE IF NOT EXISTS campanas (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    nombre     VARCHAR(300) NOT NULL,
    mensaje    TEXT NOT NULL,
    imagen_url VARCHAR(500),
    variables  JSON,
    activa     TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ${T}`);
  await addCol('campanas', 'tipo',            "VARCHAR(20) DEFAULT 'plantilla'");
  await addCol('campanas', 'template_nombre', 'VARCHAR(200) NULL');
  await addCol('campanas', 'template_idioma', "VARCHAR(20) DEFAULT 'es'");
  await addCol('campanas', 'template_params', 'TEXT NULL');
  await addCol('campanas', 'template_header', 'VARCHAR(20) NULL');
  await addCol('campanas', 'creado_por',      'INT NULL');
  // Campañas anteriores a Meta (Baileys) eran de texto libre: no tienen plantilla
  await conn.query("UPDATE campanas SET tipo = 'texto' WHERE tipo = 'plantilla' AND (template_nombre IS NULL OR template_nombre = '')");
  // Ciclo de vida de campañas por Meta: borrador → programada → enviando ⇄ pausada → completada | cancelada
  const teniaEstado = await columna('campanas', 'estado');
  await addCol('campanas', 'estado',            "VARCHAR(20) DEFAULT 'borrador'");
  await addCol('campanas', 'programada_at',     'DATETIME NULL');
  await addCol('campanas', 'iniciada_at',       'DATETIME NULL');
  await addCol('campanas', 'pausada_at',        'DATETIME NULL');
  await addCol('campanas', 'completada_at',     'DATETIME NULL');
  await addCol('campanas', 'total',             'INT DEFAULT 0');
  await addCol('campanas', 'enviados',          'INT DEFAULT 0');
  await addCol('campanas', 'fallidos',          'INT DEFAULT 0');
  await addCol('campanas', 'filtros',           'TEXT NULL');
  await addCol('campanas', 'etapa_destino',     'VARCHAR(50) NULL');
  await addCol('campanas', 'meta_plantilla_id', 'INT NULL');
  await addCol('campanas', 'meta_variables',    'TEXT NULL');
  await addCol('campanas', 'contactos_cargados','TINYINT(1) DEFAULT 0');
  await addCol('campanas', 'ultimo_error',      'VARCHAR(500) NULL');
  if (!teniaEstado) {
    // Las campañas existentes ya se enviaron con el modelo anterior: quedan como historial
    await conn.query("UPDATE campanas SET estado = 'completada', contactos_cargados = 1 WHERE estado = 'borrador'");
    log('  ~ campañas anteriores marcadas como completadas');
  }

  await conn.query(`CREATE TABLE IF NOT EXISTS envios (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    campana_id     INT,
    negocio_id     INT NOT NULL,
    numero         VARCHAR(50),
    mensaje_final  TEXT,
    estado         VARCHAR(20) DEFAULT 'pendiente',
    estado_destino VARCHAR(50),
    enviado_at     TIMESTAMP NULL,
    error_msg      VARCHAR(500),
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campana_id) REFERENCES campanas(id) ON DELETE SET NULL,
    FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
  ) ${T}`);
  await enumAVarchar('envios', 'estado', "VARCHAR(20) DEFAULT 'pendiente'");
  await addCol('envios', 'estado_destino', 'VARCHAR(50) NULL');
  await addCol('envios', 'wa_message_id',  'VARCHAR(200) NULL');
  await addCol('envios', 'intentos',       'INT DEFAULT 0');
  await addCol('envios', 'entregado_at',   'DATETIME NULL');
  await addCol('envios', 'leido_at',       'DATETIME NULL');
  await addCol('envios', 'creado_por',     'INT NULL');
  await addIdx('envios', 'idx_env_estado', 'estado, id');
  await addIdx('envios', 'idx_env_camp',   'campana_id, negocio_id');
  await addIdx('envios', 'idx_env_wamid',  'wa_message_id');
  await addCol('envios', 'reserva',        'VARCHAR(36) NULL');
  await addCol('envios', 'reservado_at',   'DATETIME NULL');
  await addIdx('envios', 'idx_env_campest', 'campana_id, estado, id');

  // ── WhatsApp Cloud API (Meta) ───────────────────────────────────────────
  // Cuenta conectada (una sola: este CRM es de una empresa)
  await conn.query(`CREATE TABLE IF NOT EXISTS wa_cuenta (
    id                INT PRIMARY KEY,
    estado            VARCHAR(20) DEFAULT 'desconectado',
    modo              VARCHAR(20) DEFAULT 'embedded',
    business_id       VARCHAR(40) NULL,
    waba_id           VARCHAR(40) NULL,
    phone_number_id   VARCHAR(40) NULL,
    numero_display    VARCHAR(40) NULL,
    nombre_verificado VARCHAR(200) NULL,
    access_token      TEXT NULL,
    coexistencia      TINYINT(1) DEFAULT 0,
    historial_sync    VARCHAR(20) DEFAULT 'no_aplica',
    calidad           VARCHAR(20) NULL,
    webhook_ok        TINYINT(1) DEFAULT 0,
    conectado_at      DATETIME NULL,
    ultimo_error      TEXT NULL,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ${T}`);

  // Plantillas de mensajes (copia local del estado en Meta)
  await conn.query(`CREATE TABLE IF NOT EXISTS wa_plantillas (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    nombre_meta      VARCHAR(512) NOT NULL,
    idioma           VARCHAR(20) NOT NULL DEFAULT 'es',
    categoria        VARCHAR(20) DEFAULT 'MARKETING',
    uso              VARCHAR(40) DEFAULT 'manual',
    encabezado_tipo  VARCHAR(20) DEFAULT 'ninguno',
    encabezado_texto VARCHAR(60) NULL,
    cuerpo           TEXT NULL,
    variables        TEXT NULL,
    pie              VARCHAR(60) NULL,
    meta_template_id VARCHAR(40) NULL,
    estado           VARCHAR(20) DEFAULT 'pendiente',
    motivo_rechazo   VARCHAR(255) NULL,
    es_sistema       TINYINT(1) DEFAULT 0,
    activo           TINYINT(1) DEFAULT 1,
    creado_por       INT NULL,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_plantilla (nombre_meta(191), idioma),
    INDEX idx_pl_tid (meta_template_id)
  ) ${T}`);

  // Cada aviso de Meta se guarda antes de procesarse (auditoría y reintentos)
  await conn.query(`CREATE TABLE IF NOT EXISTS wa_webhook_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    recibido_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    waba_id         VARCHAR(40) NULL,
    phone_number_id VARCHAR(40) NULL,
    campo           VARCHAR(60) NULL,
    payload         MEDIUMTEXT NOT NULL,
    procesado       TINYINT(1) NOT NULL DEFAULT 0,
    error           TEXT NULL,
    INDEX idx_wl_fecha (recibido_at),
    INDEX idx_wl_procesado (procesado, recibido_at)
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS chat_mensajes (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    negocio_id INT,
    numero     VARCHAR(50),
    direccion  ENUM('saliente','entrante') NOT NULL,
    tipo       VARCHAR(20) DEFAULT 'texto',
    contenido  TEXT,
    media_url  VARCHAR(500),
    wa_id      VARCHAR(200),
    leido      TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE,
    INDEX idx_numero (numero),
    INDEX idx_wa_id (wa_id)
  ) ${T}`);
  await enumAVarchar('chat_mensajes', 'tipo', "VARCHAR(20) DEFAULT 'texto'");
  await addCol('chat_mensajes', 'estado_entrega', 'VARCHAR(20) NULL');
  await addCol('chat_mensajes', 'error_msg',      'VARCHAR(500) NULL');
  await addCol('chat_mensajes', 'usuario_id',     'INT NULL');
  await addCol('chat_mensajes', 'origen',         "VARCHAR(20) NULL");
  await addIdx('chat_mensajes', 'idx_chat_neg', 'negocio_id, created_at');

  await conn.query(`CREATE TABLE IF NOT EXISTS demos (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    negocio_id       INT NOT NULL,
    titulo           VARCHAR(300),
    fecha_hora       DATETIME NOT NULL,
    duracion_min     INT DEFAULT 60,
    tipo             VARCHAR(20) DEFAULT 'virtual',
    enlace           VARCHAR(500),
    notas            TEXT,
    estado           VARCHAR(20) DEFAULT 'agendada',
    recordatorio_24h TINYINT(1) DEFAULT 0,
    recordatorio_1h  TINYINT(1) DEFAULT 0,
    responsable      VARCHAR(200),
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
  ) ${T}`);
  await enumAVarchar('demos', 'tipo',   "VARCHAR(20) DEFAULT 'virtual'");
  await enumAVarchar('demos', 'estado', "VARCHAR(20) DEFAULT 'agendada'");
  await addCol('demos', 'asignado_a', 'INT NULL');
  await addIdx('demos', 'idx_demo_fecha', 'fecha_hora');

  await conn.query(`CREATE TABLE IF NOT EXISTS tareas (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    titulo        VARCHAR(255) NOT NULL,
    descripcion   TEXT,
    negocio_id    INT NULL,
    asignado_a    INT NULL,
    creado_por    INT NULL,
    vence_at      DATETIME NULL,
    prioridad     VARCHAR(10) DEFAULT 'media',
    estado        VARCHAR(15) DEFAULT 'pendiente',
    completada_at DATETIME NULL,
    notificada    TINYINT(1) DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE,
    INDEX idx_tarea_asig (asignado_a, estado, vence_at)
  ) ${T}`);

  // ── Proyectos de desarrollo (por cliente) ──────────────────────────────
  await conn.query(`CREATE TABLE IF NOT EXISTS proyectos (
    id                     INT AUTO_INCREMENT PRIMARY KEY,
    codigo                 VARCHAR(20) NOT NULL UNIQUE,
    negocio_id             INT NOT NULL,
    nombre                 VARCHAR(200) NOT NULL,
    tipo                   VARCHAR(30) DEFAULT 'web',
    alcance                TEXT NULL,
    estado                 VARCHAR(20) DEFAULT 'propuesta',
    responsable_id         INT NULL,
    moneda                 VARCHAR(3) DEFAULT 'PEN',
    monto                  DECIMAL(12,2) DEFAULT 0,
    incluye_igv            TINYINT(1) DEFAULT 1,
    fecha_inicio           DATE NULL,
    duracion_dias          INT NULL,
    fecha_entrega_estimada DATE NULL,
    fecha_entrega_real     DATE NULL,
    dias_soporte           INT DEFAULT 30,
    fecha_fin_soporte      DATE NULL,
    url_repo               VARCHAR(500) NULL,
    url_demo               VARCHAR(500) NULL,
    url_produccion         VARCHAR(500) NULL,
    notas                  TEXT NULL,
    aviso_entrega          TINYINT(1) DEFAULT 0,
    aviso_soporte          TINYINT(1) DEFAULT 0,
    creado_por             INT NULL,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE,
    INDEX idx_proy_estado (estado),
    INDEX idx_proy_neg (negocio_id)
  ) ${T}`);

  // Plan de pagos (cuotas acordadas)
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_cuotas (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id   INT NOT NULL,
    orden         INT DEFAULT 0,
    concepto      VARCHAR(150) NOT NULL,
    monto         DECIMAL(12,2) NOT NULL,
    vence_at      DATE NULL,
    aviso_previo  TINYINT(1) DEFAULT 0,
    aviso_vencida TINYINT(1) DEFAULT 0,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
  ) ${T}`);

  // Cobros recibidos
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_pagos (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id     INT NOT NULL,
    cuota_id        INT NULL,
    monto           DECIMAL(12,2) NOT NULL,
    fecha           DATE NOT NULL,
    metodo          VARCHAR(30) DEFAULT 'transferencia',
    referencia      VARCHAR(150) NULL,
    comprobante_url VARCHAR(500) NULL,
    registrado_por  INT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
    FOREIGN KEY (cuota_id) REFERENCES proyecto_cuotas(id) ON DELETE SET NULL
  ) ${T}`);
  await addCol('crm_historial', 'proyecto_id', 'INT NULL');
  await addCol('tareas', 'proyecto_id', 'INT NULL');
  await addCol('proyectos', 'monto_base',      'DECIMAL(12,2) NULL');
  await addCol('proyectos', 'horas_estimadas', 'DECIMAL(8,2) NULL');
  await addCol('proyectos', 'costo_hora',      'DECIMAL(10,2) NULL');
  await conn.query('UPDATE proyectos SET monto_base = monto WHERE monto_base IS NULL');

  // Hitos / entregables (avance)
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_hitos (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id    INT NOT NULL,
    orden          INT DEFAULT 0,
    titulo         VARCHAR(200) NOT NULL,
    descripcion    TEXT NULL,
    fecha_objetivo DATE NULL,
    peso           INT DEFAULT 1,
    completado     TINYINT(1) DEFAULT 0,
    completado_at  DATETIME NULL,
    completado_por INT NULL,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
  ) ${T}`);

  // Cambios de alcance (trabajo adicional que pide el cliente)
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_cambios (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id INT NOT NULL,
    titulo      VARCHAR(200) NOT NULL,
    descripcion TEXT NULL,
    monto       DECIMAL(12,2) DEFAULT 0,
    dias_extra  INT DEFAULT 0,
    estado      VARCHAR(15) DEFAULT 'pendiente',
    resuelto_at DATETIME NULL,
    creado_por  INT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
  ) ${T}`);

  // Incidencias (soporte y post-entrega)
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_tickets (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id     INT NOT NULL,
    numero          INT NOT NULL,
    titulo          VARCHAR(200) NOT NULL,
    descripcion     TEXT NULL,
    tipo            VARCHAR(20) DEFAULT 'error',
    prioridad       VARCHAR(10) DEFAULT 'media',
    estado          VARCHAR(15) DEFAULT 'abierto',
    cubierto        TINYINT(1) DEFAULT 1,
    monto_adicional DECIMAL(12,2) NULL,
    asignado_a      INT NULL,
    solucion        TEXT NULL,
    resuelto_at     DATETIME NULL,
    creado_por      INT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
    INDEX idx_ticket_estado (estado)
  ) ${T}`);
  await addCol('proyecto_tickets', 'cambio_id', 'INT NULL');

  // Horas trabajadas (rentabilidad)
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_horas (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id INT NOT NULL,
    usuario_id  INT NULL,
    fecha       DATE NOT NULL,
    horas       DECIMAL(6,2) NOT NULL,
    descripcion VARCHAR(300) NULL,
    hito_id     INT NULL,
    ticket_id   INT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
    INDEX idx_horas_fecha (fecha)
  ) ${T}`);

  // Documentos del proyecto (contrato, propuesta, acta de entrega…)
  await conn.query(`CREATE TABLE IF NOT EXISTS proyecto_archivos (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    proyecto_id INT NOT NULL,
    tipo        VARCHAR(20) DEFAULT 'otro',
    nombre      VARCHAR(255) NOT NULL,
    url         VARCHAR(500) NOT NULL,
    tamano      INT NULL,
    mime        VARCHAR(100) NULL,
    subido_por  INT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS notificaciones (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    tipo       VARCHAR(30) DEFAULT 'info',
    titulo     VARCHAR(200) NOT NULL,
    cuerpo     VARCHAR(500),
    enlace     VARCHAR(255),
    leida      TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notif_user (usuario_id, leida, created_at)
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS respuestas_rapidas (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    atajo      VARCHAR(40) NOT NULL,
    texto      TEXT NOT NULL,
    creado_por INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ${T}`);

  await conn.query(`CREATE TABLE IF NOT EXISTS leads_vetclinic (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    nombre         VARCHAR(120) NOT NULL,
    whatsapp       VARCHAR(30)  NOT NULL,
    clinica        VARCHAR(150) NOT NULL,
    pais           VARCHAR(10),
    email          VARCHAR(120),
    plan           VARCHAR(40) NOT NULL,
    ciclo          VARCHAR(20) DEFAULT 'Mensual',
    mensaje        TEXT,
    estado         VARCHAR(20) DEFAULT 'nuevo',
    fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_contacto DATETIME NULL,
    notas          TEXT
  ) ${T}`);
  await enumAVarchar('leads_vetclinic', 'plan',   'VARCHAR(40) NOT NULL');
  await enumAVarchar('leads_vetclinic', 'ciclo',  "VARCHAR(20) DEFAULT 'Mensual'");
  await enumAVarchar('leads_vetclinic', 'estado', "VARCHAR(20) DEFAULT 'nuevo'");
  await addCol('leads_vetclinic', 'negocio_id', 'INT NULL');

  await conn.query(`CREATE TABLE IF NOT EXISTS configuracion (
    clave       VARCHAR(50) PRIMARY KEY,
    valor       TEXT NOT NULL,
    descripcion VARCHAR(200)
  ) ${T}`);
  const cv = await columna('configuracion', 'valor');
  if (cv && cv.DATA_TYPE !== 'text') { await conn.query('ALTER TABLE configuracion MODIFY valor TEXT NOT NULL'); log('  ~ configuracion.valor → TEXT'); }

  // ── Datos iniciales ─────────────────────────────────────────────────────
  const { TODOS } = require('./lib/auth');
  const sinAdmin = TODOS.filter(p => !['config.editar', 'usuarios.gestionar', 'roles.gestionar'].includes(p));
  const vendedor = [
    'dashboard.ver', 'contactos.ver', 'contactos.crear', 'contactos.editar', 'pipeline.ver', 'pipeline.mover',
    'chat.ver', 'chat.enviar', 'campanas.ver', 'envios.ver', 'agenda.ver', 'agenda.gestionar',
    'tareas.ver', 'tareas.gestionar', 'leads.ver', 'prospeccion.buscar',
    'proyectos.ver', 'proyectos.gestionar', 'proyectos.montos',
  ];
  const lectura = TODOS.filter(p => p.endsWith('.ver') && !['config.ver', 'auditoria.ver'].includes(p)).concat('contactos.ver_todos');
  const roles = [
    ['Administrador', 'Acceso total al sistema', ['*'], 1],
    ['Supervisor', 'Gestiona el equipo comercial, campañas y reportes', sinAdmin, 0],
    ['Vendedor', 'Trabaja sus contactos asignados', vendedor, 0],
    ['Solo lectura', 'Consulta información sin modificarla', lectura, 0],
  ];
  for (const [nombre, desc, permisos, sistema] of roles) {
    await conn.query('INSERT IGNORE INTO roles (nombre, descripcion, permisos, es_sistema) VALUES (?,?,?,?)',
      [nombre, desc, JSON.stringify(permisos), sistema]);
  }

  // Permisos del módulo Proyectos en los roles que ya existían (una sola vez)
  const [[migProy]] = await conn.query("SELECT 1 AS ok FROM configuracion WHERE clave = 'mig_permisos_proyectos'");
  if (!migProy) {
    const todos = ['proyectos.ver', 'proyectos.gestionar', 'proyectos.montos'];
    for (const [nombre, nuevos] of [['Supervisor', todos], ['Vendedor', todos], ['Solo lectura', ['proyectos.ver']]]) {
      const [[r]] = await conn.query('SELECT id, permisos FROM roles WHERE nombre = ?', [nombre]);
      if (!r) continue;
      let p = []; try { p = JSON.parse(r.permisos); } catch { p = []; }
      if (p.includes('*')) continue;
      await conn.query('UPDATE roles SET permisos = ? WHERE id = ?', [JSON.stringify([...new Set([...p, ...nuevos])]), r.id]);
    }
    await conn.query("INSERT INTO configuracion (clave, valor, descripcion) VALUES ('mig_permisos_proyectos', '1', 'Migración aplicada')");
    log('  + permisos de Proyectos agregados a los roles');
  }
  const [[migProy2]] = await conn.query("SELECT 1 AS ok FROM configuracion WHERE clave = 'mig_permisos_proyectos_2'");
  if (!migProy2) {
    for (const nombre of ['Supervisor', 'Vendedor']) {
      const [[r]] = await conn.query('SELECT id, permisos FROM roles WHERE nombre = ?', [nombre]);
      if (!r) continue;
      let p = []; try { p = JSON.parse(r.permisos); } catch { p = []; }
      if (p.includes('*')) continue;
      await conn.query('UPDATE roles SET permisos = ? WHERE id = ?', [JSON.stringify([...new Set([...p, 'proyectos.trabajar'])]), r.id]);
    }
    // Rol para el equipo técnico: trabaja en los proyectos sin ver montos
    await conn.query('INSERT IGNORE INTO roles (nombre, descripcion, permisos, es_sistema) VALUES (?,?,?,0)',
      ['Desarrollador', 'Equipo técnico: avance, horas e incidencias, sin ver montos',
       JSON.stringify(['dashboard.ver', 'proyectos.ver', 'proyectos.trabajar', 'tareas.ver', 'tareas.gestionar', 'agenda.ver', 'contactos.ver', 'contactos.ver_todos'])]);
    await conn.query("INSERT INTO configuracion (clave, valor, descripcion) VALUES ('mig_permisos_proyectos_2', '1', 'Migración aplicada')");
    log('  + permiso proyectos.trabajar y rol Desarrollador');
  }

  const [[{ n: nUsuarios }]] = await conn.query('SELECT COUNT(*) AS n FROM usuarios');
  if (!nUsuarios) {
    const bcrypt = require('bcryptjs');
    const { passwordTemporal } = require('./lib/auth');
    const email = (process.env.ADMIN_EMAIL || 'admin@localhost').toLowerCase();
    const pass  = process.env.ADMIN_PASSWORD || passwordTemporal();
    const [[rol]] = await conn.query("SELECT id FROM roles WHERE nombre='Administrador'");
    await conn.query(
      'INSERT INTO usuarios (nombre, email, password_hash, rol_id, debe_cambiar_password) VALUES (?,?,?,?,1)',
      ['Administrador', email, await bcrypt.hash(pass, 12), rol.id]);
    log(`  + usuario administrador: ${email}${process.env.ADMIN_PASSWORD ? '' : ` (contraseña temporal: ${pass})`}`);
    log('    Se pedirá cambiar la contraseña en el primer ingreso.');
  }

  const [[{ n: nEtapas }]] = await conn.query('SELECT COUNT(*) AS n FROM etapas');
  if (!nEtapas) {
    const etapas = [
      ['nuevo', 'Nuevo', '#64748b', 'abierta'],
      ['contactado', 'Contactado', '#3b82f6', 'abierta'],
      ['interesado', 'Interesado', '#8b5cf6', 'abierta'],
      ['propuesta', 'Propuesta', '#f59e0b', 'abierta'],
      ['cerrado', 'Ganado', '#16a34a', 'ganada'],
      ['descartado', 'Perdido', '#dc2626', 'perdida'],
    ];
    let i = 0;
    for (const [clave, nombre, color, tipo] of etapas)
      await conn.query('INSERT INTO etapas (clave, nombre, color, tipo, orden) VALUES (?,?,?,?,?)', [clave, nombre, color, tipo, i++]);
  }

  // Configuración por defecto: solo inserta claves que no existen (no pisa valores)
  const { DEFS } = require('./lib/config');
  const { encrypt, tokenAleatorio } = require('./lib/crypto');
  for (const [clave, d] of Object.entries(DEFS)) {
    let def = d.def;
    if (clave === 'meta_verify_token') def = tokenAleatorio(18);
    if (clave === 'google_api_key' && process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== 'TU_API_KEY_AQUI')
      def = encrypt(process.env.GOOGLE_API_KEY);
    await conn.query('INSERT IGNORE INTO configuracion (clave, valor, descripcion) VALUES (?,?,?)', [clave, def, d.label]);
  }

  // Graph API: la versión anterior por defecto (v23.0) pasa a la que usa la integración actual
  await conn.query("UPDATE configuracion SET valor = 'v25.0' WHERE clave = 'meta_api_version' AND valor IN ('', 'v23.0')");

  // Cuenta de WhatsApp: si se había configurado a mano (versión anterior), pasa a wa_cuenta
  const [[cuenta]] = await conn.query('SELECT id FROM wa_cuenta WHERE id = 1');
  if (!cuenta) {
    const [viejas] = await conn.query(
      "SELECT clave, valor FROM configuracion WHERE clave IN ('meta_phone_number_id','meta_waba_id','meta_access_token')");
    const v = Object.fromEntries(viejas.map(r => [r.clave, r.valor]));
    const conectada = v.meta_phone_number_id && v.meta_access_token;
    await conn.query(
      `INSERT INTO wa_cuenta (id, estado, modo, waba_id, phone_number_id, access_token, conectado_at)
       VALUES (1, ?, 'manual', ?, ?, ?, ?)`,
      [conectada ? 'conectado' : 'desconectado', v.meta_waba_id || null, v.meta_phone_number_id || null,
       v.meta_access_token || null, conectada ? new Date() : null]);
    if (conectada) log('  ~ credenciales manuales de Meta movidas a wa_cuenta');
  }

  await conn.end();
  log('✅ Base de datos al día');
}

module.exports = { migrar };

if (require.main === module) {
  migrar().catch(err => { console.error('❌', err.message); process.exit(1); });
}
