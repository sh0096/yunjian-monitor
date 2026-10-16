import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = Buffer.from(passwordHash(password, parts[1]).split('$')[2], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function seal(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
}
export function unseal(encoded, key, context) {
  if (!encoded.startsWith('v1.')) throw new Error('Unsupported encryption version');
  const b = Buffer.from(encoded.slice(3), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8'));
}
