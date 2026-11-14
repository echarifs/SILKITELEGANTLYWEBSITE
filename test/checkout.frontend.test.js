import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountCheckout } from '../src/checkout.js';

const CART_MARKUP = readFileSync(new URL('../src/cart-modal.html', import.meta.url), 'utf8');

const PROFILE_WITH_ADDRESS = {
  name: 'Amal Weaver',
  email: 'amal@example.invalid',
  phone: '+212612345678',
  addressLine1: '12 Silk Road',
  addressLine2: 'Riad wing',
  city: 'Nouakchott',
  postalCode: '0000',
  country: 'MR',
};

const PROFILE_WITHOUT_ADDRESS = {
  name: 'Amal Weaver',
  email: 'amal@example.invalid',
  phone: '+212612345678',
  addressLine1: null,
  addressLine2: null,
  city: null,
  postalCode: null,
  country: null,
};

const PROFILE_WITHOUT_ADDRESS_AND_PHONE = {
  name: 'Amal Weaver',
  email: 'amal@example.invalid',
  phone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postalCode: null,
  country: null,
};

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('DOM request did not finish');
}

function setup({ user }) {
  const dom = new JSDOM('<!doctype html>', { url: 'https://shop.example.invalid/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.FormData = dom.window.FormData;
  globalThis.HTMLFormElement = dom.window.HTMLFormElement;
  document.body.innerHTML = CART_MARKUP;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ url: path, body: options.body ? JSON.parse(options.body) : null });
    if (path.endsWith('/api/auth/csrf')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'c'.repeat(64) }) };
    if (path.endsWith('/api/auth/me')) return { ok: Boolean(user), status: user ? 200 : 401, json: async () => ({ user }) };
    if (path.endsWith('/api/payments/checkout')) {
      return { ok: true, status: 201, json: async () => ({
        orderId: 'test-order-id-1',
        orderReference: 'TESTORDER1',
        amountMinor: 8500,
        currency: 'EUR',
        token: 'token_test_123',
        publicKey: 'pub_test_123',
        mode: 'sandbox',
      }) };
    }
    if (path.endsWith('/api/payments/shipping-details')) return { ok: true, status: 200, json: async () => ({ saved: true }) };
    if (path.endsWith('/api/auth/address')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`Unexpected fetch ${path}`);
  };
  // Fake provider SDK so no network script is fetched and confirm always succeeds.
  dom.window.yp = () => ({
    elements: () => ({
      on: (event, callback) => { if (event === 'ready') callback(); },
      mount: async () => {},
      destroy: async () => {},
      confirm: async () => ({ status: 'succeeded' }),
    }),
  });
  return { dom, requests };
}

function makeCart() {
  const items = [
    { key: 'mauve-mist:Small', productId: 'mauve-mist', option: 'Small', quantity: 1, price: 85, productName: 'Mauve Mist' },
    { key: 'amber-dune:Large', productId: 'amber-dune', option: 'Large', quantity: 2, price: 60, productName: 'Amber Dune' },
  ];
  return {
    getItems: () => items.slice(),
    removeItem: (key) => {
      const index = items.findIndex((item) => item.key === key);
      if (index >= 0) items.splice(index, 1);
    },
    getTotal: () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
  };
}

function mount() {
  mountCheckout({
    cart: makeCart(),
    formatCurrency: (value) => `€${value}`,
    showToast: () => {},
    updateCartCount: () => {},
    renderCartItems: () => {},
  });
}

function submit(form, dom) {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

async function reachPaymentStage({ dom, requests }, user) {
  mount();
  document.querySelector('.checkout-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-panel').hidden);
  if (user) {
    await waitUntil(() => document.querySelector('.checkout-details-form input[name="customerName"]').value === 'Amal Weaver');
  } else {
    const form = document.querySelector('.checkout-details-form');
    form.querySelector('input[name="customerName"]').value = 'Guest Weaver';
    form.querySelector('input[name="customerEmail"]').value = 'guest@example.invalid';
  }
  submit(document.querySelector('.checkout-details-form'), dom);
  await waitUntil(() => !document.querySelector('.checkout-confirm-btn').disabled);
  return requests.find(({ url }) => url.endsWith('/api/payments/checkout')).body;
}

test('signed-in checkout shows a summary with a pen, then ships the saved address', async () => {
  const { dom, requests } = setup({ user: PROFILE_WITH_ADDRESS });
  mount();
  document.querySelector('.checkout-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-panel').hidden);
  await waitUntil(() => document.querySelector('[data-checkout-identity]').hidden === false);
  // Signed-in customers see a summary with a pen instead of the raw fields.
  const detailsForm = document.querySelector('.checkout-details-form');
  const identity = document.querySelector('[data-checkout-identity]');
  const summary = document.querySelector('[data-checkout-account-summary]');
  const pen = document.querySelector('[data-checkout-identity-pen]');
  assert.equal(summary.textContent, 'Ordering as Amal Weaver (amal@example.invalid) · +212612345678');
  assert.notEqual(pen.querySelector('svg'), null);
  assert.equal(detailsForm.querySelector('input[name="customerName"]').closest('label').hidden, true);
  assert.equal(detailsForm.querySelector('input[name="customerEmail"]').closest('label').hidden, true);
  assert.equal(detailsForm.querySelector('.checkout-phone-field').hidden, true);

  // The pen reopens the fields for verification or correction.
  pen.click();
  assert.equal(identity.hidden, true);
  assert.equal(detailsForm.querySelector('input[name="customerName"]').closest('label').hidden, false);
  assert.equal(detailsForm.querySelector('input[name="customerEmail"]').closest('label').hidden, false);
  assert.equal(detailsForm.querySelector('.checkout-phone-field').hidden, false);
  assert.equal(detailsForm.querySelector('input[name="customerPhone"]').value, '06 12 34 56 78');

  submit(detailsForm, dom);
  await waitUntil(() => !document.querySelector('.checkout-confirm-btn').disabled);
  const checkoutRequest = requests.find(({ url }) => url.endsWith('/api/payments/checkout')).body;
  assert.deepEqual(checkoutRequest.customer, { name: 'Amal Weaver', email: 'amal@example.invalid', phone: '+212612345678' });
  assert.deepEqual(checkoutRequest.shipping, { line1: '12 Silk Road', line2: 'Riad wing', city: 'Nouakchott', postalCode: '0000', country: 'MR' });

  document.querySelector('.checkout-confirm-btn').click();
  await waitUntil(() => document.querySelector('.checkout-status').textContent.includes('Payment confirmed for order TESTORDER1'));
  assert.equal(document.querySelector('.checkout-shipping-stage').hidden, true);
  assert.match(document.querySelector('.checkout-status').textContent, /delivery details are saved/u);
  dom.window.close();
});

test('guests must complete the mandatory delivery step after payment', async () => {
  const { dom, requests } = setup({ user: null });
  const checkoutRequest = await reachPaymentStage({ dom, requests }, null);
  assert.equal(checkoutRequest.shipping, undefined);
  assert.deepEqual(checkoutRequest.customer, { name: 'Guest Weaver', email: 'guest@example.invalid', phone: null });

  document.querySelector('.checkout-confirm-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-shipping-stage').hidden);
  assert.match(document.querySelector('.checkout-status').textContent, /add the delivery details/u);
  // The step is mandatory: no way back to the cart before completing it.
  assert.equal(document.querySelector('.checkout-back').hidden, true);
  // Guests cannot save an address to an account.
  assert.equal(document.querySelector('[data-checkout-save-account]').hidden, true);

  const shippingForm = document.querySelector('.checkout-shipping-form');
  shippingForm.querySelector('input[name="shippingLine1"]').value = '1 Harbour Road';
  shippingForm.querySelector('input[name="shippingCity"]').value = 'Paris';
  shippingForm.querySelector('input[name="shippingPostalCode"]').value = '75001';
  shippingForm.querySelector('select[name="shippingCountry"]').value = 'FR';
  shippingForm.querySelector('[data-phone-country="shippingPhone"]').value = 'MA';
  shippingForm.querySelector('input[name="shippingPhone"]').value = '0612345678';
  submit(shippingForm, dom);
  await waitUntil(() => document.querySelector('.checkout-status').textContent.includes('Payment confirmed for order TESTORDER1'));
  assert.equal(document.querySelector('.checkout-shipping-stage').hidden, true);
  const payload = requests.find(({ url }) => url.endsWith('/api/payments/shipping-details')).body;
  assert.deepEqual(payload, {
    orderId: 'test-order-id-1',
    email: 'guest@example.invalid',
    line1: '1 Harbour Road',
    line2: '',
    city: 'Paris',
    postalCode: '75001',
    country: 'FR',
    phone: '+212612345678',
  });
  // Guests never touch the account address endpoint.
  assert.equal(requests.some(({ url }) => url.endsWith('/api/auth/address')), false);
  dom.window.close();
});

test('signed-in customers without a saved address can store the delivery address on their account', async () => {
  const { dom, requests } = setup({ user: PROFILE_WITHOUT_ADDRESS });
  const checkoutRequest = await reachPaymentStage({ dom, requests }, PROFILE_WITHOUT_ADDRESS);
  assert.equal(checkoutRequest.shipping, undefined);
  // The summary replaces the fields here as well.
  assert.equal(document.querySelector('[data-checkout-identity]').hidden, false);
  assert.equal(document.querySelector('[data-checkout-account-summary]').textContent,
    'Ordering as Amal Weaver (amal@example.invalid) · +212612345678');

  document.querySelector('.checkout-confirm-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-shipping-stage').hidden);
  const saveBox = document.querySelector('[data-checkout-save-account]');
  assert.equal(saveBox.hidden, false);
  assert.equal(saveBox.querySelector('input[name="saveAddressToAccount"]').checked, true);
  // The order already carries the profile phone, so no second phone is requested.
  assert.equal(document.querySelector('[data-checkout-shipping-phone]').hidden, true);

  const shippingForm = document.querySelector('.checkout-shipping-form');
  shippingForm.querySelector('input[name="shippingLine1"]').value = '9 Oasis Lane';
  shippingForm.querySelector('input[name="shippingCity"]').value = 'Nouakchott';
  shippingForm.querySelector('input[name="shippingPostalCode"]').value = '0000';
  shippingForm.querySelector('select[name="shippingCountry"]').value = 'MR';
  submit(shippingForm, dom);
  await waitUntil(() => document.querySelector('.checkout-status').textContent.includes('Payment confirmed for order TESTORDER1'));
  assert.deepEqual(requests.find(({ url }) => url.endsWith('/api/auth/address')).body, {
    addressLine1: '9 Oasis Lane',
    addressLine2: '',
    city: 'Nouakchott',
    postalCode: '0000',
    country: 'MR',
  });
  assert.ok(requests.some(({ url }) => url.endsWith('/api/auth/csrf')), 'CSRF token requested before saving to the account');
  dom.window.close();
});

test('a signed-in customer without a stored phone sees it in the summary and adds one', async () => {
  const { dom, requests } = setup({ user: PROFILE_WITHOUT_ADDRESS_AND_PHONE });
  const checkoutRequest = await reachPaymentStage({ dom, requests }, PROFILE_WITHOUT_ADDRESS_AND_PHONE);
  // The summary skips the missing phone; the phone field stays for it.
  assert.equal(document.querySelector('[data-checkout-account-summary]').textContent,
    'Ordering as Amal Weaver (amal@example.invalid)');
  assert.equal(document.querySelector('.checkout-details-form .checkout-phone-field').hidden, false);
  assert.equal(checkoutRequest.customer.phone, null);

  document.querySelector('.checkout-confirm-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-shipping-stage').hidden);
  // With no phone on the order, the delivery step asks for one.
  assert.equal(document.querySelector('[data-checkout-shipping-phone]').hidden, false);
  const shippingForm = document.querySelector('.checkout-shipping-form');
  shippingForm.querySelector('input[name="shippingLine1"]').value = '9 Oasis Lane';
  shippingForm.querySelector('input[name="shippingCity"]').value = 'Nouakchott';
  shippingForm.querySelector('input[name="shippingPostalCode"]').value = '0000';
  shippingForm.querySelector('select[name="shippingCountry"]').value = 'MR';
  shippingForm.querySelector('[data-phone-country="shippingPhone"]').value = 'MR';
  shippingForm.querySelector('input[name="shippingPhone"]').value = '46123456';
  submit(shippingForm, dom);
  await waitUntil(() => document.querySelector('.checkout-status').textContent.includes('Payment confirmed for order TESTORDER1'));
  const payload = requests.find(({ url }) => url.endsWith('/api/payments/shipping-details')).body;
  assert.equal(payload.phone, '+22246123456');
  dom.window.close();
});

test('the delivery step refuses to save until every required field is complete', async () => {
  const { dom, requests } = setup({ user: null });
  await reachPaymentStage({ dom, requests }, null);
  document.querySelector('.checkout-confirm-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-shipping-stage').hidden);

  const shippingForm = document.querySelector('.checkout-shipping-form');
  shippingForm.querySelector('input[name="shippingLine1"]').value = '1 Harbour Road';
  // City, postal code, and country are still empty.
  submit(shippingForm, dom);
  assert.match(document.querySelector('.checkout-status').textContent, /complete every delivery field/u);
  assert.equal(requests.some(({ url }) => url.endsWith('/api/payments/shipping-details')), false);
  dom.window.close();
});
