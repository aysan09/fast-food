const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    CHAPA_REFERENCE_MAX_LENGTH,
    amountInMinorUnits,
    chapaPhoneNumber,
    checkoutWasCreated,
    hostedPaymentBody,
    isSupportedChannel,
    merchantReference,
    moneyInCents,
    normalizeEthiopianMobile,
    verificationMatches,
    webhookSignatureIsValid
} = require('../payments');

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
    const response = { status: 'success', data: { status: 'SUCCESS', merchant_reference: 'ember-test', currency: 'ETB', amount: 68000 } };
    assert.equal(verificationMatches(response, 'ember-test', 680), true);
    assert.equal(verificationMatches(response, 'another-ref', 680), false);
    assert.equal(verificationMatches({ ...response, data: { ...response.data, amount: 67999 } }, 'ember-test', 680), false);
    assert.equal(verificationMatches({ ...response, data: { ...response.data, currency: 'USD' } }, 'ember-test', 680), false);
    assert.equal(verificationMatches({ ...response, data: { ...response.data, status: 'PENDING' } }, 'ember-test', 680), false);
});

test('ETB amounts compare at cent precision', () => {
    assert.equal(moneyInCents('680.00'), 68000);
    assert.equal(moneyInCents(68000), 6800000);
    assert.equal(moneyInCents('invalid'), Number.NaN);
});

test('v2 amounts are sent as integer minor units', () => {
    assert.equal(amountInMinorUnits('980.00'), 98000);
    assert.equal(amountInMinorUnits(680), 68000);
    assert.equal(amountInMinorUnits('9.80'), 980);
    // Below Chapa's 100 minor-unit minimum.
    assert.equal(amountInMinorUnits('0.99'), null);
});

test('mobile numbers are normalised to Chapa E.164 digits', () => {
    assert.equal(normalizeEthiopianMobile('0912345678'), '0912345678');
    assert.equal(chapaPhoneNumber('0912345678'), '251912345678');
    assert.equal(chapaPhoneNumber('+251 91 234 5678'), '251912345678');
    assert.equal(chapaPhoneNumber('123456'), null);
});

test('merchant references stay within the v2 20 character limit', () => {
    const reference = merchantReference('seba');
    assert.ok(reference.length <= CHAPA_REFERENCE_MAX_LENGTH, reference);
    assert.match(reference, /^seba-/);
    assert.equal(merchantReference('seba', 'a'.repeat(40)).length, CHAPA_REFERENCE_MAX_LENGTH);
});

test('hosted checkout payload matches the v2 shape', () => {
    const body = hostedPaymentBody({
        amount: '980.00',
        reference: 'seba-abc',
        email: 'guest@example.com',
        firstName: 'Abebe',
        lastName: 'Kebede',
        phone: '251912345678',
        channel: 'telebirr',
        callbackUrl: 'https://example.com/cb',
        returnUrl: 'https://example.com/ret',
        orderId: 42,
        tableNumber: '07'
    });
    assert.equal(body.amount, 98000);
    assert.equal(body.currency, 'ETB');
    assert.equal(body.merchant_reference, 'seba-abc');
    assert.deepEqual(body.preferred_payment_methods, ['telebirr']);
    assert.equal(body.customer.phone_number, '251912345678');
    assert.equal(body.customer.email, 'guest@example.com');
    assert.equal(body.meta.order_id, '42');
    assert.equal(body.callback_url, 'https://example.com/cb');
    assert.equal(body.tx_ref, undefined);
});

test('hosted checkout accepts only https URLs from a success response', () => {
    const success = { status: 'success', data: { checkout_url: 'https://checkout.chapa.global/CH0Vn2VASWCi' } };
    const insecure = { status: 'success', data: { checkout_url: 'http://evil.example' } };
    const expired = { status: 'error', message: 'API key has expired' };
    assert.equal(checkoutWasCreated(success), true);
    assert.equal(checkoutWasCreated(insecure), false);
    assert.equal(checkoutWasCreated(expired), false);
});

test('supported channels stay limited to wallets and hosted checkout', () => {
    for (const channel of ['telebirr', 'cbebirr', 'ebirr', 'mpesa', 'awashbirr', 'chapa']) assert.equal(isSupportedChannel(channel), true);
    assert.equal(isSupportedChannel('paypal'), false);
});
