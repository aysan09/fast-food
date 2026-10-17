const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chargeWasInitiated, moneyInCents, normalizeEthiopianMobile, verificationMatches, webhookSignatureIsValid } = require('../payments');

test('webhook signature accepts the exact Chapa event body', () => {
    const secret = 'test-webhook-secret';
    const body = { event: 'charge.success', tx_ref: 'ember-test', amount: '680.00' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    assert.equal(webhookSignatureIsValid(secret, rawBody, body, { 'x-chapa-signature': signature }), true);
});

test('webhook signature rejects modified payloads', () => {
    const secret = 'test-webhook-secret';
    const body = { event: 'charge.success', tx_ref: 'ember-test' };
    const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
    assert.equal(webhookSignatureIsValid(secret, Buffer.from('{"event":"charge.success"}'), body, { 'x-chapa-signature': signature }), true);
    assert.equal(webhookSignatureIsValid(secret, Buffer.from('{"event":"charge.failed"}'), { ...body, event: 'charge.failed' }, { 'x-chapa-signature': signature }), false);
});

test('payment verification requires matching reference, ETB currency, and amount', () => {
    const response = { status: 'success', data: { status: 'success', tx_ref: 'ember-test', currency: 'ETB', amount: '680.00' } };
    assert.equal(verificationMatches(response, 'ember-test', 680), true);
    assert.equal(verificationMatches(response, 'another-ref', 680), false);
    assert.equal(verificationMatches({ ...response, data: { ...response.data, amount: '679.99' } }, 'ember-test', 680), false);
    assert.equal(verificationMatches({ ...response, data: { ...response.data, currency: 'USD' } }, 'ember-test', 680), false);
});

test('ETB amounts compare at cent precision', () => {
    assert.equal(moneyInCents('680.00'), 68000);
    assert.equal(moneyInCents('invalid'), Number.NaN);
});

test('direct-charge initiation accepts Ethiopian mobile formats only', () => {
    assert.equal(normalizeEthiopianMobile('0912345678'), '0912345678');
    assert.equal(normalizeEthiopianMobile('+251 91 234 5678'), '251912345678');
    assert.equal(normalizeEthiopianMobile('123456'), null);
});

test('direct-charge initiation must be accepted by Chapa and not terminally failed', () => {
    assert.equal(chargeWasInitiated({ status: 'success', data: { status: 'pending' } }), true);
    assert.equal(chargeWasInitiated({ status: 'success', data: { status: 'failed' } }), false);
    assert.equal(chargeWasInitiated({ status: 'failed' }), false);
});