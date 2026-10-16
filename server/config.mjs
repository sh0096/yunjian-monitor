import { resolve } from 'node:path';
export function configuration(e = process.env) {
  const key = Buffer.from(e.ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 random bytes encoded as base64; run scripts/init.mjs.');
  if (e.ADMIN_PASSWORD_HASH!=='SETUP'&&!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(e.ADMIN_PASSWORD_HASH || '')) throw new Error('ADMIN_PASSWORD_HASH missing or invalid; run scripts/init.mjs.');
  const origin = new URL(e.PUBLIC_ORIGIN || 'http://127.0.0.1:8787');
  const production = e.NODE_ENV === 'production';
  if(e.ADMIN_PASSWORD_HASH==='SETUP'&&(production||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw new Error('First-run setup is available only through a loopback SSH tunnel.');
  if (origin.origin !== (e.PUBLIC_ORIGIN || 'http://127.0.0.1:8787')) throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash or path.');
  if (production && origin.protocol !== 'https:') throw new Error('Production requires HTTPS.');
  const host = e.HOST || '127.0.0.1';
  if (!production && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Development must listen on loopback only.');
  const port = Number(e.PORT || 8787);
  const pollSeconds = Number(e.POLL_SECONDS || 5);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) throw new Error('POLL_SECONDS must be between 5 and 3600.');
  return {key, password: e.ADMIN_PASSWORD_HASH, origin: origin.origin, production, host, port, dataDir: resolve(e.DATA_DIR || './data'), legacy: e.ENABLE_JD_LEGACY === 'true', deploymentMode:e.RUN_MODE==='server'?'server':'local', pollSeconds};
}
