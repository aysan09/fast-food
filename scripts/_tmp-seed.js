require('dotenv').config();
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

// Adds a handful of COMPLETED demo orders on several past days so the
// date-grouped report can be inspected. Rows are tagged so they can be removed.
(async () => {
    const c = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'seba_cafe'
    });

    const [[item]] = await c.query("SELECT id, price FROM menu_items ORDER BY id LIMIT 1");
    if (!item) { console.log('no menu items'); await c.end(); return; }

    await c.query("DELETE FROM orders WHERE transaction_reference LIKE 'DEMO-REPORT-%'");

    const plan = [
        [0, 3, 'cash'], [0, 1, 'cash'], [-1, 2, 'telebirr_transfer'], [-1, 1, 'cash'],
        [-2, 4, 'cash'], [-3, 2, 'cbe_transfer'], [-5, 1, 'cash']
    ];
    for (const [dayOffset, count, method] of plan) {
        for (let i = 0; i < count; i++) {
            const qty = 1 + (i % 3);
            const total = Number(item.price) * qty;
            const ref = `DEMO-REPORT-${crypto.randomUUID()}`;
            const [res] = await c.execute(
                `INSERT INTO orders (public_token, table_number, order_type, payment_method, payment_status, status, total_amount, transaction_reference, created_at)
                 VALUES (?, ?, 'qr_self_service', ?, ?, 'completed', ?, ?, NOW() - INTERVAL ? DAY)`,
                [crypto.randomBytes(32).toString('hex'), String(1 + (i % 9)).padStart(2, '0'), method,
                method === 'cash' ? 'paid' : 'verified', total.toFixed(2), ref, -dayOffset]
            );
            await c.execute('INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
                [res.insertId, item.id, qty, item.price]);
        }
    }
    const [rows] = await c.query("SELECT DATE(created_at) d, COUNT(*) n, SUM(total_amount) total FROM orders WHERE transaction_reference LIKE 'DEMO-REPORT-%' GROUP BY DATE(created_at) ORDER BY d DESC");
    console.table(rows);
    await c.end();
})();
