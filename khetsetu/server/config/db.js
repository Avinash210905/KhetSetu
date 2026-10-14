'use strict';

const mysqlStore = require('../db/mysql-compat');

const connectDB = async () => {
  try {
    await mysqlStore.connect();
    console.log(`MySQL connected successfully: ${process.env.MYSQL_HOST || '127.0.0.1'} / ${process.env.MYSQL_DATABASE || 'khetsetu'}`);
  } catch (error) {
    console.error(`MySQL connection failed: ${error.message}`);
    throw error;
  }
};

module.exports = connectDB;
