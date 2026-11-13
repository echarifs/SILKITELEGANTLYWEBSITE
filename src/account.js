import { renderCountrySelect, renderPhoneField, phoneValueFromForm } from './phone-field.js';
import { PHONE_COUNTRIES, splitPhoneNumber } from '../shared/phone.js';

const API_PREFIX = '/api/auth';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
// Latest signed-in profile, used to restore prefilled values when a panel is cancelled.
let latestProfileUser = null;
const pendingTokens = {
  verifyEmail: null,
  resetPassword: null,
};

const ACCOUNT_MODES = new Set([
  'signup',
  'signin',
  'verify-email',
  'forgot-password',
  'reset-password',
  'account',
  'privacy',
]);

const modeToTokenKey = {
  'verify-email': 'verifyEmail',
  'reset-password': 'resetPassword',
};

function currentHashMode(mode) {
  const hash = window.location.hash || '';
  return hash.replace(/^#/, '').split('?')[0] === mode;
}

function captureToken(mode) {
  const tokenKey = modeToTokenKey[mode];
  if (!tokenKey || !currentHashMode(mode)) return;

  const hash = window.location.hash || '';
  const queryStart = hash.indexOf('?');
  const query = queryStart >= 0 ? hash.slice(queryStart + 1) : '';
  const params = new URLSearchParams(query);
  const suppliedToken = params.get('token') || '';
  pendingTokens[tokenKey] = TOKEN_PATTERN.test(suppliedToken) ? suppliedToken : null;

  if (queryStart >= 0) {
    const cleanUrl = `${window.location.pathname}${window.location.search}#${mode}`;
    window.history.replaceState(null, document.title, cleanUrl);
  }
}

function safeErrorMessage(payload, fallback = 'Something went wrong. Please try again.') {
  const messages = {
    email_unavailable: 'Account email delivery is currently unavailable. Please try again later.',
    request_not_authorized: 'Your security session could not be confirmed. Refresh the page and try again.',
    invalid_registration: 'Check your details and choose a less common password with 15–128 characters.',
    try_again_later: 'Too many attempts. Please wait 15 minutes before trying again.',
    invalid_verification: 'This verification link or password could not be confirmed.',
    invalid_reset: 'This reset link is invalid or expired, or the new password is too easy to guess.',
    invalid_profile: 'Check your details and try again.',
    invalid_password: 'Choose a less common password with 15–128 characters.',
    invalid_credentials: 'That password could not be confirmed. Please try again.',
    email_taken: 'That email address is already used by another account.',
    internal_error: 'The account service is temporarily unavailable. Please try again later.',
  };
  if (typeof payload?.error === 'string' && messages[payload.error]) return messages[payload.error];
  const candidate = payload && typeof payload === 'object'
    ? (typeof payload.message === 'string' ? payload.message : payload.error)
    : '';
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim().slice(0, 320)
    : fallback;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function getApi(path) {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(safeErrorMessage(payload));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function postApi(path, body, { sessionCsrf = true, method = 'POST' } = {}) {
  // Authenticated state changes use a fresh session-bound CSRF token. Signup
  // is public and uses the server's strict Origin/JSON checks instead.
  const csrf = sessionCsrf ? await getApi('/csrf') : null;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (sessionCsrf) headers['X-CSRF-Token'] = typeof csrf?.csrfToken === 'string' ? csrf.csrfToken : '';
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: sessionCsrf ? 'include' : 'omit',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(safeErrorMessage(payload));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function putApi(path, body) {
  return postApi(path, body, { method: 'PUT' });
}

function field(id, label, type, options = {}) {
  const {
    name = id,
    autocomplete = '',
    required = false,
    minlength = '',
    maxlength = '',
    placeholder = '',
    inputmode = '',
  } = options;
  return `
    <div class="account-field">
      <label for="${id}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>
      <input id="${id}" name="${name}" type="${type}"${autocomplete ? ` autocomplete="${autocomplete}"` : ''}${required ? ' required' : ''}${minlength ? ` minlength="${minlength}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${placeholder ? ` placeholder="${placeholder}"` : ''}${inputmode ? ` inputmode="${inputmode}"` : ''} />
    </div>`;
}

function passwordField(id, label, autocomplete, options = {}) {
  const { name = id, required = true, minlength = 15 } = options;
  return `
    <div class="account-field account-password-field">
      <label for="${id}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>
      <div class="account-password-wrap">
        <input id="${id}" name="${name}" type="password" autocomplete="${autocomplete}"${required ? ' required' : ''}${minlength ? ` minlength="${minlength}"` : ''} maxlength="128" />
        <button type="button" class="account-password-toggle" data-password-toggle="${id}" aria-controls="${id}" aria-pressed="false">Show</button>
      </div>
    </div>`;
}

function accountFormIntro(eyebrow, title, description) {
  return `
    <div class="account-intro">
      <span class="eyebrow">${eyebrow}</span>
      <h1>${title}</h1>
      <p>${description}</p>
    </div>`;
}

function accountStatus() {
  return '<p class="account-status" data-account-status role="status" aria-live="polite"></p>';
}

function accountLinks(backLabel = 'Back to home') {
  return `
    <div class="account-page-links">
      <a class="back-link" href="#top">← ${backLabel}</a>
      <a class="account-text-link" href="#privacy">Privacy notice</a>
    </div>`;
}

function tokenNotice(mode) {
  const token = pendingTokens[modeToTokenKey[mode]];
  if (token) {
    return '<p class="account-help">This one-time link is ready. Complete the form below; opening this page alone does not consume it.</p>';
  }
  return '<p class="account-status account-status-error" role="status">This link is missing or expired. Request a fresh link or return to sign in.</p>';
}

function renderSignup() {
  return `
    <section class="account-page" data-account-page data-account-mode="signup">
      <div class="account-card account-card-form">
        ${accountLinks()}
        ${accountFormIntro('The personal edit', 'Create your account', 'Save your details for a softer way to stay in touch. Your password stays in the protected account database; selected account details may be synchronized to the brand’s restricted Google Sheet.')}
        <form class="account-form" data-account-form="signup" novalidate>
          ${field('account-signup-name', 'Name', 'text', { name: 'name', autocomplete: 'name', required: true, maxlength: 120 })}
          ${field('account-signup-email', 'Email address', 'email', { name: 'email', autocomplete: 'email', required: true, maxlength: 254, placeholder: 'you@example.com' })}
          ${renderPhoneField({ id: 'account-signup-phone', name: 'phone', label: 'Phone (optional)' })}
          ${passwordField('account-signup-password', 'Password', 'new-password', { name: 'password' })}
          <p class="account-help">Use at least 15 characters. Passphrases and spaces are welcome; common passwords are rejected by the server.</p>
          <label class="account-check">
            <input id="account-signup-marketing" name="marketingConsent" type="checkbox" value="true" />
            <span>Send me occasional notes from the atelier. This is optional.</span>
          </label>
          <label class="account-check">
            <input id="account-signup-privacy" name="termsAccepted" type="checkbox" value="true" required />
            <span>I have read the <a href="#privacy">privacy notice</a> and agree to create an account.</span>
          </label>
          ${accountStatus()}
          <button class="button button-dark account-submit" type="submit" data-account-submit>Create account</button>
        </form>
        <p class="account-switch">Already have an account? <a href="#signin">Sign in</a>.</p>
      </div>
    </section>`;
}

function renderSignin() {
  return `
    <section class="account-page" data-account-page data-account-mode="signin">
      <div class="account-card account-card-form">
        ${accountLinks()}
        ${accountFormIntro('Your private edit', 'Welcome back', 'Sign in to see your account details. We will never display your password here.')}
        <form class="account-form" data-account-form="signin" novalidate>
          ${field('account-signin-email', 'Email address', 'email', { name: 'email', autocomplete: 'email', required: true, maxlength: 254, placeholder: 'you@example.com' })}
          ${passwordField('account-signin-password', 'Password', 'current-password', { name: 'password' })}
          ${accountStatus()}
          <button class="button button-dark account-submit" type="submit" data-account-submit>Sign in</button>
        </form>
        <div class="account-actions-row">
          <a class="account-text-link" href="#forgot-password">Forgot your password?</a>
          <a class="account-text-link" href="#signup">Create an account</a>
          <a class="account-text-link" href="#verify-email">Resend verification</a>
        </div>
      </div>
    </section>`;
}

function renderVerifyEmail() {
  const token = pendingTokens.verifyEmail;
  if (!token) {
    return `
    <section class="account-page" data-account-page data-account-mode="verify-email">
      <div class="account-card account-card-form">
        ${accountLinks()}
        ${accountFormIntro('Resend verification', 'Need a fresh link?', 'Enter your email and we’ll send a new verification link. If you can’t remember your signup password, use password recovery instead.')}
        <form class="account-form" data-account-form="resend-verification" novalidate>
          ${field('account-resend-email', 'Email address', 'email', { name: 'email', autocomplete: 'email', required: true, maxlength: 254, placeholder: 'you@example.com' })}
          ${accountStatus()}
          <button class="button button-dark account-submit" type="submit" data-account-submit>Send new link</button>
        </form>
        <p class="account-switch"><a href="#forgot-password">Forgot your password?</a> or <a href="#signin">return to sign in</a>.</p>
      </div>
    </section>`;
  }
  return `
    <section class="account-page" data-account-page data-account-mode="verify-email">
      <div class="account-card account-card-form">
        ${accountLinks()}
        ${accountFormIntro('One small step', 'Verify your email', 'Enter the password you chose when signing up to confirm that this account belongs to you.')}
        <div data-account-token-message>${tokenNotice('verify-email')}</div>
        <form class="account-form" data-account-form="verify-email" novalidate>
          ${passwordField('account-verify-password', 'Your signup password', 'current-password', { name: 'password' })}
          ${passwordField('account-verify-password-repeat', 'Repeat your signup password', 'current-password', { name: 'passwordRepeat' })}
          ${accountStatus()}
          <button class="button button-dark account-submit" type="submit" data-account-submit>Verify email</button>
        </form>
        <p class="account-switch"><a href="#signin">Return to sign in</a>.</p>
      </div>
    </section>`;
}

function renderForgotPassword() {
  return `
    <section class="account-page" data-account-page data-account-mode="forgot-password">
      <div class="account-card account-card-form">
        ${accountLinks()}
        ${accountFormIntro('A quiet reset', 'Reset your password', 'Enter your email and, if the account can be recovered, you will receive a short-lived reset link.')}
        <form class="account-form" data-account-form="forgot-password" novalidate>
          ${field('account-forgot-email', 'Email address', 'email', { name: 'email', autocomplete: 'email', required: true, maxlength: 254, placeholder: 'you@example.com' })}
          ${accountStatus()}
          <button class="button button-dark account-submit" type="submit" data-account-submit>Send reset link</button>
        </form>
        <p class="account-switch"><a href="#signin">Return to sign in</a> or <a href="#signup">create an account</a>.</p>
      </div>
    </section>`;
}

function renderResetPassword() {
  const token = pendingTokens.resetPassword;
  return `
    <section class="account-page" data-account-page data-account-mode="reset-password">
      <div class="account-card account-card-form">
        ${accountLinks()}
        ${accountFormIntro('A fresh beginning', 'Choose a new password', 'Use a new password for this account. The reset link is single-use and is not consumed just by opening this page.')}
        <div data-account-token-message>${tokenNotice('reset-password')}</div>
        <form class="account-form" data-account-form="reset-password" novalidate>
          ${passwordField('account-reset-password', 'New password', 'new-password', { name: 'password' })}
          ${passwordField('account-reset-password-repeat', 'Repeat password', 'new-password', { name: 'passwordRepeat' })}
          <p class="account-help">Use at least 15 characters. Passphrases and spaces are welcome; common passwords are rejected by the server.</p>
          ${accountStatus()}
          <button class="button button-dark account-submit" type="submit" data-account-submit${token ? '' : ' disabled'}>Set new password</button>
        </form>
        <p class="account-switch"><a href="#signin">Return to sign in</a>.</p>
      </div>
    </section>`;
}

const PEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>';

function panelHead(title, editLabel) {
  return `
    <div class="account-panel-head">
      <h2 class="account-section-title">${title}</h2>
      <button class="account-edit-btn" type="button" data-account-edit aria-expanded="false" aria-label="${editLabel}">${PEN_ICON}</button>
    </div>`;
}

function renderAccount() {
  return `
    <section class="account-page" data-account-page data-account-mode="account">
      <div class="account-card account-profile-card">
        ${accountLinks()}
        ${accountFormIntro('Your private edit', 'Your account', 'Select the pen next to a section to edit it. Nothing is read from browser storage.')}
        <div class="account-loading" data-account-loading role="status" aria-live="polite">Checking your account…</div>
        <div class="account-logged-out" data-account-logged-out hidden>
          <p>You are currently signed out.</p>
          <a class="button button-dark" href="#signin">Sign in</a>
        </div>
        <div class="account-profile" data-account-profile hidden>
          <section class="account-panel" data-account-panel="details">
            ${panelHead('Your details', 'Edit your details')}
            <dl class="account-details" data-account-summary="details">
              <div><dt>Name</dt><dd data-summary-name></dd></div>
              <div><dt>Email</dt><dd data-summary-email></dd></div>
              <div><dt>Phone</dt><dd data-summary-phone></dd></div>
              <div><dt>Marketing notes</dt><dd data-summary-marketing></dd></div>
              <div><dt>Created</dt><dd data-profile-created></dd></div>
            </dl>
            <form class="account-form" data-account-form="profile" novalidate hidden>
              ${field('account-profile-name', 'Name', 'text', { name: 'name', autocomplete: 'name', required: true, maxlength: 120 })}
              ${field('account-profile-email', 'Email address', 'email', { name: 'email', autocomplete: 'email', required: true, maxlength: 254 })}
              ${renderPhoneField({ id: 'account-profile-phone', name: 'phone', label: 'Phone (optional)' })}
              ${passwordField('account-profile-current-password', 'Current password', 'current-password', { name: 'currentPassword', required: false, minlength: '' })}
              <p class="account-help">The current password is only required when you change your email address.</p>
              <label class="account-check">
                <input id="account-profile-marketing" name="marketingConsent" type="checkbox" value="true" />
                <span>Send me occasional notes from the atelier.</span>
              </label>
              ${accountStatus()}
              <div class="account-actions-row">
                <button class="button button-dark account-submit" type="submit" data-account-submit>Save details</button>
                <button class="button button-ghost" type="button" data-account-cancel>Cancel</button>
              </div>
            </form>
          </section>
          <section class="account-panel account-secondary-card" data-account-panel="address">
            ${panelHead('Delivery address', 'Edit delivery address')}
            <p class="account-help" data-account-address-empty>No delivery address yet. Select the pen to add one.</p>
            <dl class="account-details" data-account-summary="address">
              <div><dt>Street</dt><dd data-address-street></dd></div>
              <div data-address-row="line2"><dt>Detail</dt><dd data-address-detail></dd></div>
              <div><dt>City</dt><dd data-address-city></dd></div>
              <div><dt>Postal code</dt><dd data-address-postal></dd></div>
              <div><dt>Country</dt><dd data-address-country></dd></div>
            </dl>
            <form class="account-form" data-account-form="address" novalidate hidden>
              ${field('account-address-line1', 'Street address', 'text', { name: 'addressLine1', autocomplete: 'address-line1', maxlength: 200 })}
              ${field('account-address-line2', 'Apartment, suite (optional)', 'text', { name: 'addressLine2', autocomplete: 'address-line2', maxlength: 200 })}
              ${field('account-address-city', 'City', 'text', { name: 'city', autocomplete: 'address-level2', maxlength: 120 })}
              ${field('account-address-postal', 'Postal code', 'text', { name: 'postalCode', autocomplete: 'postal-code', maxlength: 20 })}
              ${renderCountrySelect({ id: 'account-address-country', name: 'country', label: 'Country' })}
              ${accountStatus()}
              <div class="account-actions-row">
                <button class="button button-dark account-submit" type="submit" data-account-submit>Save address</button>
                <button class="button button-ghost" type="button" data-account-address-remove hidden>Remove address</button>
                <button class="button button-ghost" type="button" data-account-cancel>Cancel</button>
              </div>
            </form>
          </section>
          <section class="account-panel account-secondary-card" data-account-panel="password">
            ${panelHead('Change password', 'Change your password')}
            <p class="account-help">Use at least 15 characters. Common passwords are rejected by the server. Other devices are signed out after the change.</p>
            <form class="account-form" data-account-form="password" novalidate hidden>
              ${passwordField('account-password-current', 'Current password', 'current-password', { name: 'currentPassword' })}
              ${passwordField('account-password-new', 'New password', 'new-password', { name: 'password' })}
              ${passwordField('account-password-repeat', 'Repeat new password', 'new-password', { name: 'passwordRepeat' })}
              ${accountStatus()}
              <div class="account-actions-row">
                <button class="button button-dark account-submit" type="submit" data-account-submit>Change password</button>
                <button class="button button-ghost" type="button" data-account-cancel>Cancel</button>
              </div>
            </form>
          </section>
          <p class="account-help">Account credentials are kept in the protected account database. Non-secret account details may be synchronized to the brand’s restricted Google Sheet.</p>
          <p class="account-status" data-account-profile-status role="status" aria-live="polite"></p>
          <button class="button button-ghost" type="button" data-account-logout>Sign out</button>
        </div>
      </div>
    </section>`;
}

function renderPrivacy() {
  return `
    <section class="account-page" data-account-page data-account-mode="privacy">
      <div class="account-card account-privacy-card">
        ${accountLinks()}
        ${accountFormIntro('The clear version', 'Privacy, plainly explained', 'Here is how SilkItElegantly handles the information you provide when creating an account.')}
        <div class="account-privacy-copy">
          <h2>What we keep</h2>
          <p>Your name, email, optional phone number, customer ID, signup date, email-verification state, marketing consent, and an optional saved delivery address belong in the protected account database. Passwords are not sent to the sheet; the service stores only password hashes in the database. The delivery address never leaves the database.</p>
          <h2>What may be synchronized</h2>
          <p>Selected non-secret account details may be synchronized to SilkItElegantly’s restricted Google Sheet for customer administration. The database remains the account record. A sheet outage should not make a sign-in look successful or bypass account security.</p>
          <h2>Messages from us</h2>
          <p>Marketing notes are optional and controlled by a separate checkbox. Verification and password-recovery messages are service emails, not marketing permission. Account verification and recovery messages are sent through our configured email service.</p>
          <h2>Your questions and requests</h2>
          <p>For privacy questions or requests, contact us on WhatsApp at <a href="https://wa.me/33768353638" target="_blank" rel="noreferrer">+33 7 68 35 36 38</a>. We will explain the practical next step.</p>
        </div>
        <div class="account-privacy-actions">
          <a class="button button-dark" href="#signup">Create an account</a>
          <a class="button button-ghost" href="#top">Back home</a>
        </div>
      </div>
    </section>`;
}

export function renderAccountPage(mode = 'signin') {
  const safeMode = ACCOUNT_MODES.has(mode) ? mode : 'signin';
  captureToken(safeMode);

  switch (safeMode) {
    case 'signup': return renderSignup();
    case 'verify-email': return renderVerifyEmail();
    case 'forgot-password': return renderForgotPassword();
    case 'reset-password': return renderResetPassword();
    case 'account': return renderAccount();
    case 'privacy': return renderPrivacy();
    case 'signin':
    default: return renderSignin();
  }
}

function setStatus(root, message, type = '') {
  const status = root?.querySelector('[data-account-status]');
  if (!status) return;
  status.textContent = message || '';
  status.className = `account-status${type ? ` account-status-${type}` : ''}`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
}

function setProfileStatus(root, message, type = '') {
  const status = root?.querySelector('[data-account-profile-status]');
  if (!status) return;
  status.textContent = message || '';
  status.className = `account-status${type ? ` account-status-${type}` : ''}`;
}

function clearPasswords(form) {
  form?.querySelectorAll('input[name="password"], input[name="passwordRepeat"]').forEach((input) => {
    input.value = '';
  });
}

function setBusy(form, busy) {
  if (!form) return;
  // Inert prevents edits while preserving input values in FormData. Disabled
  // inputs would be omitted, causing the server to receive empty credentials.
  form.inert = busy;
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll('button').forEach((control) => {
    control.disabled = busy || control.dataset.accountSubmitDisabled === 'true';
  });
}

function setFormSubmitAvailability(form, available) {
  const submit = form?.querySelector('[data-account-submit]');
  if (!submit) return;
  submit.dataset.accountSubmitDisabled = available ? 'false' : 'true';
  submit.disabled = !available;
}

function validatePasswordPair(form, root) {
  const password = form.querySelector('input[name="password"]');
  const repeat = form.querySelector('input[name="passwordRepeat"]');
  if (password && (password.value.length < 15 || password.value.length > 128)) {
    setStatus(root, 'Use a password between 15 and 128 characters.', 'error');
    password.focus();
    return false;
  }
  if (repeat && password && repeat.value !== password.value) {
    setStatus(root, 'The passwords do not match.', 'error');
    repeat.focus();
    return false;
  }
  return true;
}

function formValues(form) {
  const values = new FormData(form);
  return {
    name: String(values.get('name') || '').trim(),
    email: String(values.get('email') || '').trim(),
    phone: String(values.get('phone') || '').trim(),
    password: String(values.get('password') || ''),
    marketingConsent: values.get('marketingConsent') === 'true',
    termsAccepted: values.get('termsAccepted') === 'true',
  };
}

async function handleSignup(form, root) {
  if (!form.checkValidity() || !validatePasswordPair(form, root)) {
    form.reportValidity();
    return;
  }
  const phone = phoneValueFromForm(form, 'phone');
  if (!phone.ok) {
    setStatus(root, phone.message, 'error');
    phone.focus?.();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/register', {
      ...formValues(form),
      phone: phone.value,
      website: '',
      termsAccepted: true,
    }, { sessionCsrf: false });
    clearPasswords(form);
    setStatus(root, 'If this address can be registered, check your email for a verification link. If an account already exists, you can reset your password.', 'success');
    form.reset();
  } catch (error) {
    setStatus(root, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleSignin(form, root) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/login', {
      email: String(new FormData(form).get('email') || '').trim(),
      password: String(new FormData(form).get('password') || ''),
    });
    clearPasswords(form);
    window.location.hash = 'account';
  } catch (error) {
    const message = error.status === 401 || error.status === 403
      ? 'We could not sign you in with those details.'
      : error.message;
    setStatus(root, message, 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleVerify(form, root) {
  if (!pendingTokens.verifyEmail) {
    setStatus(root, 'This verification link is missing or expired. Request a fresh link below.', 'error');
    return;
  }
  if (!form.checkValidity() || !validatePasswordPair(form, root)) {
    form.reportValidity();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/verify-email', {
      token: pendingTokens.verifyEmail,
      password: String(new FormData(form).get('password') || ''),
    });
    clearPasswords(form);
    pendingTokens.verifyEmail = null;
    setStatus(root, 'Your email is verified. You can now sign in.', 'success');
  } catch (error) {
    setStatus(root, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleResendVerification(form, root) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/resend-verification', {
      email: String(new FormData(form).get('email') || '').trim(),
    });
    setStatus(root, 'If the account can receive a verification link, it will be sent shortly.', 'success');
    form.reset();
  } catch (error) {
    setStatus(root, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

function profileValues(form) {
  const values = new FormData(form);
  return {
    name: String(values.get('name') || '').trim(),
    email: String(values.get('email') || '').trim(),
    currentPassword: String(values.get('currentPassword') || ''),
    marketingConsent: values.get('marketingConsent') === 'true',
  };
}

async function handleProfileSave(form, root) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const phone = phoneValueFromForm(form, 'phone');
  if (!phone.ok) {
    setStatus(form, phone.message, 'error');
    phone.focus?.();
    return;
  }
  const values = profileValues(form);
  const emailChanged = Boolean(form.dataset.initialEmail) && values.email.toLowerCase() !== form.dataset.initialEmail;
  if (emailChanged && !values.currentPassword) {
    setStatus(form, 'Enter your current password to change your email address.', 'error');
    form.querySelector('[name="currentPassword"]')?.focus();
    return;
  }
  setBusy(form, true);
  try {
    const payload = await putApi('/profile', {
      name: values.name,
      email: values.email,
      phone: phone.value,
      marketingConsent: values.marketingConsent,
      ...(emailChanged ? { currentPassword: values.currentPassword } : {}),
    });
    const profile = root.querySelector('[data-account-profile]');
    if (payload?.user) populateProfileForms(profile, payload.user);
    setStatus(form, 'Your details were saved.', 'success');
  } catch (error) {
    setStatus(form, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

function addressValues(form) {
  const values = new FormData(form);
  return {
    addressLine1: String(values.get('addressLine1') || '').trim(),
    addressLine2: String(values.get('addressLine2') || '').trim(),
    city: String(values.get('city') || '').trim(),
    postalCode: String(values.get('postalCode') || '').trim(),
    country: String(values.get('country') || '').trim(),
  };
}

async function handleAddressSave(form, root) {
  const values = addressValues(form);
  const clearing = !values.addressLine1 && !values.addressLine2 && !values.city && !values.postalCode && !values.country;
  if (!clearing) {
    const required = [
      ['account-address-line1', values.addressLine1, 'Enter your street address.'],
      ['account-address-city', values.city, 'Enter your city.'],
      ['account-address-postal', values.postalCode, 'Enter your postal code.'],
      ['account-address-country', values.country, 'Choose your country.'],
    ].find((entry) => !entry[1]);
    if (required) {
      setStatus(form, required[2], 'error');
      document.getElementById(required[0])?.focus();
      return;
    }
  }
  setBusy(form, true);
  try {
    const payload = await putApi('/address', values);
    const profile = root.querySelector('[data-account-profile]');
    if (payload?.user) populateProfileForms(profile, payload.user);
    setStatus(form, clearing ? 'Delivery address removed.' : 'Delivery address saved.', 'success');
  } catch (error) {
    setStatus(form, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleChangePassword(form) {
  if (!form.checkValidity() || !validatePasswordPair(form, form)) {
    form.reportValidity();
    return;
  }
  const values = new FormData(form);
  const currentPassword = String(values.get('currentPassword') || '');
  if (!currentPassword) {
    setStatus(form, 'Enter your current password first.', 'error');
    form.querySelector('[name="currentPassword"]')?.focus();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/change-password', {
      currentPassword,
      password: String(values.get('password') || ''),
    });
    form.reset();
    clearPasswords(form);
    setStatus(form, 'Your password has been changed. Other devices are signed out.', 'success');
  } catch (error) {
    setStatus(form, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleForgotPassword(form, root) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/forgot-password', {
      email: String(new FormData(form).get('email') || '').trim(),
    });
    setStatus(root, 'If an account can be recovered, check your email for a reset link.', 'success');
    form.reset();
  } catch (error) {
    setStatus(root, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleResetPassword(form, root) {
  if (!pendingTokens.resetPassword) {
    setStatus(root, 'This reset link is missing or expired. Request a new reset link.', 'error');
    return;
  }
  if (!form.checkValidity() || !validatePasswordPair(form, root)) {
    form.reportValidity();
    return;
  }
  setBusy(form, true);
  try {
    await postApi('/reset-password', {
      token: pendingTokens.resetPassword,
      password: String(new FormData(form).get('password') || ''),
    });
    clearPasswords(form);
    pendingTokens.resetPassword = null;
    setStatus(root, 'Your password has been reset. You can now sign in.', 'success');
  } catch (error) {
    setStatus(root, error.message, 'error');
  } finally {
    setBusy(form, false);
  }
}

function bindPasswordToggles(root) {
  root.querySelectorAll('[data-password-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const input = root.querySelector(`#${toggle.dataset.passwordToggle}`);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggle.textContent = showing ? 'Show' : 'Hide';
      toggle.setAttribute('aria-pressed', String(!showing));
    });
  });
}

function formatCreationDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()) || date.getFullYear() < 2000 || date.getFullYear() > 2200) {
    return 'Not available';
  }
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

async function mountSignup(root) {
  const form = root.querySelector('[data-account-form="signup"]');
  if (!form) return;
  setFormSubmitAvailability(form, false);
  try {
    const status = await getApi('/status');
    const available = status.signupAvailable === true && status.emailConfigured !== false;
    setFormSubmitAvailability(form, available);
    if (!available) {
      setStatus(root, 'Account creation is currently unavailable because email configuration is not ready. Please try again later.', 'error');
    }
  } catch (error) {
    setFormSubmitAvailability(form, false);
    setStatus(root, 'Account creation is currently unavailable because the email service could not be confirmed.', 'error');
  }
}

function countryDisplayName(value) {
  const country = PHONE_COUNTRIES.find((entry) => entry.iso2 === value);
  return country ? country.name : (value || '—');
}

function populateProfileForms(profile, user) {
  if (!profile || !user) return;
  latestProfileUser = user;

  const profileForm = profile.querySelector('[data-account-form="profile"]');
  if (profileForm) {
    const setName = profileForm.querySelector('[name="name"]');
    const setEmail = profileForm.querySelector('[name="email"]');
    const setMarketing = profileForm.querySelector('[name="marketingConsent"]');
    if (setName) setName.value = typeof user.name === 'string' ? user.name : '';
    if (setEmail) setEmail.value = typeof user.email === 'string' ? user.email : '';
    if (setMarketing) setMarketing.checked = user.marketingConsent === true;
    profileForm.dataset.initialEmail = typeof user.email === 'string' ? user.email.toLowerCase() : '';

    const phone = splitPhoneNumber(user.phone);
    const phoneInput = profileForm.querySelector('[name="phone"]');
    const phoneCountry = profileForm.querySelector('[data-phone-country="phone"]');
    const phoneError = profileForm.querySelector('[data-phone-error="phone"]');
    if (phoneInput) phoneInput.value = phone ? phone.national : '';
    if (phoneCountry) phoneCountry.value = phone ? phone.iso2 : '';
    if (phoneError) {
      phoneError.hidden = true;
      phoneError.textContent = '';
    }
    // The optional current-password field resets every refresh; it is only
    // needed transiently to confirm an email change.
    const currentPassword = profileForm.querySelector('[name="currentPassword"]');
    if (currentPassword) currentPassword.value = '';
  }

  const addressForm = profile.querySelector('[data-account-form="address"]');
  const addressOpen = addressForm ? !addressForm.hidden : false;
  const hasAddress = typeof user.addressLine1 === 'string' && user.addressLine1.trim().length > 0;
  if (addressForm) {
    // While the edit form is open, the summary stays out of the way.
    const emptyNote = profile.querySelector('[data-account-address-empty]');
    if (emptyNote) emptyNote.hidden = addressOpen || hasAddress;
    const removeButton = profile.querySelector('[data-account-address-remove]');
    if (removeButton) removeButton.hidden = !hasAddress;
    const setValue = (name, value) => {
      const input = addressForm.querySelector(`[name="${name}"]`);
      if (input) input.value = value ?? '';
    };
    setValue('addressLine1', user.addressLine1);
    setValue('addressLine2', user.addressLine2);
    setValue('city', user.city);
    setValue('postalCode', user.postalCode);
    setValue('country', user.country);
  } else {
    const emptyNote = profile.querySelector('[data-account-address-empty]');
    if (emptyNote) emptyNote.hidden = hasAddress;
  }

  const addressSummary = profile.querySelector('[data-account-summary="address"]');
  if (addressSummary) {
    addressSummary.hidden = !hasAddress || addressOpen;
    if (hasAddress) {
      const setText = (name, value) => {
        const node = profile.querySelector(`[data-${name}]`);
        if (node) node.textContent = value;
      };
      setText('address-street', user.addressLine1);
      setText('address-detail', typeof user.addressLine2 === 'string' && user.addressLine2.trim() ? user.addressLine2 : '');
      setText('address-city', user.city || '—');
      setText('address-postal', user.postalCode || '—');
      setText('address-country', countryDisplayName(user.country));
      const line2Row = profile.querySelector('[data-address-row="line2"]');
      if (line2Row) line2Row.hidden = !(typeof user.addressLine2 === 'string' && user.addressLine2.trim().length > 0);
    }
  }

  const setMeta = (name, value) => {
    const node = profile.querySelector(`[data-profile-${name}]`);
    if (node) node.textContent = value;
  };
  setMeta('created', formatCreationDate(user.createdAt));

  const setText = (name, value) => {
    const node = profile.querySelector(`[data-${name}]`);
    if (node) node.textContent = value;
  };
  setText('summary-name', typeof user.name === 'string' && user.name.trim() ? user.name : '—');
  setText('summary-email', user.email || '—');
  setText('summary-phone', user.phone || 'Not added');
  setText('summary-marketing', user.marketingConsent === true ? 'Enabled' : 'Disabled');

  const detailsForm = profile.querySelector('[data-account-form="profile"]');
  const detailsSummary = profile.querySelector('[data-account-summary="details"]');
  if (detailsSummary) detailsSummary.hidden = detailsForm ? !detailsForm.hidden : false;
}

async function mountAccountProfile(root) {
  const loading = root.querySelector('[data-account-loading]');
  const loggedOut = root.querySelector('[data-account-logged-out]');
  const profile = root.querySelector('[data-account-profile]');
  if (!loading || !loggedOut || !profile) return;

  loading.hidden = false;
  loggedOut.hidden = true;
  profile.hidden = true;
  try {
    const payload = await getApi('/me');
    const user = payload && payload.user;
    loading.hidden = true;
    if (!user) {
      loggedOut.hidden = false;
      return;
    }

    populateProfileForms(profile, user);
    profile.hidden = false;
  } catch (error) {
    loading.hidden = true;
    loggedOut.hidden = false;
    setProfileStatus(root, 'We could not load your account right now. Please sign in again.', 'error');
  }
}

function setPanelOpen(panel, open) {
  if (!panel) return;
  const form = panel.querySelector('[data-account-form]');
  const button = panel.querySelector('[data-account-edit]');
  if (form) form.hidden = !open;
  if (button) button.setAttribute('aria-expanded', String(open));
  if (open) {
    panel.querySelectorAll('[data-account-summary], [data-account-address-empty]').forEach((node) => {
      node.hidden = true;
    });
    const first = form?.querySelector('input, select');
    if (first) first.focus();
    return;
  }
  // Closing reveals the summaries again, based on the latest saved data.
  const hasAddress = typeof latestProfileUser?.addressLine1 === 'string' && latestProfileUser.addressLine1.trim().length > 0;
  const detailsSummary = panel.querySelector('[data-account-summary="details"]');
  if (detailsSummary) detailsSummary.hidden = !latestProfileUser;
  const addressSummary = panel.querySelector('[data-account-summary="address"]');
  if (addressSummary) addressSummary.hidden = !hasAddress;
  const emptyNote = panel.querySelector('[data-account-address-empty]');
  if (emptyNote) emptyNote.hidden = hasAddress;
}

function wireEditToggles(root) {
  root.querySelectorAll('[data-account-edit]').forEach((button) => {
    if (button.dataset.accountEditWired === 'true') return;
    button.dataset.accountEditWired = 'true';
    button.addEventListener('click', () => {
      const panel = button.closest('[data-account-panel]');
      if (!panel) return;
      const opening = button.getAttribute('aria-expanded') !== 'true';
      if (!opening) closeRestoring(panel);
      setPanelOpen(panel, opening);
    });
  });

  root.querySelectorAll('[data-account-cancel]').forEach((cancel) => {
    if (cancel.dataset.accountCancelWired === 'true') return;
    cancel.dataset.accountCancelWired = 'true';
    cancel.addEventListener('click', () => {
      const panel = cancel.closest('[data-account-panel]');
      if (!panel) return;
      closeRestoring(panel);
      const button = panel.querySelector('[data-account-edit]');
      if (button) button.focus();
    });
  });
}

// Closing a panel always reveals up-to-date summary values and resets any
// half-typed form back to the saved profile.
function closeRestoring(panel) {
  const profile = panel.closest('[data-account-profile]');
  if (profile && latestProfileUser) populateProfileForms(profile, latestProfileUser);
  const form = panel.querySelector('[data-account-form]');
  if (form) {
    form.dataset.submitted = 'false';
    if (form.dataset.accountForm === 'password') {
      form.querySelectorAll('input[type="password"]').forEach((input) => {
        input.value = '';
      });
    }
    setStatus(form, '');
  }
  setPanelOpen(panel, false);
}

function wireAddressRemove(root) {
  const button = root.querySelector('[data-account-address-remove]');
  const form = root.querySelector('[data-account-form="address"]');
  if (!button || !form || button.dataset.accountRemoveWired === 'true') return;
  button.dataset.accountRemoveWired = 'true';
  button.addEventListener('click', async () => {
    setBusy(form, true);
    try {
      const payload = await putApi('/address', { addressLine1: '', addressLine2: '', city: '', postalCode: '', country: '' });
      const profile = root.querySelector('[data-account-profile]');
      if (payload?.user) populateProfileForms(profile, payload.user);
      setStatus(form, 'Delivery address removed.', 'success');
    } catch (error) {
      setStatus(form, error.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });
}

async function mountLogout(root) {
  const button = root.querySelector('[data-account-logout]');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await postApi('/logout', {});
      window.location.hash = 'signin';
    } catch (error) {
      button.disabled = false;
      setProfileStatus(root, error.message, 'error');
    }
  });
}

export async function mountAccountPage() {
  const root = document.querySelector('[data-account-page]');
  if (!root || root.dataset.accountMounted === 'true') return;
  root.dataset.accountMounted = 'true';
  bindPasswordToggles(root);

  const mode = root.dataset.accountMode;
  root.querySelectorAll('[data-account-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      form.dataset.submitted = 'true';
      const formMode = form.dataset.accountForm;
      if (formMode === 'signup') handleSignup(form, root);
      else if (formMode === 'signin') handleSignin(form, root);
      else if (formMode === 'verify-email') handleVerify(form, root);
      else if (formMode === 'forgot-password') handleForgotPassword(form, root);
      else if (formMode === 'reset-password') handleResetPassword(form, root);
      else if (formMode === 'resend-verification') handleResendVerification(form, root);
      else if (formMode === 'profile') handleProfileSave(form, root);
      else if (formMode === 'address') handleAddressSave(form, root);
      else if (formMode === 'password') handleChangePassword(form);
    });
  });

  if (mode === 'signup') await mountSignup(root);
  if (mode === 'account') {
    wireEditToggles(root);
    await Promise.all([mountAccountProfile(root), mountLogout(root), wireAddressRemove(root)]);
  }
}

export async function mountAccountLinks() {
  const links = [...document.querySelectorAll('[data-account-link]')];
  if (!links.length) return;
  let user = null;
  try {
    const payload = await getApi('/me');
    user = payload && payload.user ? payload.user : null;
  } catch {
    user = null;
  }
  links.forEach((link) => {
    link.textContent = user ? 'My account' : 'Sign in | up';
    link.setAttribute('href', user ? '#account' : '#signin');
  });
}
