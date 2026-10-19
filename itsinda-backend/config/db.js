"use strict";

require("dotenv").config();
const mysql = require("mysql2/promise");

// server.js validates that production credentials are explicitly configured.
// Do not disable TLS verification for managed database connections.
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "itsinda_db",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
});

module.exports = pool;
