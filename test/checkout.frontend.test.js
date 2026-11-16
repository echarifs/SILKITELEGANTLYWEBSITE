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
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  document.body.innerHTML = CART_MARKUP;
  const requests = [];
  const state = { user };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: path, body });
    if (path.endsWith('/api/auth/csrf')) return { ok: true, status: 200, json: async () => ({ csrfToken: 'c'.repeat(64) }) };
    if (path.endsWith('/api/auth/me')) return { ok: Boolean(state.user), status: state.user ? 200 : 401, json: async () => ({ user: state.user }) };
    if (path.endsWith('/api/payments/checkout')) {
      if (body?.paymentMethod === 'cod') {
        return { ok: true, status: 201, json: async () => ({
          orderId: 'test-order-id-cod-1',
          orderReference: 'CODORDER1',
          amountMinor: 20500,
          currency: 'MAD',
          mode: 'cod',
        }) };
      }
      return { ok: true, status: 201, json: async () => ({
        orderId: 'test-order-id-1',
        orderReference: 'TESTORDER1',
        amountMinor: 20500,
        currency: 'MAD',
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
  return { dom, requests, signIn: (nextUser) => { state.user = nextUser; } };
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
  const cart = makeCart();
  mountCheckout({
    cart,
    formatCurrency: (value) => `€${value}`,
    showToast: () => {},
    updateCartCount: () => {},
    renderCartItems: () => {},
  });
  return cart;
}

function submit(form, dom) {
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

async function openCheckoutPanel() {
  const cart = mount();
  document.querySelector('.checkout-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-panel').hidden);
  return cart;
}

function fillDeliveryFields(form, { line1 = '1 Harbour Road', city = 'Paris', postalCode = '75001', country = 'FR' } = {}) {
  form.querySelector('input[name="shippingLine1"]').value = line1;
  form.querySelector('input[name="shippingCity"]').value = city;
  form.querySelector('input[name="shippingPostalCode"]').value = postalCode;
  form.querySelector('select[name="shippingCountry"]').value = country;
}

function fillGuestContact(form) {
  form.querySelector('input[name="customerName"]').value = 'Guest Weaver';
  form.querySelector('input[name="customerEmail"]').value = 'guest@example.invalid';
  form.querySelector('[data-phone-country="customerPhone"]').value = 'MA';
  form.querySelector('input[name="customerPhone"]').value = '0612345678';
}

test('signed-in checkout shows identity and address summaries with pens, then confirms a cash-on-delivery order', async () => {
  const { dom, requests } = setup({ user: PROFILE_WITH_ADDRESS });
  const cart = await openCheckoutPanel();
  await waitUntil(() => document.querySelector('[data-checkout-identity]').hidden === false);
  await waitUntil(() => document.querySelector('[data-checkout-address]').hidden === false);

  const detailsForm = document.querySelector('.checkout-details-form');
  assert.equal(document.querySelector('[data-checkout-account-summary]').textContent,
    'Ordering as Amal Weaver (amal@example.invalid) · +212612345678');
  assert.equal(document.querySelector('[data-checkout-address-summary]').textContent,
    'Delivering to: 12 Silk Road, Riad wing, Nouakchott 0000, Mauritania');
  // Both summaries replace the raw fields.
  assert.equal(detailsForm.querySelector('input[name="customerName"]').closest('label').hidden, true);
  assert.equal(detailsForm.querySelector('input[name="customerEmail"]').closest('label').hidden, true);
  assert.equal(detailsForm.querySelector('.checkout-phone-field').hidden, true);
  assert.equal(detailsForm.querySelector('input[name="shippingLine1"]').closest('label').hidden, true);
  assert.equal(detailsForm.querySelector('select[name="shippingCountry"]').hidden, true);

  // The address pen reopens the delivery fields for verification.
  document.querySelector('[data-checkout-address-pen]').click();
  assert.equal(document.querySelector('[data-checkout-address]').hidden, true);
  assert.equal(detailsForm.querySelector('input[name="shippingLine1"]').closest('label').hidden, false);
  assert.equal(detailsForm.querySelector('select[name="shippingCountry"]').hidden, false);

  submit(detailsForm, dom);
  await waitUntil(() => !document.querySelector('.checkout-order-stage').hidden);
  const checkoutRequest = requests.find(({ url }) => url.endsWith('/api/payments/checkout')).body;
  assert.equal(checkoutRequest.paymentMethod, 'cod');
  assert.deepEqual(checkoutRequest.customer, { name: 'Amal Weaver', email: 'amal@example.invalid', phone: '+212612345678' });
  assert.deepEqual(checkoutRequest.shipping, { line1: '12 Silk Road', line2: 'Riad wing', city: 'Nouakchott', postalCode: '0000', country: 'MR' });
  assert.equal(cart.getItems().length, 0, 'a confirmed cash-on-delivery order empties the cart');
  assert.equal(detailsForm.hidden, true);
  assert.match(document.querySelector('[data-checkout-order-message]').textContent, /Order received — ref CODORDER1/u);
  assert.match(document.querySelector('[data-checkout-order-summary]').textContent, /delivering to: 12 Silk Road/u);
  assert.equal(document.querySelector('.checkout-back').textContent, 'Return to cart');
  // The address is saved to the account for the next visit.
  const codSaveBox = document.querySelector('[data-checkout-save-cod-address]');
  assert.equal(codSaveBox.hidden, false, 'signed-in customers get the save-address option');
  assert.equal(codSaveBox.querySelector('input[name="saveCodAddressToAccount"]').checked, true);
  await waitUntil(() => requests.some(({ url }) => url.endsWith('/api/auth/address')));
  assert.deepEqual(requests.find(({ url }) => url.endsWith('/api/auth/address')).body, {
    addressLine1: '12 Silk Road',
    addressLine2: 'Riad wing',
    city: 'Nouakchott',
    postalCode: '0000',
    country: 'MR',
  });
  dom.window.close();
});

test('guest checkout demands the delivery address and phone before confirming an order', async () => {
  const { dom, requests } = setup({ user: null });
  const cart = await openCheckoutPanel();
  const form = document.querySelector('.checkout-details-form');
  fillGuestContact(form);
  // No address yet: the submission is refused and nothing is sent.
  submit(form, dom);
  assert.match(document.querySelector('.checkout-status').textContent, /complete the delivery address/u);
  assert.equal(requests.some(({ url }) => url.endsWith('/api/payments/checkout')), false);
  assert.equal(cart.getItems().length, 2, 'a refused order leaves the cart untouched');

  fillDeliveryFields(form);
  submit(form, dom);
  await waitUntil(() => !document.querySelector('.checkout-order-stage').hidden);
  const checkoutRequest = requests.find(({ url }) => url.endsWith('/api/payments/checkout')).body;
  assert.equal(checkoutRequest.paymentMethod, 'cod');
  assert.deepEqual(checkoutRequest.customer, { name: 'Guest Weaver', email: 'guest@example.invalid', phone: '+212612345678' });
  assert.deepEqual(checkoutRequest.shipping, { line1: '1 Harbour Road', line2: '', city: 'Paris', postalCode: '75001', country: 'FR' });
  assert.equal(cart.getItems().length, 0);
  dom.window.close();
});

test('a missing phone number is refused in the checkout, then accepted once added', async () => {
  const { dom, requests } = setup({ user: PROFILE_WITHOUT_ADDRESS_AND_PHONE });
  await openCheckoutPanel();
  await waitUntil(() => document.querySelector('[data-checkout-identity]').hidden === false);
  const form = document.querySelector('.checkout-details-form');
  // The summary skips the missing phone; the phone field stays for it.
  assert.equal(document.querySelector('[data-checkout-account-summary]').textContent,
    'Ordering as Amal Weaver (amal@example.invalid)');
  assert.equal(form.querySelector('.checkout-phone-field').hidden, false);
  fillDeliveryFields(form, { city: 'Nouakchott', postalCode: '0000', country: 'MR', line1: '9 Oasis Lane' });

  submit(form, dom);
  assert.match(document.querySelector('.checkout-status').textContent, /enter your phone number/u);
  assert.equal(requests.some(({ url }) => url.endsWith('/api/payments/checkout')), false);

  form.querySelector('[data-phone-country="customerPhone"]').value = 'MA';
  form.querySelector('input[name="customerPhone"]').value = '0612345678';
  submit(form, dom);
  await waitUntil(() => !document.querySelector('.checkout-order-stage').hidden);
  const checkoutRequest = requests.find(({ url }) => url.endsWith('/api/payments/checkout')).body;
  assert.equal(checkoutRequest.customer.phone, '+212612345678');
  dom.window.close();
});

test('the WhatsApp order button sends the cart plus the required contact details', async () => {
  const { dom, requests } = setup({ user: null });
  await openCheckoutPanel();
  const form = document.querySelector('.checkout-details-form');
  fillGuestContact(form);
  fillDeliveryFields(form);

  let opened;
  dom.window.open = (url) => { opened = url; };
  document.querySelector('.checkout-whatsapp-order').click();
  assert.match(opened, /^https:\/\/wa\.me\/33768353638\?text=/u, 'the store WhatsApp number receives the message');
  const message = decodeURIComponent(opened.split('text=')[1]);
  assert.match(message, /Mauve Mist \(Small\) × 1/u);
  assert.match(message, /Total: €205/u);
  assert.match(message, /Name: Guest Weaver/u);
  assert.match(message, /Phone: \+212612345678/u);
  assert.match(message, /Address: 1 Harbour Road, Paris 75001, FR/u);
  // The details go straight to WhatsApp first; no store order is placed behind the customer's back.
  assert.equal(requests.some(({ url }) => url.endsWith('/api/payments/checkout')), false);
  dom.window.close();
});

test('the cart footer WhatsApp button now opens the checkout panel so details are collected', async () => {
  const { dom } = setup({ user: null });
  await openCheckoutPanel();
  document.querySelector('.checkout-back').click();
  await waitUntil(() => document.querySelector('.checkout-panel').hidden);
  document.querySelector('.cart-footer .checkout-btn').click();
  // Back in the cart, the footer line feeds the checkout panel instead of WhatsApp.
  document.querySelector('.checkout-whatsapp').click();
  assert.equal(document.querySelector('.checkout-panel').hidden, false);
  assert.equal(document.querySelector('.cart-items').hidden, true);
  assert.equal(document.querySelector('.checkout-btn').hidden, true);
  dom.window.close();
});

test('paying by card captures the delivery address at creation and skips the post-payment step', async () => {
  const { dom, requests } = setup({ user: PROFILE_WITHOUT_ADDRESS });
  await openCheckoutPanel();
  await waitUntil(() => document.querySelector('[data-checkout-identity]').hidden === false);
  const form = document.querySelector('.checkout-details-form');
  // No saved address, so there is no address summary to hide the fields.
  assert.equal(document.querySelector('[data-checkout-address]').hidden, true);
  fillDeliveryFields(form, { city: 'Nouakchott', postalCode: '0000', country: 'MR', line1: '9 Oasis Lane' });

  document.querySelector('.checkout-pay-card').click();
  await waitUntil(() => !document.querySelector('.checkout-payment-stage').hidden);
  await waitUntil(() => !document.querySelector('.checkout-confirm-btn').disabled);
  const checkoutRequest = requests.find(({ url }) => url.endsWith('/api/payments/checkout')).body;
  assert.equal(checkoutRequest.paymentMethod, 'card');
  assert.deepEqual(checkoutRequest.shipping, { line1: '9 Oasis Lane', line2: '', city: 'Nouakchott', postalCode: '0000', country: 'MR' });
  assert.deepEqual(checkoutRequest.customer.phone, '+212612345678');

  document.querySelector('.checkout-confirm-btn').click();
  await waitUntil(() => document.querySelector('.checkout-status').textContent.includes('Payment confirmed for order TESTORDER1'));
  assert.equal(document.querySelector('.checkout-shipping-stage').hidden, true);
  dom.window.close();
});

test('the checkout re-checks the profile on every open, so signing in between visits shows the summaries', async () => {
  const { dom, signIn } = setup({ user: null });
  // First visit happens while the customer is still a guest.
  await openCheckoutPanel();
  assert.equal(document.querySelector('[data-checkout-identity]').hidden, true);
  document.querySelector('.checkout-back').click();
  await waitUntil(() => document.querySelector('.checkout-panel').hidden);

  // They sign in on their account page, then come back to the checkout.
  signIn(PROFILE_WITH_ADDRESS);
  document.querySelector('.checkout-btn').click();
  await waitUntil(() => document.querySelector('[data-checkout-identity]').hidden === false);
  assert.equal(document.querySelector('[data-checkout-address]').hidden, false);
  assert.equal(document.querySelector('[data-checkout-account-summary]').textContent,
    'Ordering as Amal Weaver (amal@example.invalid) · +212612345678');
  dom.window.close();
});

test('country lists are filled even when the checkout was mounted before the cart markup', async () => {
  const { dom } = setup({ user: null });
  // Live order of events: the checkout mounts at startup, then every route
  // change re-renders the cart markup fresh, wiping the select options.
  document.querySelector('#cart-modal').remove();
  mount();
  document.body.insertAdjacentHTML('beforeend', CART_MARKUP);

  const detailsForm = document.querySelector('.checkout-details-form');
  document.querySelector('.checkout-btn').click();
  await waitUntil(() => !document.querySelector('.checkout-panel').hidden);
  await waitUntil(() => detailsForm.querySelector('[data-phone-country="customerPhone"] option[value="MA"]'));
  const shippingForm = document.querySelector('.checkout-shipping-form');
  assert.ok(detailsForm.querySelector('select[name="shippingCountry"] option[value="MA"]'), 'checkout country list is populated');
  assert.ok(shippingForm.querySelector('select[name="shippingCountry"] option[value="FR"]'), 'delivery country list is populated');
  assert.ok(shippingForm.querySelector('[data-phone-country="shippingPhone"] option[value="MA"]'), 'delivery phone list is populated');
  dom.window.close();
});
