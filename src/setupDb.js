require('dotenv').config();
const mysql = require('mysql2/promise');

async function setup() {
  console.log('🔧 Configurando base de datos places_crm...');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  const db = process.env.DB_NAME || 'places_crm';
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${db}\``);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS negocios (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      place_id      VARCHAR(255) UNIQUE NOT NULL,
      nombre        VARCHAR(500),
      telefono      VARCHAR(100),
      telefono_int  VARCHAR(100),
      whatsapp      VARCHAR(50),
      website       VARCHAR(500),
      direccion     TEXT,
      rating        DECIMAL(3,1),
      resenas       INT DEFAULT 0,
      estado        VARCHAR(100),
      horarios      TEXT,
      categorias    VARCHAR(500),
      descripcion   TEXT,
      maps_url      TEXT,
      lat           DECIMAL(10,7),
      lng           DECIMAL(10,7),
      departamento  VARCHAR(100),
      provincia     VARCHAR(100),
      distrito      VARCHAR(100),
      rubro_busqueda VARCHAR(200),
      estado_crm    ENUM('nuevo','contactado','interesado','propuesta','cerrado','descartado') DEFAULT 'nuevo',
      responsable   VARCHAR(200),
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS crm_historial (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      negocio_id      INT NOT NULL,
      tipo            ENUM('estado','comentario','llamada','demo','mensaje') DEFAULT 'comentario',
      estado_anterior VARCHAR(50),
      estado_nuevo    VARCHAR(50),
      contenido       TEXT,
      usuario         VARCHAR(200),
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS campanas (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      nombre      VARCHAR(300) NOT NULL,
      mensaje     TEXT NOT NULL,
      imagen_url  VARCHAR(500),
      variables   JSON,
      activa      TINYINT(1) DEFAULT 1,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS envios (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      campana_id    INT,
      negocio_id    INT NOT NULL,
      numero        VARCHAR(50),
      mensaje_final TEXT,
      estado        ENUM('pendiente','enviado','fallido','leido') DEFAULT 'pendiente',
      enviado_at    TIMESTAMP NULL,
      error_msg     VARCHAR(500),
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campana_id) REFERENCES campanas(id) ON DELETE SET NULL,
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS chat_mensajes (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      negocio_id  INT,
      numero      VARCHAR(50),
      direccion   ENUM('saliente','entrante') NOT NULL,
      tipo        ENUM('texto','imagen','documento','audio') DEFAULT 'texto',
      contenido   TEXT,
      media_url   VARCHAR(500),
      wa_id       VARCHAR(200),
      leido       TINYINT(1) DEFAULT 0,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS demos (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      negocio_id       INT NOT NULL,
      titulo           VARCHAR(300),
      fecha_hora       DATETIME NOT NULL,
      duracion_min     INT DEFAULT 60,
      tipo             ENUM('presencial','virtual','telefonica') DEFAULT 'virtual',
      enlace           VARCHAR(500),
      notas            TEXT,
      estado           ENUM('agendada','realizada','cancelada','reprogramada') DEFAULT 'agendada',
      recordatorio_24h TINYINT(1) DEFAULT 0,
      recordatorio_1h  TINYINT(1) DEFAULT 0,
      responsable      VARCHAR(200),
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (negocio_id) REFERENCES negocios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.end();
  console.log('✅ Base de datos lista con todas las tablas');
  console.log('   negocios | crm_historial | campanas | envios | chat_mensajes | demos\n');
}

setup().catch(err => { console.error('❌', err.message); process.exit(1); });