require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  charset:            'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
  timezone:           '-05:00'
});

// Test connection on startup
pool.getConnection()
  .then(conn => { console.log('✅ MySQL conectado como:', process.env.DB_USER); conn.release(); })
  .catch(err => console.error('❌ MySQL error:', err.message));

module.exports = pool;