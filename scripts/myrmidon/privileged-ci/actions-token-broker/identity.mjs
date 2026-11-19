import { createPublicKey, verify } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const FIELDS = ['repository_id', 'repository_owner_id', 'repository', 'job_workflow_ref', 'ref', 'environment', 'event_name'];

// claimOnce must atomically persist the JTI through its expiry, across restarts and instances.
export async function verifyIdentity(token, { policy, loadKeys, claimOnce, now = Math.floor(Date.now() / 1000) }) {
  const reject = () => { throw new Error('identity rejected'); };
  if (typeof token !== 'string' || token.length > 16384) return reject();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return reject();
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { return reject(); }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit !== undefined) return reject();
  const keys = await loadKeys();
  if (!Array.isArray(keys)) return reject();
  const candidates = keys.filter(k => k.kid === header.kid && k.kty === 'RSA' && k.use === 'sig' && k.alg === 'RS256');
  if (candidates.length !== 1) return reject();
  try {
    const key = createPublicKey({ key: candidates[0], format: 'jwk' });
    if (key.asymmetricKeyDetails.modulusLength < 2048 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return reject();
  } catch { return reject(); }
  if (!claims || claims.iss !== ISSUER || typeof policy.audience !== 'string' || !policy.audience || claims.aud !== policy.audience) return reject();
  if (!Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.nbf) || !Number.isSafeInteger(claims.iat) || claims.exp <= now || claims.nbf > now || claims.iat > now || claims.exp <= claims.iat || claims.nbf > claims.exp) return reject();
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) return reject();
  if (!/^[1-9][0-9]*$/.test(policy.repository_id) || !/^[1-9][0-9]*$/.test(policy.repository_owner_id)) return reject();
  for (const field of FIELDS) if (typeof policy[field] !== 'string' || !policy[field] || claims[field] !== policy[field]) return reject();
  if (!await claimOnce(claims.jti, claims.exp)) return reject();
  return claims;
}
