require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

(async () => {
    const sql = await fs.readFile(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true
    });
    try {
        await connection.query(sql);
        console.log('Seba Cafe database is ready.');
    } finally {
        await connection.end();
    }
})().catch(error => {
    console.error(`Database setup failed: ${error.message}`);
    process.exitCode = 1;
});
