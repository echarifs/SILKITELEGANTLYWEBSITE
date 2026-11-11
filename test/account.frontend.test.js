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
