import { fileURLToPath } from 'node:url';
import { checkDocument, makeReader } from '../../scripts/check-acceptance-scenarios.mjs';

export async function checkAcceptance({ pr, expectedBase, expectedHead, expectedTitle, expectedBody, getDocument, reader }) {
  if (!/^[a-f0-9]{40}$/i.test(expectedBase) || pr.base?.sha !== expectedBase) throw Error('PR base changed');
  if (!/^[a-f0-9]{40}$/i.test(expectedHead) || pr.head?.sha !== expectedHead) throw Error('PR head changed');
  if (typeof expectedTitle !== 'string' || typeof expectedBody !== 'string') throw Error('Missing event title/body binding');
  if (pr.title !== expectedTitle || (pr.body ?? '') !== expectedBody) throw Error('Stale event: PR title or body differs from the triggering event');
  const keys = [...new Set(`${expectedTitle} ${expectedBody}`.match(/\bOPE-\d+\b/g) ?? [])];
  if (!keys.length) return { checked: 0, skipped: true };
  let checked = 0;
  for (const key of keys) {
    const body = await getDocument(key);
    if (typeof body !== 'string' || !body.trim()) throw Error(`${key}: missing document`);
    let doc;
    try { doc = JSON.parse(body); } catch { throw Error(`${key}: malformed JSON document`); }
    const result = checkDocument(doc, reader);
    if (result.problems.length) throw Error(`${key}: ${result.problems.join('; ')}`);
    if (!result.scenarioCount) throw Error(`${key}: document has zero scenarios`);
    checked++;
  }
  return { checked, skipped: false };
}

export function documentBody(key, doc, log = console.log) {
  const safeId = /^[a-zA-Z0-9-]{1,100}$/;
  if (!safeId.test(doc?.id ?? '') || !safeId.test(doc?.latestRevisionId ?? '')) throw Error(`${key}: missing or invalid document revision identity`);
  log(`${key}: document=${doc.id} revision=${doc.latestRevisionId} (snapshot; later edits require rerun)`);
  return doc.body;
}

function isLoopbackIPv4(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every((part) => /^\d+$/.test(part))) return false;
  const nums = parts.map((part) => parseInt(part, 10));
  if (nums.some((n) => n > 255)) return false;
  // First octet 127 covers dotted-quad, short (127.1) and partial forms.
  if (nums[0] === 127) return true;
  // The unspecified address is reachable on every local interface.
  return nums.every((n) => n === 0);
}

// Loopback must never receive the API credential, even over HTTPS: a
// localhost/127.0.0.1/[::1] "gateway" would be attacker-controllable on the
// runner. Only the fixed internal HTTPS/mTLS gateway hostname is acceptable.
function isLoopbackHost(hostname) {
  const host = (hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').replace(/%.*$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::' || host === '::1' || /^0:0:0:0:0:0:0:1$/.test(host)) return true;
  const mapped = host.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes(':')) {
      const groups = tail.split(':').map((group) => parseInt(group || '0', 16));
      const value = (((groups[groups.length - 2] ?? 0) << 16) + (groups[groups.length - 1] ?? 0)) >>> 0;
      return (value >>> 24) === 127;
    }
    return isLoopbackIPv4(tail);
  }
  if (host.includes(':')) return false;
  return isLoopbackIPv4(host);
}

export async function fetchJson(url, token) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw Error('Refusing non-HTTPS API URL: credentials must never leave the process over plaintext transport');
  if (isLoopbackHost(target.hostname)) throw Error('Refusing loopback API URL: the credential must go only to the fixed internal gateway, never to a local interface');
  const response = await fetch(target, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'myrmidon-acceptance-gate', Accept: 'application/json' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw Error(`API request failed: ${response.status} ${new URL(url).pathname}`);
  return response.json();
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, BASE_SHA, HEAD_SHA, EVENT_TITLE, EVENT_BODY, MYRMIDON_API_URL, MYRMIDON_API_KEY, MYRMIDON_COMPANY_ID } = process.env;
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GH_REPO ?? '') || !/^[1-9]\d*$/.test(PR_NUMBER ?? '') || EVENT_TITLE === undefined || EVENT_BODY === undefined || !MYRMIDON_API_URL || !MYRMIDON_API_KEY || !MYRMIDON_COMPANY_ID) throw Error('Missing or invalid gate configuration');
  const api = new URL(MYRMIDON_API_URL);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw Error('Invalid Myrmidon API URL');
  if (isLoopbackHost(api.hostname)) throw Error('Invalid Myrmidon API URL: loopback hosts are not allowed');
  const prUrl = `https://api.github.com/repos/${GH_REPO}/pulls/${PR_NUMBER}`;
  const pr = await fetchJson(prUrl, GH_TOKEN);
  const result = await checkAcceptance({ pr, expectedBase: BASE_SHA, expectedHead: HEAD_SHA, expectedTitle: EVENT_TITLE, expectedBody: EVENT_BODY, reader: makeReader({ ref: BASE_SHA }), getDocument: async (key) => {
    const root = MYRMIDON_API_URL.replace(/\/$/, '');
    const issue = await fetchJson(`${root}/api/issues/${key}`, MYRMIDON_API_KEY);
    if (issue.companyId !== MYRMIDON_COMPANY_ID || issue.identifier !== key) throw Error(`${key}: issue company or identifier mismatch`);
    const doc = await fetchJson(`${root}/api/issues/${key}/documents/acceptance-scenarios`, MYRMIDON_API_KEY);
    return documentBody(key, doc);
  } });
  const latest = await fetchJson(prUrl, GH_TOKEN);
  if (latest.head?.sha !== HEAD_SHA || latest.base?.sha !== BASE_SHA || latest.title !== EVENT_TITLE || (latest.body ?? '') !== EVENT_BODY) throw Error('Stale event: PR head, base, title or body changed during verification');
  console.log(result.skipped ? 'No linked OPE issues; acceptance check skipped. Documents verified: 0.' : `Documents verified: ${result.checked}. Base: ${BASE_SHA}; head: ${HEAD_SHA}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
