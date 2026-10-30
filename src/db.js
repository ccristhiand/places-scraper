require('dotenv').config();
require('./lib/env').ensureSecrets();
const mysql = require('mysql2/promise');

const DB_TZ = /^[+-]\d{2}:\d{2}$/.test(process.env.DB_TZ || '') ? process.env.DB_TZ : '-05:00';

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  charset:            'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
  // BD remota: mantener vivas las conexiones y descartar las inactivas antes
  // de que MySQL o la red las corten (evita errores ECONNRESET intermitentes)
  enableKeepAlive:       true,
  keepAliveInitialDelay: 10000,
  maxIdle:               5,
  idleTimeout:           60000,
  timezone:           DB_TZ,
  dateStrings:        false,
});

// NOW()/CURDATE() en la zona horaria del negocio (Perú no tiene horario de verano)
pool.pool.on('connection', conn => conn.query(`SET time_zone = '${DB_TZ}'`));

module.exports = pool;
