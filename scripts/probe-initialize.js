require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME
    });
    const [orders] = await connection.query(
        'SELECT id, public_token, table_number, total_amount, payment_method, payment_channel, payment_status, status FROM orders ORDER BY id DESC LIMIT 3'
    );
    console.log('recent orders:', JSON.stringify(orders, null, 1));
    await connection.end();

    const order = orders[0];
    if (!order) return;

    const response = await fetch('http://127.0.0.1:3000/api/payments/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            order_id: order.id,
            public_token: order.public_token,
            phone_number: '0909635194',
            payment_channel: 'telebirr'
        })
    });
    console.log('initialize status:', response.status);
    console.log('initialize body:', await response.text());
})().catch(error => console.error('ERR', error.message));
