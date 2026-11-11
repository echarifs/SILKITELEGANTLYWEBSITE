import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PHONE_COUNTRIES, normalizePhoneNumber } from '../shared/phone.js';
import { phoneValueFromForm, renderPhoneField } from '../src/phone-field.js';

test('phone country metadata includes countries and their international calling codes', () => {
  const morocco = PHONE_COUNTRIES.find((country) => country.iso2 === 'MA');
  const france = PHONE_COUNTRIES.find((country) => country.iso2 === 'FR');
  assert.equal(morocco?.name, 'Morocco');
  assert.equal(morocco?.callingCode, '212');
  assert.equal(france?.callingCode, '33');
});

test('national phone input is normalized to E.164 using the selected country', () => {
  assert.equal(normalizePhoneNumber('0612345678', 'MA'), '+212612345678');
  assert.equal(normalizePhoneNumber('06 12 34 56 78', 'FR'), '+33612345678');
  assert.equal(normalizePhoneNumber('+1 (415) 555-2671'), '+14155552671');
});

test('blank optional phone numbers remain empty and invalid numbers are rejected', () => {
  assert.equal(normalizePhoneNumber(''), null);
  assert.equal(normalizePhoneNumber('   ', 'MA'), null);
  assert.equal(normalizePhoneNumber('123', 'MA'), undefined);
  assert.equal(normalizePhoneNumber('0612345678'), undefined);
});

test('phone field renders country choices and requires a country only when a number is entered', () => {
  const markup = renderPhoneField({ id: 'phone', name: 'phone', label: 'Phone (optional)' });
  assert.match(markup, /Morocco \(\+212\)/u);
  assert.match(markup, /France \(\+33\)/u);

  const dom = new JSDOM(`<form>${markup}</form>`);
  const form = dom.window.document.querySelector('form');
  const input = form.querySelector('input[name="phone"]');
  const country = form.querySelector('[data-phone-country="phone"]');

  assert.deepEqual(phoneValueFromForm(form, 'phone'), { ok: true, value: null });
  input.value = '0612345678';
  const missingCountry = phoneValueFromForm(form, 'phone');
  assert.equal(missingCountry.ok, false);
  assert.match(missingCountry.message, /choose a country/iu);

  country.value = 'MA';
  assert.deepEqual(phoneValueFromForm(form, 'phone'), { ok: true, value: '+212612345678' });
  dom.window.close();
});
