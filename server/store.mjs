import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashToken, seal, unseal } from './crypto.mjs';
import {trafficDevices,aggregateMinute,minuteReadings} from './history.mjs';

export class Store {
  constructor(dir, key) {
    mkdirSync(dir, {recursive: true, mode: 0o700}); chmodSync(dir, 0o700);
    this.key = key;
    this.db = new DatabaseSync(join(dir, 'yunjian.sqlite'));
    chmodSync(join(dir, 'yunjian.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, credential TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'ready', error TEXT, next_poll INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS snapshots (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_id, at));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_at ON snapshots(at);
      CREATE TABLE IF NOT EXISTS fast_samples (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,at));
      CREATE TABLE IF NOT EXISTS minute_samples (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,at));
      CREATE TABLE IF NOT EXISTS daily_earnings (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,day TEXT NOT NULL,points REAL NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(account_id,day));`);
  }
  close() { this.db.close(); }
  adminHash() { return this.db.prepare("SELECT value FROM settings WHERE key='admin_hash'").get()?.value; }
  createAdminHash(hash) { return this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('admin_hash',?)").run(hash).changes===1; }
  setAdminHash(hash) { this.db.prepare("INSERT INTO settings(key,value) VALUES('admin_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash); this.db.prepare('DELETE FROM sessions').run(); }
  login() {
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
    const expires = Date.now() + 12 * 3600_000;
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hashToken(token), csrf, expires);
    return {token, csrf, expires};
  }
  session(token) { return token ? this.db.prepare('SELECT csrf,expires FROM sessions WHERE token=? AND expires>?').get(hashToken(token), Date.now()) : null; }
  logout(token) { if(token) this.db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(token)); }
  accounts() { return this.db.prepare('SELECT id,label,created,state,error,next_poll FROM accounts ORDER BY created').all(); }
  account(id) { return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id); }
  credential(id) { const a = this.account(id); return a ? unseal(a.credential, this.key, id) : null; }
  add(label, credential, id = randomUUID()) {
    this.db.prepare('INSERT INTO accounts(id,label,credential,created) VALUES(?,?,?,?)').run(id, label, seal(credential, this.key, id), Date.now());
    return id;
  }
  replace(id, label, credential) {
    this.db.prepare("UPDATE accounts SET label=?,credential=?,state='ready',error=NULL,next_poll=0 WHERE id=?").run(label, seal(credential,this.key,id),id);
  }
  remove(id) { this.db.prepare('DELETE FROM accounts WHERE id=?').run(id); }
  state(id, state, error, nextPoll) { this.db.prepare('UPDATE accounts SET state=?,error=?,next_poll=? WHERE id=?').run(state,error,nextPoll,id); }
  save(id, payload, at=Date.now()) {
    // Keep the newest reading each minute for history; latest() still changes
    // with every fast poll. Bound disk use independently of polling frequency.
    const minute=Math.floor(at/60_000)*60_000;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const devices=trafficDevices(payload.devices);
      const inserted=this.db.prepare('INSERT OR IGNORE INTO fast_samples VALUES(?,?,?)').run(id,at,JSON.stringify(devices)).changes;
      if(inserted){
        const previous=this.db.prepare('SELECT payload FROM minute_samples WHERE account_id=? AND at=?').get(id,minute);
        const aggregate=aggregateMinute(previous?JSON.parse(previous.payload):null,devices,at);
        this.db.prepare('INSERT INTO minute_samples VALUES(?,?,?) ON CONFLICT(account_id,at) DO UPDATE SET payload=excluded.payload').run(id,minute,JSON.stringify(aggregate));
      }
      if(/^\d{4}-\d{2}-\d{2}$/.test(payload.earningsDay||'')&&Number.isFinite(payload.earningsAt)&&Number.isFinite(payload.todayPoints)){
        this.db.prepare('INSERT INTO daily_earnings VALUES(?,?,?,?) ON CONFLICT(account_id,day) DO UPDATE SET points=excluded.points,observed_at=excluded.observed_at').run(id,payload.earningsDay,payload.todayPoints,payload.earningsAt);
      }
      this.db.prepare('DELETE FROM snapshots WHERE account_id=? AND at>=? AND at<?').run(id,minute,minute+60_000);
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(id,at,JSON.stringify({...payload,at}));
      this.db.prepare('DELETE FROM snapshots WHERE at<?').run(at-7*86400_000);
      this.db.prepare('DELETE FROM fast_samples WHERE at<?').run(at-2*3600_000);
      this.db.prepare('DELETE FROM minute_samples WHERE at<?').run(at-7*86400_000);
      this.db.prepare('DELETE FROM daily_earnings WHERE day<?').run(new Date(at+8*3600_000-90*86400_000).toISOString().slice(0,10));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  latest(id) { const a=this.db.prepare('SELECT payload FROM snapshots WHERE account_id=? ORDER BY at DESC LIMIT 1').get(id); return a ? JSON.parse(a.payload) : null; }
  history(id, since=Date.now()-86400_000) { return this.db.prepare('SELECT at,payload FROM snapshots WHERE account_id=? AND at>=? ORDER BY at LIMIT 1500').all(id,since).map(x=>({at:x.at,devices:JSON.parse(x.payload).devices.map(d=>({id:d.id,uploadBps:d.uploadBps,downloadBps:d.downloadBps,uploadRaw:d.uploadRaw,downloadRaw:d.downloadRaw,trafficUnit:d.trafficUnit}))})); }
  trafficHistory(id,hours=1,at=Date.now()) {
    const since=at-hours*3600_000,fast=hours<=1;
    const rows=this.db.prepare(`SELECT at,payload FROM ${fast?'fast_samples':'minute_samples'} WHERE account_id=? AND at>=? AND at<=? ORDER BY at LIMIT 2000`).all(id,since,at);
    const result=rows.map(r=>({at:r.at,resolution:fast?'sample':'minute',devices:fast?JSON.parse(r.payload):minuteReadings(JSON.parse(r.payload))}));
    // Preserve pre-upgrade history without inventing average or peak values.
    const boundary=result[0]?.at??at+1;
    const legacy=this.history(id,since).filter(r=>r.at<boundary).map(r=>({at:r.at,resolution:'legacy-minute',devices:trafficDevices(r.devices)}));
    return [...legacy,...result];
  }
  dailyEarnings(id) {return this.db.prepare('SELECT day,points,observed_at AS observedAt FROM daily_earnings WHERE account_id=? ORDER BY day DESC LIMIT 30').all(id).reverse();}
  backupStatus() {const row=this.db.prepare("SELECT value FROM settings WHERE key='backup_status'").get();return row?JSON.parse(row.value):null;}
}
