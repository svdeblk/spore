import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// owasp's scrypt floor is N = 2^17, r = 8, p = 1; needs 128 MiB per hash
const R = 8;
const P = 1;
const MAXMEM = 256 * 1024 * 1024;

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 256;

// params travel inside stored string; raising cost later= old hashes stay verifiable
export async function hashPassword(password, logN = 17) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, { N: 2 ** logN, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', logN, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, logN, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: 2 ** Number(logN), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  if (typeof password !== 'string') return 'password required';
  const length = [...password].length;
  if (length < MIN_LENGTH) return `passwords are at least ${MIN_LENGTH} characters`;
  if (length > MAX_LENGTH) return `passwords are at most ${MAX_LENGTH} characters`;
  return null;
}
