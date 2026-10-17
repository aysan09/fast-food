require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function initializeDatabase() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true
    });
    try {
        const schema = await fs.readFile(path.join(__dirname, '..', 'schema.sql'), 'utf8');
        await connection.query(schema);
        const [columns] = await connection.execute(
            `SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'payment_channel'`,
            [process.env.DB_NAME || 'ember_kitchen']
        );
        if (columns[0].count === 0) {
            await connection.query('ALTER TABLE orders ADD COLUMN payment_channel VARCHAR(32) NULL AFTER payment_method');
        }
        await connection.query(`ALTER TABLE orders
            MODIFY payment_method ENUM('digital_aggregator', 'telebirr_transfer', 'cbe_transfer', 'cash') NOT NULL,
            MODIFY payment_status ENUM('pending_approval', 'verified', 'rejected', 'unpaid', 'processing', 'paid', 'failed') DEFAULT 'pending_approval'`);
        for (const [column, definition] of [
            ['payment_screenshot_url', 'VARCHAR(255) NULL AFTER payment_status'],
            ['rejection_reason', 'VARCHAR(255) NULL AFTER payment_screenshot_url']
        ]) {
            const [existing] = await connection.execute(
                `SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?`,
                [process.env.DB_NAME || 'ember_kitchen', column]
            );
            if (existing[0].count === 0) await connection.query(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
        }
        console.log('EMBER KITCHEN schema and seed data are ready.');
    } finally {
        await connection.end();
    }
}

initializeDatabase().catch(error => {
    console.error(`Database initialization failed: ${error.message}`);
    process.exitCode = 1;
});