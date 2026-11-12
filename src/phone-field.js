import { PHONE_COUNTRIES, normalizePhoneNumber } from '../shared/phone.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function countryOptionsMarkup() {
  return PHONE_COUNTRIES.map(({ iso2, name, callingCode }) => (
    `<option value="${escapeHtml(iso2)}">${escapeHtml(name)} (+${escapeHtml(callingCode)})</option>`
  )).join('');
}

export function renderCountrySelect({ id, name, label, selected = '' }) {
  const options = PHONE_COUNTRIES.map(({ iso2, name: countryName }) => (
    `<option value="${escapeHtml(iso2)}"${iso2 === selected ? ' selected' : ''}>${escapeHtml(countryName)}</option>`
  )).join('');
  return `
    <div class="account-field">
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <select id="${escapeHtml(id)}" name="${escapeHtml(name)}" autocomplete="country-name">
        <option value="">Select country</option>
        ${options}
      </select>
    </div>`;
}

export function renderPhoneField({ id, name, label, wrapperClass = 'account-field' }) {
  return `
    <div class="${escapeHtml(wrapperClass)} phone-field">
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <div class="phone-field-controls">
        <select class="phone-country-select" data-phone-country="${escapeHtml(name)}" aria-label="Country calling code" autocomplete="country">
          <option value="">Select country</option>
          ${countryOptionsMarkup()}
        </select>
        <input class="phone-number-input" id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="tel" autocomplete="tel-national" maxlength="40" inputmode="tel" placeholder="Local phone number">
      </div>
      <p class="phone-field-error" data-phone-error="${escapeHtml(name)}" role="status" aria-live="polite" hidden></p>
    </div>`;
}

export function hydratePhoneCountrySelectors(root = document) {
  root.querySelectorAll('select[data-phone-country]').forEach((select) => {
    if (select.dataset.phoneCountriesReady === 'true' || select.options.length > 1) return;
    select.insertAdjacentHTML('beforeend', countryOptionsMarkup());
    select.dataset.phoneCountriesReady = 'true';
  });
}

export function phoneValueFromForm(form, name) {
  const input = form.querySelector(`input[name="${name}"]`);
  const country = [...form.querySelectorAll('[data-phone-country]')]
    .find((element) => element.dataset.phoneCountry === name);
  const error = [...form.querySelectorAll('[data-phone-error]')]
    .find((element) => element.dataset.phoneError === name);
  const raw = typeof input?.value === 'string' ? input.value.trim() : '';
  const setError = (message = '') => {
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  };

  if (!raw) {
    setError();
    return { ok: true, value: null };
  }
  if (!country?.value) {
    const message = 'Choose a country for this phone number.';
    setError(message);
    return { ok: false, value: null, message, focus: country || input };
  }

  const value = normalizePhoneNumber(raw, country.value);
  if (!value) {
    const message = 'Enter a valid phone number for the selected country.';
    setError(message);
    return { ok: false, value: null, message, focus: input };
  }

  setError();
  return { ok: true, value };
}
