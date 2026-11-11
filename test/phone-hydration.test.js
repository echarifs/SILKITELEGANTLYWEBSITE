import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { hydratePhoneCountrySelectors } from '../src/phone-field.js';

test('checkout phone selector receives the country list once after cart markup is mounted', () => {
  const dom = new JSDOM('<form><select data-phone-country="customerPhone"><option value="">Select country</option></select></form>');
  const root = dom.window.document;
  const selector = root.querySelector('[data-phone-country="customerPhone"]');

  hydratePhoneCountrySelectors(root);
  assert.equal(selector.querySelector('option[value="MA"]')?.textContent, 'Morocco (+212)');
  const optionCount = selector.querySelectorAll('option').length;
  hydratePhoneCountrySelectors(root);
  assert.equal(selector.querySelectorAll('option').length, optionCount);
  dom.window.close();
});
