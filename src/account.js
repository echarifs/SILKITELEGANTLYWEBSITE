import { renderPhoneField, phoneValueFromForm } from './phone-field.js';

const API_PREFIX = '/api/auth';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
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

async function postApi(path, body, { sessionCsrf = true } = {}) {
  // Authenticated state changes use a fresh session-bound CSRF token. Signup
  // is public and uses the server's strict Origin/JSON checks instead.
  const csrf = sessionCsrf ? await getApi('/csrf') : null;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (sessionCsrf) headers['X-CSRF-Token'] = typeof csrf?.csrfToken === 'string' ? csrf.csrfToken : '';
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
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
  return `
    <div class="account-field account-password-field">
      <label for="${id}">${label} <span aria-hidden="true">*</span></label>
      <div class="account-password-wrap">
        <input id="${id}" name="${options.name || id}" type="password" autocomplete="${autocomplete}" required minlength="15" maxlength="128" />
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

function renderAccount() {
  return `
    <section class="account-page" data-account-page data-account-mode="account">
      <div class="account-card account-profile-card">
        ${accountLinks()}
        ${accountFormIntro('Your private edit', 'Your account', 'Your profile is loaded from the account service. Nothing is read from browser storage.')}
        <div class="account-loading" data-account-loading role="status" aria-live="polite">Checking your account…</div>
        <div class="account-logged-out" data-account-logged-out hidden>
          <p>You are currently signed out.</p>
          <a class="button button-dark" href="#signin">Sign in</a>
        </div>
        <div class="account-profile" data-account-profile hidden>
          <dl class="account-details">
            <div><dt>Name</dt><dd data-profile-name></dd></div>
            <div><dt>Email</dt><dd data-profile-email></dd></div>
            <div><dt>Phone</dt><dd data-profile-phone></dd></div>
            <div><dt>Marketing notes</dt><dd data-profile-marketing></dd></div>
            <div><dt>Created</dt><dd data-profile-created></dd></div>
            <div><dt>Sheet sync</dt><dd data-profile-sync></dd></div>
          </dl>
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
          <p>Your name, email, optional phone number, customer ID, signup date, email-verification state, and marketing consent belong in the protected account database. Passwords are not sent to the sheet; the service stores only password hashes in the database.</p>
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

function safeSyncStatus(value) {
  const labels = {
    synced: 'Synced',
    pending: 'Pending',
    failed: 'Needs attention',
    'not-configured': 'Not configured',
    not_configured: 'Not configured',
  };
  return labels[String(value || '').toLowerCase()] || 'Status unavailable';
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

    profile.querySelector('[data-profile-name]').textContent = typeof user.name === 'string' ? user.name : 'Not available';
    profile.querySelector('[data-profile-email]').textContent = typeof user.email === 'string' ? user.email : 'Not available';
    profile.querySelector('[data-profile-phone]').textContent = typeof user.phone === 'string' && user.phone.trim() ? user.phone : 'Not added';
    profile.querySelector('[data-profile-marketing]').textContent = user.marketingConsent === true ? 'Enabled' : 'Not enabled';
    profile.querySelector('[data-profile-created]').textContent = formatCreationDate(user.createdAt);
    profile.querySelector('[data-profile-sync]').textContent = safeSyncStatus(user.sheetSyncStatus);
    profile.hidden = false;
  } catch (error) {
    loading.hidden = true;
    loggedOut.hidden = false;
    setProfileStatus(root, 'We could not load your account right now. Please sign in again.', 'error');
  }
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
    });
  });

  if (mode === 'signup') await mountSignup(root);
  if (mode === 'account') {
    await Promise.all([mountAccountProfile(root), mountLogout(root)]);
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
