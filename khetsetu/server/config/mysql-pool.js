'use strict';

const mysql = require('mysql2/promise');

let pool;
let connected = false;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'khetsetu',
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: false
    });
  }
  return pool;
}

async function getConnection() {
  return getPool().getConnection();
}

function setConnected(value) { connected = Boolean(value); }
function isConnected() { return connected; }

module.exports = { getPool, getConnection, setConnected, isConnected };
