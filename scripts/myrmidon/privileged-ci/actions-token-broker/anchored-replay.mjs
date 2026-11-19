import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// The anchor must be provisioned independently of the replay database.
export async function createAnchoredReplayStore(path, key, anchor) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:') || !Buffer.isBuffer(key) || key.length !== 32 || typeof anchor?.read !== 'function' || typeof anchor?.compareAndSet !== 'function') throw new Error('invalid replay configuration');
  const secret = Buffer.from(key), db = new DatabaseSync(path);
  let busy = false;
  const digest = (seq, jti, expires, previous) => createHmac('sha256', secret).update(JSON.stringify([seq, jti, expires, previous])).digest('hex');
  const equal = (a, b) => a?.seq === b.seq && a?.mac === b.mac;
  function verify() {
    let seq = 0, mac = '';
    const claims = new Map();
    for (const row of db.prepare('SELECT seq, jti, expires, mac FROM replay_events ORDER BY seq').iterate()) {
      const expected = digest(row.seq, row.jti, row.expires, mac);
      if (row.seq !== seq + 1 || typeof row.mac !== 'string' || !/^[0-9a-f]{64}$/.test(row.mac) || !timingSafeEqual(Buffer.from(row.mac, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('replay integrity failure');
      seq = row.seq; mac = row.mac; claims.set(row.jti, row.expires);
    }
    return { seq, mac, claims };
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS replay_events (seq INTEGER PRIMARY KEY, jti TEXT NOT NULL, expires INTEGER NOT NULL, mac TEXT NOT NULL) STRICT');
    if (!equal(await anchor.read(), verify())) throw new Error('replay anchor mismatch');
  } catch (error) { db.close(); secret.fill(0); throw error; }
  return {
    async claimOnce(jti, expires, now = Math.floor(Date.now() / 1000)) {
      if (typeof jti !== 'string' || !jti || jti.length > 256 || !Number.isSafeInteger(expires) || !Number.isSafeInteger(now) || expires <= now || busy) throw new Error('invalid or concurrent replay claim');
      busy = true;
      let transaction = false;
      try {
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        const state = verify(), previous = { seq: state.seq, mac: state.mac };
        if (!equal(await anchor.read(), previous)) throw new Error('replay anchor mismatch');
        if ((state.claims.get(jti) ?? 0) > now) { db.exec('COMMIT'); transaction = false; return false; }
        const next = { seq: state.seq + 1, mac: digest(state.seq + 1, jti, expires, state.mac) };
        db.prepare('INSERT INTO replay_events VALUES (?, ?, ?, ?)').run(next.seq, jti, expires, next.mac);
        if (await anchor.compareAndSet(previous, next) !== true) throw new Error('replay anchor update failed');
        db.exec('COMMIT'); transaction = false;
        return true;
      } finally { try { if (transaction) db.exec('ROLLBACK'); } finally { busy = false; } }
    },
    close() { if (busy) throw new Error('replay busy'); db.close(); secret.fill(0); },
  };
}
