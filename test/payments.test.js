const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chargeWasInitiated, moneyInCents, normalizeEthiopianMobile, verificationMatches, webhookSignatureIsValid } = require('../payments');

test('normalizes Ethiopian mobile numbers', () => {
    assert.equal(normalizeEthiopianMobile('0912 345 678'), '0912345678');
    assert.equal(normalizeEthiopianMobile('+251712345678'), '251712345678');
    assert.equal(normalizeEthiopianMobile('0612345678'), null);
});

test('converts money to cents safely', () => {
    assert.equal(moneyInCents('680.00'), 68000);
    assert.ok(Number.isNaN(moneyInCents('abc')));
});

test('accepts only matching successful verification', () => {
    const payload = { status: 'success', data: { status: 'SUCCESS', merchant_reference: 'seba-1', amount: 68000, currency: 'ETB' } };
    assert.equal(verificationMatches(payload, 'seba-1', '680.00'), true);
    assert.equal(verificationMatches(payload, 'seba-2', '680.00'), false);
    assert.equal(verificationMatches(payload, 'seba-1', '700.00'), false);
});

test('validates webhook signatures', () => {
    const secret = 'test-secret';
    const raw = Buffer.from('{"tx_ref":"seba-1"}');
    const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    assert.equal(webhookSignatureIsValid(secret, raw, {}, { 'x-chapa-signature': signature }), true);
    assert.equal(webhookSignatureIsValid(secret, raw, {}, { 'x-chapa-signature': 'abcd' }), false);
    assert.equal(webhookSignatureIsValid('', raw, {}, {}), false);
});

test('detects initiated charges', () => {
    assert.equal(chargeWasInitiated({ status: 'success', data: { status: 'pending' } }), true);
    assert.equal(chargeWasInitiated({ status: 'success', data: { status: 'failed' } }), false);
});

test('supports Ethiopian wallets and Chapa hosted checkout', () => {
    const { isSupportedChannel, checkoutWasCreated, MINIMUM_ETB } = require('../payments');
    for (const channel of ['telebirr', 'cbebirr', 'ebirr', 'mpesa', 'awashbirr', 'chapa']) assert.equal(isSupportedChannel(channel), true);
    assert.equal(isSupportedChannel('paypal'), false);
    assert.equal(MINIMUM_ETB.mpesa, 20);
    assert.equal(checkoutWasCreated({ status: 'success', data: { checkout_url: 'https://checkout.chapa.global/CH0Vn2VASWCi' } }), true);
    assert.equal(checkoutWasCreated({ status: 'success', data: { checkout_url: 'http://evil.example' } }), false);
});
