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

module.exports = { chargeWasInitiated, moneyInCents, normalizeEthiopianMobile, verificationMatches, webhookSignatureIsValid };