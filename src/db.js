require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'places_crm',
  charset:  'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '-05:00'
});

module.exports = pool;
