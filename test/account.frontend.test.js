import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderAccountPage, mountAccountPage } from '../src/account.js';

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('DOM request did not finish');
}

function setup(hash) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: `https://shop.example.invalid/${hash}` });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.FormData = dom.window.FormData;
  return dom;
}

test('signup preserves FormData while busy and clears a visible password after success', async () => {
  const dom = setup('#signup');
  let submitted;
  globalThis.fetch = async (url, options = {}) => {
    const payload = url.endsWith('/status') ? { signupAvailable: true, emailConfigured: true } : url.endsWith('/csrf') ? { csrfToken: 'f'.repeat(64) } : { message: 'Request received' };
    if (url.endsWith('/register')) submitted = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('signup');
  await mountAccountPage();
  const form = document.querySelector('form');
  form.querySelector('[name="name"]').value = 'Test Weaver';
  form.querySelector('[name="email"]').value = 'test@example.invalid';
  form.querySelector('[data-phone-country="phone"]').value = 'MA';
  form.querySelector('[name="phone"]').value = '0612345678';
  const password = form.querySelector('[name="password"]');
  password.value = 'independent weavers gather moonlight';
  form.querySelector('[name="termsAccepted"]').checked = true;
  form.querySelector('[data-password-toggle]').click();
  assert.equal(password.type, 'text');
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => submitted && password.value === '');
  assert.equal(submitted.name, 'Test Weaver');
  assert.equal(submitted.email, 'test@example.invalid');
  assert.equal(submitted.phone, '+212612345678');
  assert.equal(submitted.password, 'independent weavers gather moonlight');
  assert.equal(submitted.marketingConsent, false);
  assert.equal(submitted.termsAccepted, true);
  dom.window.close();
});

test('signup remains disabled until the email service is ready for verification messages', async () => {
  const dom = setup('#signup');
  let registerRequests = 0;
  globalThis.fetch = async (url) => {
    const payload = url.endsWith('/status')
      ? { signupAvailable: false, emailConfigured: false }
      : url.endsWith('/csrf')
        ? { csrfToken: 'f'.repeat(64) }
        : { message: 'Request received' };
    if (url.endsWith('/register')) registerRequests += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('signup');
  await mountAccountPage();
  const submit = document.querySelector('[data-account-submit]');
  assert.equal(submit.disabled, true);
  assert.match(document.getElementById('app').textContent, /email configuration is not ready/u);
  submit.click();
  assert.equal(registerRequests, 0);
  dom.window.close();
});

test('verification captures a token privately and does not consume it on page render', async () => {
  const token = 'a'.repeat(64);
  const dom = setup(`#verify-email?token=${token}`);
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('No automatic token request expected'); };
  document.getElementById('app').innerHTML = renderAccountPage('verify-email');
  await mountAccountPage();
  assert.equal(window.location.hash, '#verify-email');
  assert.ok(!document.body.innerHTML.includes(token));
  assert.equal(document.querySelector('[name="password"]').autocomplete, 'current-password');
  assert.equal(requests, 0);
  dom.window.close();
});

const PROFILE_USER = {
  id: 'customer-1',
  name: 'Test Weaver',
  email: 'test@example.invalid',
  phone: '+212612345678',
  marketingConsent: false,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postalCode: null,
  country: null,
  emailVerified: true,
  createdAt: '2026-01-02T10:00:00.000Z',
  sheetSyncStatus: 'synced',
};

test('account page prefills editable forms and saves details with PUT /profile', async () => {
  const dom = setup('#account');
  const saved = [];
  globalThis.fetch = async (url, options = {}) => {
    const payload = url.endsWith('/me')
      ? { user: PROFILE_USER }
      : url.endsWith('/csrf')
        ? { csrfToken: 'f'.repeat(64) }
        : { user: { ...PROFILE_USER, name: 'Renamed Weaver', marketingConsent: true } };
    if (url.endsWith('/profile')) saved.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('account');
  await mountAccountPage();
  await waitUntil(() => !document.querySelector('[data-account-profile]').hidden);

  const form = document.querySelector('[data-account-form="profile"]');
  assert.equal(form.querySelector('[name="name"]').value, 'Test Weaver');
  assert.equal(form.querySelector('[name="email"]').value, 'test@example.invalid');
  assert.equal(form.querySelector('[data-phone-country="phone"]').value, 'MA');
  assert.equal(form.querySelector('[name="phone"]').value, '06 12 34 56 78');
  assert.equal(form.querySelector('[name="currentPassword"]').required, false);
  assert.equal(form.querySelector('[name="marketingConsent"]').checked, false);

  form.querySelector('[name="name"]').value = 'Renamed Weaver';
  form.querySelector('[name="marketingConsent"]').checked = true;
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => saved.length === 1);
  assert.equal(saved[0].body.name, 'Renamed Weaver');
  assert.equal(saved[0].body.email, 'test@example.invalid');
  assert.equal(saved[0].body.phone, '+212612345678');
  assert.equal(saved[0].body.marketingConsent, true);
  assert.equal('currentPassword' in saved[0].body, false, 'no password on non-email changes');
  assert.equal(form.dataset.initialEmail, 'test@example.invalid');
  assert.equal(form.querySelector('[name="currentPassword"]').value, '');
  dom.window.close();
});

test('email change without a current password is blocked client-side; with one it is sent', async () => {
  const dom = setup('#account');
  const saved = [];
  globalThis.fetch = async (url, options = {}) => {
    const payload = url.endsWith('/me')
      ? { user: PROFILE_USER }
      : url.endsWith('/csrf')
        ? { csrfToken: 'f'.repeat(64) }
        : { user: { ...PROFILE_USER, email: 'moved@example.invalid' } };
    if (url.endsWith('/profile')) saved.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('account');
  await mountAccountPage();
  await waitUntil(() => !document.querySelector('[data-account-profile]').hidden);

  const form = document.querySelector('[data-account-form="profile"]');
  form.querySelector('[name="email"]').value = 'moved@example.invalid';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => form.querySelector('[data-account-status]').textContent.includes('current password'), 0);
  assert.equal(saved.length, 0);

  form.querySelector('[name="currentPassword"]').value = 'current password entered';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => saved.length === 1);
  assert.equal(saved[0].email, 'moved@example.invalid');
  assert.equal(saved[0].currentPassword, 'current password entered');
  await waitUntil(() => form.querySelector('[data-account-status]').textContent.includes('saved'));
  assert.equal(form.dataset.initialEmail, 'moved@example.invalid');
  dom.window.close();
});

test('address form saves with PUT /address, clears with an empty payload, and toggles its remove button', async () => {
  const dom = setup('#account');
  const saved = [];
  let currentUser = PROFILE_USER;
  globalThis.fetch = async (url, options = {}) => {
    const payload = url.endsWith('/me')
      ? { user: currentUser }
      : url.endsWith('/csrf')
        ? { csrfToken: 'f'.repeat(64) }
        : null;
    if (url.endsWith('/address')) {
      const body = JSON.parse(options.body);
      saved.push(body);
      currentUser = {
        ...currentUser,
        addressLine1: body.addressLine1 || null,
        addressLine2: body.addressLine2 || null,
        city: body.city || null,
        postalCode: body.postalCode || null,
        country: body.country || null,
      };
      return { ok: true, status: 200, json: async () => ({ user: currentUser }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('account');
  await mountAccountPage();
  await waitUntil(() => !document.querySelector('[data-account-profile]').hidden);

  const form = document.querySelector('[data-account-form="address"]');
  const emptyNote = document.querySelector('[data-account-address-empty]');
  const removeButton = document.querySelector('[data-account-address-remove]');
  assert.equal(emptyNote.hidden, false);
  assert.equal(removeButton.hidden, true);

  form.querySelector('[name="addressLine1"]').value = '12 Silk Road';
  form.querySelector('[name="city"]').value = 'Nouakchott';
  form.querySelector('[name="postalCode"]').value = '0000';
  form.querySelector('[name="country"]').value = 'MR';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => saved.length === 1);
  assert.deepEqual(saved[0], {
    addressLine1: '12 Silk Road', addressLine2: '', city: 'Nouakchott',
    postalCode: '0000', country: 'MR',
  });
  await waitUntil(() => emptyNote.hidden === true && removeButton.hidden === false);

  removeButton.click();
  await waitUntil(() => saved.length === 2);
  assert.deepEqual(saved[1], {
    addressLine1: '', addressLine2: '', city: '', postalCode: '', country: '',
  });
  await waitUntil(() => emptyNote.hidden === false && removeButton.hidden === true);
  assert.equal(form.querySelector('[name="addressLine1"]').value, '');
  dom.window.close();
});

test('password change posts current and new passwords and clears the inputs', async () => {
  const dom = setup('#account');
  const saved = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/change-password')) {
      saved.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ message: 'Your password has been changed.' }) };
    }
    const payload = url.endsWith('/me') ? { user: PROFILE_USER } : { csrfToken: 'f'.repeat(64) };
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('account');
  await mountAccountPage();
  await waitUntil(() => !document.querySelector('[data-account-profile]').hidden);

  const form = document.querySelector('[data-account-form="password"]');
  form.querySelector('[name="currentPassword"]').value = 'independent weavers gather moonlight';
  form.querySelector('[name="password"]').value = 'renewed silkworms hum softly at night';
  form.querySelector('[name="passwordRepeat"]').value = 'renewed silkworms hum softly at night';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => saved.length === 1);
  assert.equal(saved[0].currentPassword, 'independent weavers gather moonlight');
  assert.equal(saved[0].password, 'renewed silkworms hum softly at night');
  assert.equal('passwordRepeat' in saved[0], false);
  assert.equal(form.querySelector('[name="currentPassword"]').value, '');
  assert.equal(form.querySelector('[name="password"]').value, '');
  assert.match(form.querySelector('[data-account-status]').textContent, /password has been changed/iu);
  dom.window.close();
});

test('pen buttons reveal each edit form, cancel restores saved values, and the address summary appears once saved', async () => {
  const dom = setup('#account');
  globalThis.fetch = async (url) => {
    const payload = url.endsWith('/me') ? { user: PROFILE_USER } : { csrfToken: 'f'.repeat(64) };
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('account');
  await mountAccountPage();
  await waitUntil(() => !document.querySelector('[data-account-profile]').hidden);

  const panel = (key) => document.querySelector(`[data-account-panel="${key}"]`);
  const editButton = (key) => panel(key).querySelector('[data-account-edit]');
  const formOf = (key) => panel(key).querySelector('[data-account-form]');

  for (const key of ['details', 'address', 'password']) {
    assert.equal(formOf(key).hidden, true, `${key} form starts closed`);
    editButton(key).click();
    assert.equal(formOf(key).hidden, false, `${key} form opens from the pen`);
    assert.equal(editButton(key).getAttribute('aria-expanded'), 'true');
    editButton(key).click();
    assert.equal(formOf(key).hidden, true, `${key} form closes from the pen again`);
    assert.equal(editButton(key).getAttribute('aria-expanded'), 'false');
  }

  const summary = document.querySelector('[data-account-summary="details"]');
  assert.equal(summary.hidden, false, 'details summary returns after closing the panel');
  assert.match(summary.textContent, /test@example\.invalid/u);
  assert.equal(document.querySelector('[data-account-address-empty]').hidden, false, 'empty address note shows while no address is saved');
  assert.equal(document.querySelector('[data-account-summary="address"]').hidden, true);

  editButton('details').click();
  const detailsForm = formOf('details');
  detailsForm.querySelector('[name="name"]').value = 'Changed Name';
  panel('details').querySelector('[data-account-cancel]').click();
  assert.equal(detailsForm.querySelector('[name="name"]').value, PROFILE_USER.name);
  assert.equal(summary.textContent.includes('Changed Name'), false);
  dom.window.close();
});

test('a saved delivery address shows its summary and the empty note stays hidden while editing', async () => {
  const dom = setup('#account');
  const savedUser = {
    ...PROFILE_USER,
    addressLine1: '12 Silk Road',
    addressLine2: 'Riad wing',
    city: 'Nouakchott',
    postalCode: '0000',
    country: 'MR',
  };
  globalThis.fetch = async (url) => {
    const payload = url.endsWith('/me') ? { user: savedUser } : { csrfToken: 'f'.repeat(64) };
    return { ok: true, status: 200, json: async () => payload };
  };
  document.getElementById('app').innerHTML = renderAccountPage('account');
  await mountAccountPage();
  await waitUntil(() => !document.querySelector('[data-account-profile]').hidden);

  const addressSummary = document.querySelector('[data-account-summary="address"]');
  assert.equal(addressSummary.hidden, false);
  assert.match(document.querySelector('[data-address-street]').textContent, /12 Silk Road/u);
  assert.match(document.querySelector('[data-address-country]').textContent, /Mauritania/u);
  assert.equal(document.querySelector('[data-address-row="line2"]').hidden, false);

  const addressPanel = document.querySelector('[data-account-panel="address"]');
  addressPanel.querySelector('[data-account-edit]').click();
  assert.equal(addressSummary.hidden, true);
  assert.equal(addressPanel.querySelector('[data-account-address-empty]').hidden, true);
  assert.equal(addressPanel.querySelector('[name="addressLine2"]').value, 'Riad wing');
  dom.window.close();
});
