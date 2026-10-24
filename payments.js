const crypto = require('node:crypto');

function safeHexEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f\d]+$/i.test(left) || !/^[a-f\d]+$/i.test(right)) return false;
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function webhookSignatureIsValid(secret, rawBody, body, headers) {
    if (!secret) return false;
    const payloads = new Set([
        Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : '',
        JSON.stringify(body ?? {})
    ]);
    const payloadSignatures = [...payloads].map(payload => crypto.createHmac('sha256', secret).update(payload).digest('hex'));
    const secretSignature = crypto.createHmac('sha256', secret).update(secret).digest('hex');
    const providedPayload = headers['x-chapa-signature'];
    const providedSecret = headers['chapa-signature'];
    return payloadSignatures.some(signature => safeHexEqual(providedPayload, signature)) || safeHexEqual(providedSecret, secretSignature);
}

function moneyInCents(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}

function normalizeEthiopianMobile(value) {
    const mobile = String(value ?? '').replace(/[\s()+-]/g, '');
    return /^(?:0[79]\d{8}|251[79]\d{8})$/.test(mobile) ? mobile : null;
}

function chargeWasInitiated(payload) {
    const responseStatus = String(payload?.status ?? '').toLowerCase();
    const transactionStatus = String(payload?.data?.status ?? '').toLowerCase();
    return responseStatus === 'success' && !['failed', 'error', 'cancelled'].includes(transactionStatus);
}

function verificationMatches(payload, expectedReference, expectedAmount) {
    const data = payload?.data ?? {};
    const status = String(data.status ?? payload?.status ?? '').toLowerCase();
    const reference = data.tx_ref ?? data.trx_ref ?? payload?.tx_ref ?? payload?.trx_ref;
    const amount = data.amount ?? payload?.amount;
    const currency = String(data.currency ?? payload?.currency ?? '').toUpperCase();
    return status === 'success'
        && reference === expectedReference
        && currency === 'ETB'
        && moneyInCents(amount) === moneyInCents(expectedAmount);
}

// Chapa v2 (api.chapa.global) exposes hosted checkout only. The legacy v1 direct-charge
// endpoints are not available to v2 keys, so every channel below is a payment method
// preference passed to the hosted page rather than a server-side phone prompt.
const DIRECT_CHANNELS = { telebirr: 'Telebirr', cbebirr: 'CBE Birr', ebirr: 'Coopay-Ebirr', mpesa: 'M-Pesa', awashbirr: 'Awash Birr' };
const HOSTED_CHANNEL = 'chapa';
const MINIMUM_ETB = { mpesa: 20, chapa: 10 };
const CHAPA_REFERENCE_MAX_LENGTH = 20;

function isSupportedChannel(channel) {
    return Object.hasOwn(DIRECT_CHANNELS, channel) || channel === HOSTED_CHANNEL;
}

function checkoutWasCreated(payload) {
    const url = payload?.data?.checkout_url;
    return String(payload?.status ?? '').toLowerCase() === 'success' && typeof url === 'string' && /^https:\/\//.test(url);
}

// v2 takes integer minor units (cents), not a decimal string.
function amountInMinorUnits(value) {
    const cents = moneyInCents(value);
    if (!Number.isFinite(cents) || cents < 100) return null;
    return Math.round(cents);
}

// v2 caps merchant_reference at 20 characters and rejects longer values.
function merchantReference(prefix, random = crypto.randomUUID()) {
    const compact = String(random).replace(/-/g, '');
    return `${prefix}-${compact}`.slice(0, CHAPA_REFERENCE_MAX_LENGTH);
}

// v2 requires E.164 without the leading '+': 2519712345678
function chapaPhoneNumber(value) {
    const mobile = normalizeEthiopianMobile(value);
    if (!mobile) return null;
    return mobile.startsWith('0') ? `251${mobile.slice(1)}` : mobile;
}

function hostedPaymentBody({ amount, reference, email, firstName, lastName, phone, channel, callbackUrl, returnUrl, orderId, tableNumber }) {
    return {
        amount: amountInMinorUnits(amount),
        currency: 'ETB',
        merchant_reference: reference,
        preferred_payment_methods: [channel],
        customer: {
            first_name: firstName || 'Guest',
            last_name: lastName || 'Customer',
            ...(email ? { email } : {}),
            ...(phone ? { phone_number: phone } : {})
        },
        callback_url: callbackUrl,
        return_url: returnUrl,
        meta: { order_id: String(orderId) },
        customization: { title: 'Seba Cafe', description: `Order ${orderId} Table ${tableNumber}` }
    };
}

// v2 verification reports status in upper case and an amount already expressed in minor
// units, so an integer response is compared directly instead of being scaled again.
function verificationMatches(payload, expectedReference, expectedAmount) {
    const data = payload?.data ?? {};
    const status = String(data.status ?? payload?.status ?? '').toUpperCase();
    const reference = data.merchant_reference ?? data.tx_ref ?? data.trx_ref ?? payload?.merchant_reference ?? payload?.tx_ref;
    const amount = data.amount ?? payload?.amount;
    const currency = String(data.currency ?? payload?.currency ?? '').toUpperCase();
    const amountInCents = typeof amount === 'number' && Number.isInteger(amount) ? amount : moneyInCents(amount);
    return status === 'SUCCESS'
        && reference === expectedReference
        && currency === 'ETB'
        && amountInCents === moneyInCents(expectedAmount);
}

module.exports = { DIRECT_CHANNELS, HOSTED_CHANNEL, MINIMUM_ETB, CHAPA_REFERENCE_MAX_LENGTH, isSupportedChannel, amountInMinorUnits, merchantReference, chapaPhoneNumber, hostedPaymentBody, checkoutWasCreated, chargeWasInitiated, moneyInCents, normalizeEthiopianMobile, verificationMatches, webhookSignatureIsValid };