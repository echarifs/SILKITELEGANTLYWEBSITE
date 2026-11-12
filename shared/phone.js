import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/max';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const PHONE_COUNTRIES = Object.freeze(
  getCountries()
    .map((iso2) => Object.freeze({
      iso2,
      name: regionNames.of(iso2) || iso2,
      callingCode: getCountryCallingCode(iso2),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en')),
);

export const COUNTRY_ISO_CODES = new Set(PHONE_COUNTRIES.map((country) => country.iso2));

/** Uppercase an ISO-2 country code, or undefined when it is not in the known set. */
export function normalizeCountryCode(value) {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toUpperCase();
  return COUNTRY_ISO_CODES.has(code) ? code : undefined;
}

/** Return a canonical E.164 value, null for an optional blank, or undefined if invalid. */
export function normalizePhoneNumber(value, defaultCountry) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;

  const phone = value.normalize('NFC').trim();
  if (!phone) return null;
  if (Array.from(phone).length > 40 || /[\u0000-\u001f\u007f]/u.test(phone)) return undefined;

  try {
    const parsed = parsePhoneNumberFromString(phone, defaultCountry || undefined);
    return parsed?.isPossible() ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

/** Split a stored E.164 value into { iso2, national } for country-select prefills, or null. */
export function splitPhoneNumber(value) {
  if (typeof value !== 'string') return null;
  const phone = value.trim();
  if (!phone) return null;
  try {
    const parsed = parsePhoneNumberFromString(phone);
    if (!parsed?.isPossible()) return null;
    return { iso2: parsed.country, national: parsed.formatNational() };
  } catch {
    return null;
  }
}
