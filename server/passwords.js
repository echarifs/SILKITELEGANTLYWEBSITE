import argon2 from '@node-rs/argon2';
import zxcvbnCore from '@zxcvbn-ts/core';
import commonPackage from '@zxcvbn-ts/language-common';
import englishPackage from '@zxcvbn-ts/language-en';

const { ZxcvbnFactory } = zxcvbnCore;
const { adjacencyGraphs, dictionary: commonDictionary } = commonPackage;
const { translations, dictionary: englishDictionary } = englishPackage;

const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  algorithm: 2,
};

const zxcvbn = new ZxcvbnFactory({
  translations,
  graphs: adjacencyGraphs,
  dictionary: {
    ...commonDictionary,
    ...englishDictionary,
  },
});

export const PASSWORD_MIN_CODEPOINTS = 15;
export const PASSWORD_MAX_CODEPOINTS = 128;

export function normalizePassword(value) {
  if (typeof value !== 'string') return null;
  return value.normalize('NFC');
}

export function passwordCodepointLength(value) {
  const normalized = normalizePassword(value);
  return normalized === null ? -1 : Array.from(normalized).length;
}

export function validatePassword(value, userInputs = []) {
  const password = normalizePassword(value);
  if (password === null) return { ok: false, reason: 'type' };
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_CODEPOINTS) return { ok: false, reason: 'too_short' };
  if (length > PASSWORD_MAX_CODEPOINTS) return { ok: false, reason: 'too_long' };

  const inputs = Array.from(new Set(
    userInputs
      .filter((input) => typeof input === 'string')
      .map((input) => input.normalize('NFC').trim())
      .filter(Boolean),
  )).slice(0, 8);
  const result = zxcvbn.check(password, inputs);
  if (result.score < 3) return { ok: false, reason: 'common', score: result.score };
  return { ok: true, normalized: password, score: result.score };
}

export async function hashPassword(value) {
  const password = normalizePassword(value);
  if (password === null) throw new TypeError('Password must be a string');
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(value, encodedHash) {
  const password = normalizePassword(value);
  if (password === null || typeof encodedHash !== 'string' || !encodedHash) return false;
  try {
    return await argon2.verify(encodedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export { ARGON2_OPTIONS };
