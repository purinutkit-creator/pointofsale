import crypto from 'node:crypto';

// scrypt (memory-hard) hashing for PINs and passwords — never stored in plain text
const N = 16384; const r = 8; const p = 1; const KEYLEN = 32;

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, n, rr, pp, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +rr, p: +pp });
  return crypto.timingSafeEqual(expected, actual);
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const uuid = () => crypto.randomUUID();

/** Random numeric code with uniform distribution (no modulo bias). */
export function randomDigits(len = 6) {
  let out = '';
  while (out.length < len) {
    const b = crypto.randomBytes(1)[0];
    if (b < 250) out += String(b % 10);
  }
  return out;
}

export const isValidPin = (pin) => /^\d{4,6}$/.test(String(pin || ''));
