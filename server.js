require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');
const { DIRECT_CHANNELS, HOSTED_CHANNEL, MINIMUM_ETB, isSupportedChannel, checkoutWasCreated, hostedPaymentBody, merchantReference, chapaPhoneNumber, moneyInCents, verificationMatches, webhookSignatureIsValid } = require('./payments');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT || 3000);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
let sessionSecret = process.env.SESSION_SECRET || '';
const root = __dirname;
const itemImageDirectory = path.join(root, 'uploads', 'menu-items');
const itemImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});
const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'seba_cafe',
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: false
});

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'https://images.unsplash.com', 'https://api.qrserver.com'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"]
        }
    }
}));
app.use(express.json({ limit: '64kb', verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

function sendError(res, status, message) {
    return res.status(status).json({ error: message });
}

function signSession(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
}

function getSession(req) {
    if (!sessionSecret) return null;
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('seba_session='));
    if (!cookie) return null;
    let token;
    try { token = decodeURIComponent(cookie.slice('seba_session='.length)); } catch { return null; }
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        return payload.exp > Date.now() ? payload : null;
    } catch {
        return null;
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        req.user = getSession(req);
        if (!req.user) return sendError(res, 401, 'Sign in to continue.');
        if (!roles.includes(req.user.role)) return sendError(res, 403, 'Your account does not have access to this workspace.');
        next();
    };
}

function attachSession(res, user) {
    const token = signSession({ id: user.id, name: user.name, role: user.role, exp: Date.now() + 12 * 60 * 60 * 1000 });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `seba_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`);
}

const loginAttempts = new Map();
function loginRateLimited(key) {
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt < now) { loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 }); return false; }
    entry.count += 1;
    return entry.count > 10;
}
setInterval(() => { const now = Date.now(); for (const [key, entry] of loginAttempts) if (entry.resetAt < now) loginAttempts.delete(key); }, 10 * 60 * 1000).unref();
const dummyHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, storedHash) {
    const [salt, expectedHex] = String(storedHash || '').split(':');
    if (!salt || !expectedHex) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function bootstrapStaff() {
    const staff = [
        { role: 'admin', name: process.env.ADMIN_NAME, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
        { role: 'cashier', name: process.env.CASHIER_NAME, email: process.env.CASHIER_EMAIL, password: process.env.CASHIER_PASSWORD },
        { role: 'waiter', name: process.env.WAITER_NAME, email: process.env.WAITER_EMAIL, password: process.env.WAITER_PASSWORD }
    ];
    for (const user of staff) {
        if (!user.email || !user.password || user.password.startsWith('replace-with-')) continue;
        if (process.env.NODE_ENV === 'production' && user.password.length < 8) throw new Error(`Set a staff password of at least 8 characters for ${user.role} in .env.`);
        await pool.execute(
            `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = VALUES(role)`,
            [user.name || user.role, user.email.toLowerCase(), hashPassword(user.password), user.role]
        );
    }
}

async function readOrder(orderId, connection = pool) {
    const [rows] = await connection.execute(
        `SELECT o.id, o.public_token, o.table_number, o.order_type, o.payment_method, o.payment_status,
                o.status, o.transaction_reference, o.total_amount, o.created_at,
                oi.menu_item_id, mi.name, oi.quantity, oi.unit_price
         FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id WHERE o.id = ? ORDER BY oi.id`,
        [orderId]
    );
    if (!rows.length) return null;
    const first = rows[0];
    return {
        id: first.id,
        public_token: first.public_token,
        table_number: first.table_number,
        order_type: first.order_type,
        payment_method: first.payment_method,
        payment_status: first.payment_status,
        status: first.status,
        transaction_reference: first.transaction_reference,
        total_amount: Number(first.total_amount),
        created_at: first.created_at,
        lines: rows.filter(row => row.menu_item_id).map(row => ({ menu_item_id: row.menu_item_id, name: row.name, quantity: row.quantity, price: Number(row.unit_price) }))
    };
}

async function releaseTableIfIdle(connection, tableNumber) {
    const [active] = await connection.execute(
        `SELECT COUNT(*) AS count FROM orders WHERE table_number = ? AND status IN ('pending_approval', 'in_kitchen', 'ready')`,
        [tableNumber]
    );
    if (Number(active[0].count) === 0) {
        await connection.execute("UPDATE restaurant_tables SET status = 'available' WHERE table_number = ? AND status = 'occupied'", [tableNumber]);
    }
}

async function cancelAbandonedOrders() {
    const [stale] = await pool.execute(
        `SELECT id, table_number FROM orders WHERE payment_method = 'digital_aggregator' AND payment_status = 'unpaid'
         AND status = 'pending_approval' AND created_at < (NOW() - INTERVAL 30 MINUTE)`
    );
    for (const order of stale) {
        const [updated] = await pool.execute(
            `UPDATE orders SET status = 'cancelled', payment_status = 'failed' WHERE id = ? AND payment_status = 'unpaid' AND status = 'pending_approval'`,
            [order.id]
        );
        if (updated.affectedRows) {
            await releaseTableIfIdle(pool, order.table_number);
            io.to('staff').emit('order_status_updated', { id: order.id, status: 'cancelled', payment_status: 'failed' });
        }
    }
}

const CHAPA_API_BASE = process.env.CHAPA_API_BASE || 'https://api.chapa.global/v2';

// v2 verifies by the provider payment reference (the tail of checkout_url), so prefer the
// stored provider_reference and fall back to the merchant reference for older orders.
async function verifyWithChapa(paymentReference) {
    const secret = process.env.CHAPA_SECRET_KEY;
    if (!secret) throw Object.assign(new Error('Chapa is not configured. Add CHAPA_SECRET_KEY to .env.'), { status: 503 });
    const response = await fetch(`${CHAPA_API_BASE}/payments/${encodeURIComponent(paymentReference)}/verify`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`Chapa verification failed: ${result?.message || response.status}`), { status: 502 });
    return result;
}

function paymentReferenceFromCheckoutUrl(checkoutUrl) {
    const match = String(checkoutUrl || '').match(/\/([^/?#]+)\/?$/);
    return match ? match[1] : null;
}

async function reconcilePayment(transactionReference) {
    const [matches] = await pool.execute(
        'SELECT id, table_number, total_amount, payment_status, status, public_token, provider_reference FROM orders WHERE transaction_reference = ?',
        [transactionReference]
    );
    const order = matches[0];
    if (!order) return { found: false };
    if (order.payment_status === 'paid') return { found: true, paid: true, orderId: order.id, publicToken: order.public_token };

    const verification = await verifyWithChapa(order.provider_reference || transactionReference);
    if (!verificationMatches(verification, transactionReference, order.total_amount)) {
        const providerStatus = String(verification?.data?.status ?? verification?.status ?? '').toLowerCase();
        const providerReference = verification?.data?.chapa_reference ?? verification?.data?.reference ?? null;
        if (['failed', 'cancelled', 'expired', 'reversed'].includes(providerStatus)) {
            await pool.execute(
                `UPDATE orders SET payment_status = 'failed', status = 'cancelled', provider_reference = ?
                 WHERE id = ? AND payment_status <> 'paid'`,
                [providerReference, order.id]
            );
            await releaseTableIfIdle(pool, order.table_number);
            io.to('staff').emit('order_status_updated', { id: order.id, status: 'cancelled', payment_status: 'failed' });
        }
        return { found: true, paid: false, orderId: order.id, publicToken: order.public_token };
    }

    const providerReference = verification?.data?.chapa_reference ?? verification?.data?.reference ?? null;
    const [updated] = await pool.execute(
        `UPDATE orders SET payment_status = 'paid', status = 'in_kitchen', provider_reference = ?
         WHERE id = ? AND transaction_reference = ? AND payment_status = 'processing' AND status = 'pending_approval'`,
        [providerReference, order.id, transactionReference]
    );
    if (updated.affectedRows) {
        const settled = await readOrder(order.id);
        io.to('staff').emit('new_order', settled);
        io.to('staff').emit('order_paid', { orderId: order.id, table: settled.table_number, status: 'in_kitchen' });
        io.to('staff').emit('order_status_updated', { id: order.id, status: 'in_kitchen', payment_status: 'paid' });
    }
    return { found: true, paid: true, orderId: order.id, publicToken: order.public_token };
}

io.use((socket, next) => {
    const user = getSession({ headers: { cookie: socket.request.headers.cookie } });
    socket.data.user = user;
    next();
});
io.on('connection', socket => {
    if (socket.data.user) socket.join('staff');
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const role = String(req.body.role || '');
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        if (!['admin', 'cashier', 'waiter'].includes(role) || !email || !password) return sendError(res, 400, 'Choose a role and enter your email and password.');
        if (loginRateLimited(`${req.ip}|${email}`)) return sendError(res, 429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
        const [users] = await pool.execute('SELECT id, name, email, role, password_hash FROM users WHERE email = ? AND role = ? LIMIT 1', [email, role]);
        const user = users[0];
        const passwordOk = passwordMatches(password, user ? user.password_hash : dummyHash);
        if (!user || !passwordOk) return sendError(res, 401, 'Those sign-in details do not match.');
        attachSession(res, user);
        res.json({ user: { id: user.id, name: user.name, role: user.role } });
    } catch (error) { next(error); }
});

app.get('/api/auth/session', requireRole('admin', 'cashier', 'waiter'), (req, res) => {
    res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role } });
});

app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `seba_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.status(204).end();
});

app.get('/api/menu-items', async (req, res, next) => {
    try {
        const [items] = await pool.execute(
            `SELECT m.id, m.name, c.name AS category, m.price, m.description, m.image_url, m.status, m.is_available
             FROM menu_items m JOIN categories c ON c.id = m.category_id
             WHERE m.is_available = TRUE ORDER BY c.display_order, m.id`
        );
        const [categories] = await pool.execute('SELECT id, name, display_order FROM categories ORDER BY display_order, name');
        res.json({ items: items.map(item => ({ ...item, id: String(item.id), price: Number(item.price), image: item.image_url })), categories });
    } catch (error) { next(error); }
});

app.post('/api/orders', async (req, res, next) => {
    const connection = await pool.getConnection();
    let committed = false;
    try {
        const orderType = req.body.order_type === 'waiter_assisted' ? 'waiter_assisted' : 'qr_self_service';
        if (orderType === 'waiter_assisted') {
            req.user = getSession(req);
            if (!req.user) return sendError(res, 401, 'Waiter sign-in is required to submit this order.');
            if (req.user.role !== 'waiter') return sendError(res, 403, 'Only waiters can submit waiter-assisted orders.');
        }
        const tableNumber = String(req.body.table_number || '').trim();
        const paymentMethod = req.body.payment_method;
        let requested = req.body.items;
        if (typeof requested === 'string') {
            try { requested = JSON.parse(requested); } catch { return sendError(res, 400, 'Order items must be valid JSON.'); }
        }
        if (!/^\d{1,10}$/.test(tableNumber)) return sendError(res, 400, 'Choose a valid table.');
        if (!['cash', 'digital_aggregator', 'telebirr_transfer', 'cbe_transfer'].includes(paymentMethod)) return sendError(res, 400, 'Choose a supported payment method.');
        const isTransfer = ['telebirr_transfer', 'cbe_transfer'].includes(paymentMethod);
        if (paymentMethod === 'digital_aggregator' && !process.env.CHAPA_SECRET_KEY) return sendError(res, 503, 'Digital payment is not configured yet. Add a Chapa secret key to the server environment.');
        if (!Array.isArray(requested) || requested.length < 1 || requested.length > 50) return sendError(res, 400, 'Add at least one menu item.');
        const quantities = new Map();
        for (const line of requested) {
            const itemId = Number(line.menu_item_id);
            const quantity = Number(line.quantity);
            if (!Number.isInteger(itemId) || itemId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return sendError(res, 400, 'Each order line needs a valid item and quantity.');
            quantities.set(itemId, (quantities.get(itemId) || 0) + quantity);
        }

        await connection.beginTransaction();
        const normalizedTable = tableNumber.padStart(2, '0');
        const [tables] = await connection.execute(
            `SELECT table_number FROM restaurant_tables WHERE table_number = ? AND status <> 'reserved' FOR UPDATE`,
            [normalizedTable]
        );
        if (!tables.length) {
            await connection.rollback();
            return sendError(res, 400, 'That table is not available for ordering.');
        }
        const ids = [...quantities.keys()];
        const [items] = await connection.query(
            `SELECT id, name, price, status FROM menu_items WHERE id IN (${ids.map(() => '?').join(',')}) AND is_available = TRUE FOR UPDATE`,
            ids
        );
        if (items.length !== ids.length || items.some(item => item.status !== 'in_stock')) {
            await connection.rollback();
            return sendError(res, 409, 'One or more items are no longer available. Refresh the menu and try again.');
        }
        const total = items.reduce((sum, item) => sum + moneyInCents(item.price) * quantities.get(item.id), 0);
        const publicToken = crypto.randomBytes(32).toString('hex');
        const paymentStatus = isTransfer ? 'pending_approval' : 'unpaid';
        const [created] = await connection.execute(
            `INSERT INTO orders (public_token, table_number, order_type, payment_method, payment_status, status, total_amount)
             VALUES (?, ?, ?, ?, ?, 'pending_approval', ?)`,
            [publicToken, normalizedTable, orderType, paymentMethod, paymentStatus, (total / 100).toFixed(2)]
        );
        for (const item of items) {
            await connection.execute(
                'INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
                [created.insertId, item.id, quantities.get(item.id), item.price]
            );
        }
        await connection.execute("UPDATE restaurant_tables SET status = 'occupied' WHERE table_number = ?", [normalizedTable]);
        await connection.commit();
        committed = true;
        const order = await readOrder(created.insertId);
        if (paymentMethod === 'cash' || isTransfer) io.to('staff').emit('new_order', order);
        res.status(201).json({ order_id: order.id, public_token: publicToken, payment_status: order.payment_status, total_amount: order.total_amount });
    } catch (error) {
        await connection.rollback().catch(() => { });
        next(error);
    } finally {
        connection.release();
    }
});

app.get('/api/payment-details', (req, res) => {
    res.json({
        account_name: process.env.BANK_ACCOUNT_NAME || '',
        telebirr_account: process.env.TELEBIRR_ACCOUNT || '',
        cbe_account: process.env.CBE_ACCOUNT || '',
        online_enabled: Boolean(process.env.CHAPA_SECRET_KEY),
        online_channels: [...Object.keys(DIRECT_CHANNELS), HOSTED_CHANNEL]
    });
});

app.get('/api/menu-items/:fileName', (req, res, next) => {
    if (/[\\/]/.test(req.params.fileName)) return sendError(res, 400, 'Invalid file name.');
    res.sendFile(path.join(itemImageDirectory, req.params.fileName), error => {
        if (error && !res.headersSent) sendError(res, 404, 'Image not found.');
    });
});

app.post('/api/payments/initialize', async (req, res, next) => {
    try {
        const orderId = Number(req.body.order_id);
        const publicToken = String(req.body.public_token || '');
        const firstName = String(req.body.first_name || '').trim().slice(0, 100);
        const lastName = String(req.body.last_name || '').trim().slice(0, 100);
        const email = String(req.body.email || '').trim();
        const paymentChannel = String(req.body.payment_channel || '').toLowerCase();
        const hosted = paymentChannel === HOSTED_CHANNEL;
        // v2 has no direct-charge endpoint, so a wallet choice becomes a preference on the
        // hosted page. The phone number is optional and normalised to Chapa's 251 format.
        const phone = chapaPhoneNumber(req.body.phone_number);
        if (!process.env.CHAPA_SECRET_KEY) return sendError(res, 503, 'Digital payment is not configured yet. Add a Chapa secret key to the server environment.');
        if (!isSupportedChannel(paymentChannel)) return sendError(res, 400, 'Choose a supported payment provider.');
        if (!Number.isInteger(orderId)) return sendError(res, 400, 'Invalid order.');
        if (req.body.phone_number && !phone) return sendError(res, 400, 'Enter a valid Ethiopian mobile number such as 0912345678.');
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, 'Enter a valid email address.');
        const order = await readOrder(orderId);
        if (!order || order.public_token !== publicToken) return sendError(res, 404, 'Order not found.');
        // Only the full online payment of a digital order can be initialized here.
        if (order.payment_method !== 'digital_aggregator' || !['unpaid', 'processing'].includes(order.payment_status) || order.status !== 'pending_approval') return sendError(res, 409, 'This order can no longer be paid online.');
        const minimum = MINIMUM_ETB[paymentChannel] || 1;
        if (order.total_amount < minimum) return sendError(res, 400, `${DIRECT_CHANNELS[paymentChannel] || 'This method'} needs an order of at least ETB ${minimum}. Choose another method.`);

        const transactionReference = merchantReference('seba');
        const [claimed] = await pool.execute(
            `UPDATE orders SET payment_method = 'digital_aggregator', payment_status = 'processing', transaction_reference = ?, payment_channel = ?,
             customer_first_name = ?, customer_last_name = ?, customer_email = ?
             WHERE id = ? AND status = 'pending_approval' AND payment_status IN ('unpaid', 'processing')`,
            [transactionReference, paymentChannel, firstName || null, lastName || null, email || null, orderId]
        );
        if (!claimed.affectedRows) return sendError(res, 409, 'This order can no longer be paid online.');

        const failCharge = async () => {
            await pool.execute(
                `UPDATE orders SET payment_status = 'failed', status = 'cancelled'
                 WHERE id = ? AND transaction_reference = ? AND payment_status = 'processing'`,
                [orderId, transactionReference]
            );
            await releaseTableIfIdle(pool, order.table_number);
        };

        let response;
        let result;
        try {
            response = await fetch(`${CHAPA_API_BASE}/payments/hosted`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                    // Required by v2; reusing the order's reference keeps retries idempotent.
                    'Idempotency-Key': transactionReference
                },
                body: JSON.stringify(hostedPaymentBody({
                    amount: order.total_amount,
                    reference: transactionReference,
                    email,
                    firstName,
                    lastName,
                    phone,
                    channel: paymentChannel,
                    callbackUrl: publicBaseUrl.startsWith('https://') ? `${publicBaseUrl}/api/payments/callback` : 'https://example.com/callback',
                    returnUrl: publicBaseUrl.startsWith('https://') ? `${publicBaseUrl}/api/payments/callback?trx_ref=${encodeURIComponent(transactionReference)}` : 'https://example.com/return',
                    orderId,
                    tableNumber: order.table_number
                })),
                signal: AbortSignal.timeout(15000)
            });
            result = await response.json().catch(() => ({}));
        } catch (networkError) {
            await failCharge();
            return sendError(res, 502, 'Could not reach Chapa. Please try again in a moment.');
        }
        if (!response.ok || !checkoutWasCreated(result)) {
            await failCharge();
            // Surface Chapa's own reason: it distinguishes an expired key from a bad payload.
            const detail = result?.error?.code ? `${result.error.code}: ${result.message || ''}`.trim() : (result?.message || '');
            console.error('Chapa hosted checkout failed:', response.status, detail || '(no message)');
            return sendError(res, 502, detail
                ? `Chapa could not start the payment: ${detail}`
                : 'Chapa could not open the payment page. Please try again or choose another method.');
        }
        const paymentReference = paymentReferenceFromCheckoutUrl(result.data.checkout_url);
        if (paymentReference) {
            await pool.execute('UPDATE orders SET provider_reference = ? WHERE id = ? AND transaction_reference = ?', [paymentReference, orderId, transactionReference]);
        }
        io.to('staff').emit('order_status_updated', { id: orderId, status: 'pending_approval', payment_status: 'processing' });
        res.json({
            payment_status: 'processing',
            public_token: order.public_token,
            transaction_reference: transactionReference,
            payment_channel: paymentChannel,
            checkout_url: result.data.checkout_url
        });
    } catch (error) { next(error); }
});

app.get('/api/payments/callback', async (req, res, next) => {
    try {
        const transactionReference = String(req.query.trx_ref || req.query.tx_ref || '');
        if (!transactionReference) return sendError(res, 400, 'Transaction reference is missing.');
        const result = await reconcilePayment(transactionReference);
        if (!result.found) return sendError(res, 404, 'Transaction not found.');
        return res.redirect(`${publicBaseUrl}/#/payment-return?token=${encodeURIComponent(result.publicToken)}`);
    } catch (error) { next(error); }
});

app.post('/api/payments/webhook', async (req, res, next) => {
    try {
        const secret = process.env.CHAPA_WEBHOOK_SECRET;
        if (!webhookSignatureIsValid(secret, req.rawBody, req.body, req.headers)) return sendError(res, 401, 'Invalid Chapa webhook signature.');
        const transactionReference = String(req.body.tx_ref || req.body.trx_ref || '');
        if (!transactionReference) return sendError(res, 400, 'Transaction reference is missing.');
        const result = await reconcilePayment(transactionReference);
        if (!result.found) return sendError(res, 404, 'Transaction not found.');
        res.status(200).json({ received: true });
    } catch (error) { next(error); }
});

app.get('/api/orders/public/:token', async (req, res, next) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, public_token, table_number, payment_method, payment_channel, payment_status, status, total_amount
             FROM orders WHERE public_token = ? LIMIT 1`,
            [req.params.token]
        );
        const order = rows[0];
        if (!order) return sendError(res, 404, 'Order not found.');
        res.json({ order_id: order.id, table_number: order.table_number, payment_method: order.payment_method, payment_channel: order.payment_channel, payment_status: order.payment_status, status: order.status, total_amount: Number(order.total_amount) });
    } catch (error) { next(error); }
});

app.get('/api/admin/menu-items', requireRole('admin'), async (req, res, next) => {
    try {
        const [items] = await pool.execute(
            `SELECT m.id, m.name, c.name AS category, m.price, m.description, m.image_url, m.status, m.is_available
             FROM menu_items m JOIN categories c ON c.id = m.category_id ORDER BY c.display_order, m.id`
        );
        res.json({ items: items.map(item => ({ ...item, id: String(item.id), price: Number(item.price), image: item.image_url })) });
    } catch (error) { next(error); }
});

app.get('/api/admin/overview', requireRole('admin'), async (req, res, next) => {
    try {
        const [orderRows] = await pool.query(
            `SELECT
                COALESCE(SUM(CASE WHEN status = 'completed' AND payment_status IN ('paid', 'verified') THEN total_amount ELSE 0 END), 0) AS today_revenue,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_orders,
                SUM(CASE WHEN status = 'in_kitchen' OR status = 'ready' THEN 1 ELSE 0 END) AS open_orders,
                AVG(CASE WHEN status = 'completed' AND payment_status IN ('paid', 'verified') THEN total_amount ELSE NULL END) AS average_order
             FROM orders WHERE created_at >= CURDATE()`
        );
        const [tableRows] = await pool.query(
            `SELECT COUNT(*) AS total_tables,
                    SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) AS active_tables
             FROM restaurant_tables`
        );
        res.json({
            today_revenue: Number(orderRows[0].today_revenue),
            completed_orders: Number(orderRows[0].completed_orders || 0),
            open_orders: Number(orderRows[0].open_orders || 0),
            average_order: Number(orderRows[0].average_order || 0),
            active_tables: Number(tableRows[0].active_tables || 0),
            total_tables: Number(tableRows[0].total_tables || 0),
            digital_payment_ready: Boolean(process.env.CHAPA_SECRET_KEY || process.env.TELEBIRR_ACCOUNT || process.env.CBE_ACCOUNT)
        });
    } catch (error) { next(error); }
});

app.get('/api/admin/tables', requireRole('admin'), async (req, res, next) => {
    try {
        const [tables] = await pool.execute(
            `SELECT t.table_number, t.status,
                    (SELECT COUNT(*) FROM orders o WHERE o.table_number = t.table_number
                     AND o.status IN ('pending_approval', 'in_kitchen', 'ready')) AS active_orders
             FROM restaurant_tables t ORDER BY CAST(t.table_number AS UNSIGNED)`
        );
        res.json({ tables });
    } catch (error) { next(error); }
});

app.post('/api/admin/menu-items', requireRole('admin'), (req, res, next) => itemImageUpload.single('image')(req, res, error => {
    if (error) return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'Upload one JPG, PNG, or WebP image up to 5 MB.');
    next();
}), async (req, res, next) => {
    try {
        const name = String(req.body.name || '').trim();
        const category = String(req.body.category || '').trim();
        const price = Number(req.body.price);
        if (!name || name.length > 150 || !category || category.length > 100 || !Number.isFinite(price) || price <= 0) return sendError(res, 400, 'Enter an item name, category, and positive price.');
        const [categoryResult] = await pool.execute('INSERT INTO categories (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [category]);
        const categoryId = categoryResult.insertId;
        let imageUrl = null;
        if (req.file) {
            const fileName = `${crypto.randomUUID()}${path.extname(req.file.originalname || '')}`;
            await fs.mkdir(itemImageDirectory, { recursive: true });
            await fs.writeFile(path.join(itemImageDirectory, fileName), req.file.buffer, { flag: 'wx' });
            imageUrl = `/api/menu-items/${fileName}`;
        }
        const [created] = await pool.execute(
            `INSERT INTO menu_items (category_id, name, price, description, image_url, status) VALUES (?, ?, ?, ?, ?, 'in_stock')`,
            [categoryId, name, price.toFixed(2), String(req.body.description || '').slice(0, 255), imageUrl]
        );
        const [rows] = await pool.execute('SELECT id, name, status FROM menu_items WHERE id = ?', [created.insertId]);
        io.emit('menu_item_updated', rows[0]);
        res.status(201).json(rows[0]);
    } catch (error) { next(error); }
});

app.patch('/api/admin/menu-items/:id/availability', requireRole('admin'), async (req, res, next) => {
    try {
        const status = String(req.body.status || '');
        if (!['in_stock', 'out_of_stock', 'out_of_order'].includes(status)) return sendError(res, 400, 'Choose a valid availability status.');
        const [updated] = await pool.execute('UPDATE menu_items SET status = ? WHERE id = ?', [status, req.params.id]);
        if (!updated.affectedRows) return sendError(res, 404, 'Menu item not found.');
        const [rows] = await pool.execute('SELECT id, name, status FROM menu_items WHERE id = ?', [req.params.id]);
        io.emit('menu_item_updated', rows[0]);
        res.json(rows[0]);
    } catch (error) { next(error); }
});

app.param('id', (req, res, next, value) => {
    if (!/^\d{1,10}$/.test(value)) return sendError(res, 400, 'Invalid id.');
    next();
});

app.get('/api/cashier/orders', requireRole('cashier', 'admin'), async (req, res, next) => {
    try {
        const status = String(req.query.status || '');
        if (status && !['pending_approval', 'in_kitchen', 'ready'].includes(status)) return sendError(res, 400, 'Choose a valid order status.');
        // Cash awaits confirmation, transfers await verification, and online payments that are still
        // being confirmed must all stay visible to staff. Only failed or cancelled orders drop out.
        const visiblePayment = `(o.payment_method = 'cash' AND o.payment_status IN ('unpaid', 'pending_approval'))
            OR (o.payment_method IN ('telebirr_transfer', 'cbe_transfer') AND o.payment_status IN ('pending_approval', 'verified', 'paid'))
            OR (o.payment_method = 'digital_aggregator' AND o.payment_status IN ('unpaid', 'processing', 'paid'))`;
        const where = status === 'pending_approval'
            ? `o.status = 'pending_approval' AND (${visiblePayment})`
            : status ? 'o.status = ?' : `(o.status IN ('in_kitchen', 'ready') OR (o.status = 'pending_approval' AND (${visiblePayment})))`;
        const [rows] = await pool.execute(
            `SELECT o.id, o.table_number, o.order_type, o.payment_method, o.payment_status, o.status, o.total_amount, o.created_at,
                    t.status AS table_status, oi.quantity, oi.unit_price, m.name
             FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
             LEFT JOIN menu_items m ON m.id = oi.menu_item_id
             LEFT JOIN restaurant_tables t ON t.table_number = o.table_number
             WHERE ${where} ORDER BY o.created_at DESC, oi.id`,
            status && status !== 'pending_approval' ? [status] : []
        );
        const grouped = new Map();
        for (const row of rows) {
            if (!grouped.has(row.id)) grouped.set(row.id, {
                id: row.id, table_number: row.table_number, table_status: row.table_status || 'available',
                source: row.order_type === 'waiter_assisted' ? 'Waiter' : 'QR menu',
                payment_method: row.payment_method, payment_status: row.payment_status, status: row.status,
                total_amount: Number(row.total_amount), created_at: row.created_at, lines: []
            });
            if (row.name) grouped.get(row.id).lines.push({ name: row.name, quantity: row.quantity, price: Number(row.unit_price) });
        }
        res.json({ orders: [...grouped.values()] });
    } catch (error) { next(error); }
});

app.get('/api/cashier/report', requireRole('cashier', 'admin'), async (req, res, next) => {
    try {
        const requested = String(req.query.date || '').trim();
        if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return sendError(res, 400, 'Choose a valid report date.');
        // Use the database clock so "today" matches the rows, not the time zone of either process.
        // CAST keeps these as plain YYYY-MM-DD strings instead of JS Date objects.
        const [[clock]] = await pool.query('SELECT CAST(CURDATE() AS CHAR) AS today');
        const today = clock.today;
        const [latestRows] = await pool.query(
            "SELECT CAST(DATE_FORMAT(MAX(created_at), '%Y-%m-%d') AS CHAR) AS latest FROM orders WHERE status = 'completed'"
        );
        const latestCompleted = latestRows[0].latest;
        const date = requested || today;
        // Only orders a cashier actually finished count; a completed order is always paid or verified by then.
        const [rows] = await pool.execute(
            `SELECT id, table_number, order_type, payment_method, payment_status, total_amount, created_at
             FROM orders WHERE status = 'completed' AND DATE(created_at) = ? ORDER BY created_at DESC`,
            [date]
        );
        const completed = rows.map(row => ({
            id: row.id,
            table_number: row.table_number,
            source: row.order_type === 'waiter_assisted' ? 'Waiter' : 'QR menu',
            payment_method: row.payment_method,
            payment_status: row.payment_status,
            total_amount: Number(row.total_amount),
            created_at: row.created_at
        }));
        const paidOrders = completed.filter(row => ['paid', 'verified'].includes(row.payment_status));
        const cents = paidOrders.reduce((sum, row) => sum + moneyInCents(row.total_amount), 0);
        const byMethod = {};
        for (const row of paidOrders) byMethod[row.payment_method] = (byMethod[row.payment_method] || 0) + moneyInCents(row.total_amount);
        res.json({
            date,
            today,
            latest_completed_date: latestCompleted || null,
            completed_count: completed.length,
            paid_count: paidOrders.length,
            total_amount: Number((cents / 100).toFixed(2)),
            average_amount: paidOrders.length ? Number((cents / 100 / paidOrders.length).toFixed(2)) : 0,
            by_method: byMethod,
            orders: completed
        });
    } catch (error) { next(error); }
});

app.patch('/api/cashier/orders/:id/verify-payment', requireRole('cashier', 'admin'), async (req, res, next) => {
    const action = String(req.body.action || '');
    if (!['approve', 'reject'].includes(action)) return sendError(res, 400, 'Choose approve or reject.');
    const rejectionReason = String(req.body.rejection_reason || '').trim().slice(0, 255) || null;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [orders] = await connection.execute(
            `SELECT table_number FROM orders WHERE id = ? AND payment_method IN ('telebirr_transfer', 'cbe_transfer')
             AND payment_status = 'pending_approval' AND status = 'pending_approval' FOR UPDATE`,
            [req.params.id]
        );
        if (!orders.length) {
            await connection.rollback();
            return sendError(res, 409, 'This transfer is no longer awaiting verification.');
        }
        const nextPaymentStatus = action === 'approve' ? 'verified' : 'rejected';
        const nextStatus = action === 'approve' ? 'in_kitchen' : 'cancelled';
        await connection.execute(
            'UPDATE orders SET payment_status = ?, status = ?, rejection_reason = ? WHERE id = ?',
            [nextPaymentStatus, nextStatus, action === 'reject' ? rejectionReason : null, req.params.id]
        );
        if (action === 'reject') {
            const [activeOrders] = await connection.execute(
                `SELECT COUNT(*) AS count FROM orders WHERE table_number = ? AND id <> ?
                 AND status IN ('pending_approval', 'in_kitchen', 'ready')`,
                [orders[0].table_number, req.params.id]
            );
            if (activeOrders[0].count === 0) {
                await connection.execute("UPDATE restaurant_tables SET status = 'available' WHERE table_number = ? AND status = 'occupied'", [orders[0].table_number]);
            }
        }
        await connection.commit();
        const order = await readOrder(req.params.id);
        io.to('staff').emit('order_status_updated', { id: order.id, status: order.status, payment_status: order.payment_status });
        if (action === 'approve') {
            io.to('staff').emit('new_order', order);
            io.to('staff').emit('order_verified', order);
        }
        res.json(order);
    } catch (error) {
        await connection.rollback().catch(() => { });
        next(error);
    } finally { connection.release(); }
});

app.patch('/api/cashier/orders/:id/approve', requireRole('cashier', 'admin'), async (req, res, next) => {
    try {
        const [updated] = await pool.execute(
            `UPDATE orders SET payment_status = 'paid', status = 'in_kitchen'
             WHERE id = ? AND payment_method = 'cash' AND payment_status = 'unpaid' AND status = 'pending_approval'`,
            [req.params.id]
        );
        if (!updated.affectedRows) return sendError(res, 409, 'This cash order is no longer awaiting cashier approval.');
        const order = await readOrder(req.params.id);
        io.to('staff').emit('order_status_updated', { id: order.id, status: order.status, payment_status: order.payment_status });
        res.json(order);
    } catch (error) { next(error); }
});

app.patch('/api/cashier/orders/:id/advance', requireRole('cashier', 'admin'), async (req, res, next) => {
    try {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const [rows] = await connection.execute('SELECT status, table_number FROM orders WHERE id = ? FOR UPDATE', [req.params.id]);
            if (!rows.length || !['in_kitchen', 'ready'].includes(rows[0].status)) {
                await connection.rollback();
                return sendError(res, 409, 'This order cannot advance from its current status.');
            }
            const status = rows[0].status === 'in_kitchen' ? 'ready' : 'completed';
            await connection.execute('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
            if (status === 'completed') {
                const [activeOrders] = await connection.execute(
                    `SELECT COUNT(*) AS count FROM orders WHERE table_number = ? AND id <> ?
                     AND status IN ('pending_approval', 'in_kitchen', 'ready')`,
                    [rows[0].table_number, req.params.id]
                );
                if (activeOrders[0].count === 0) {
                    await connection.execute("UPDATE restaurant_tables SET status = 'available' WHERE table_number = ? AND status = 'occupied'", [rows[0].table_number]);
                }
            }
            await connection.commit();
            io.to('staff').emit('order_status_updated', { id: Number(req.params.id), status });
            res.json({ id: Number(req.params.id), status });
        } catch (error) {
            await connection.rollback().catch(() => { });
            throw error;
        } finally { connection.release(); }
    } catch (error) { next(error); }
});

app.get('/', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(root, 'index.html')));
app.get('/app.js', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(root, 'app.js')));
app.get('/app.css', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(root, 'app.css')));
app.use((req, res) => sendError(res, 404, 'Not found.'));
app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    const status = Number(error.status) || 500;
    res.status(status).json({ error: status < 500 ? error.message : 'Server error. Check the server log.' });
});

async function start() {
    if (sessionSecret.length < 32 || sessionSecret.startsWith('replace-with-')) {
        if (process.env.NODE_ENV === 'production') throw new Error('Set SESSION_SECRET in .env to a random value of at least 32 characters.');
        sessionSecret = crypto.randomBytes(48).toString('base64url');
        console.warn('SESSION_SECRET is unset or a placeholder; generated an ephemeral development secret. Staff sessions reset when the server restarts.');
    }
    if (!publicBaseUrl.startsWith('https://')) console.warn('PUBLIC_BASE_URL is not https: Chapa cannot send customers back or call the webhook. Use an HTTPS tunnel for payment tests.');
    await pool.query('SELECT 1');
    await bootstrapStaff();
    await cancelAbandonedOrders().catch(error => console.error('Cleanup failed:', error.message));
    setInterval(() => cancelAbandonedOrders().catch(error => console.error('Cleanup failed:', error.message)), 5 * 60 * 1000).unref();
    const host = process.env.HOST || '127.0.0.1';
    try {
        await new Promise((resolve, reject) => {
            const onError = error => reject(error);
            server.once('error', onError);
            server.listen(port, host, () => {
                server.off('error', onError);
                resolve();
            });
        });
        console.log(`SEBA CAFE API listening at http://localhost:${port}`);
    } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        try {
            const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
            const health = await healthResponse.json();
            if (healthResponse.ok && health.status === 'ok') {
                console.log(`SEBA CAFE is already running at http://localhost:${port}`);
                await pool.end();
                return;
            }
        } catch { }
        await pool.end();
        throw new Error(`Port ${port} is already in use. Stop that process or set PORT to another value, such as 3001.`);
    }
}

if (require.main === module) {
    start().catch(error => {
        console.error(`Startup failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { app, pool, start };
