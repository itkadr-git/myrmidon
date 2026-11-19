import { fileURLToPath } from 'node:url';
import { checkDocument, makeReader } from '../../scripts/check-acceptance-scenarios.mjs';

export async function checkAcceptance({ pr, expectedBase, expectedHead, getDocument, reader }) {
  if (!/^[a-f0-9]{40}$/i.test(expectedBase) || pr.base?.sha !== expectedBase) throw Error('PR base changed');
  if (!/^[a-f0-9]{40}$/i.test(expectedHead) || pr.head?.sha !== expectedHead) throw Error('PR head changed');
  const keys = [...new Set(`${pr.title ?? ''} ${pr.body ?? ''}`.match(/\bOPE-\d+\b/g) ?? [])];
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

async function json(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'myrmidon-acceptance-gate', Accept: 'application/json' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw Error(`API request failed: ${response.status} ${new URL(url).pathname}`);
  return response.json();
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, BASE_SHA, HEAD_SHA, MYRMIDON_API_URL, MYRMIDON_API_KEY, MYRMIDON_COMPANY_ID } = process.env;
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GH_REPO ?? '') || !/^[1-9]\d*$/.test(PR_NUMBER ?? '') || !MYRMIDON_API_URL || !MYRMIDON_API_KEY || !MYRMIDON_COMPANY_ID) throw Error('Missing or invalid gate configuration');
  const api = new URL(MYRMIDON_API_URL);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash) throw Error('Invalid Myrmidon API URL');
  const prUrl = `https://api.github.com/repos/${GH_REPO}/pulls/${PR_NUMBER}`;
  const pr = await json(prUrl, GH_TOKEN);
  const result = await checkAcceptance({ pr, expectedBase: BASE_SHA, expectedHead: HEAD_SHA, reader: makeReader({ ref: BASE_SHA }), getDocument: async (key) => {
    const root = MYRMIDON_API_URL.replace(/\/$/, '');
    const issue = await json(`${root}/api/issues/${key}`, MYRMIDON_API_KEY);
    if (issue.companyId !== MYRMIDON_COMPANY_ID || issue.identifier !== key) throw Error(`${key}: issue company or identifier mismatch`);
    const doc = await json(`${root}/api/issues/${key}/documents/acceptance-scenarios`, MYRMIDON_API_KEY);
    return doc?.body;
  } });
  const latest = await json(prUrl, GH_TOKEN);
  if (latest.head?.sha !== HEAD_SHA || latest.base?.sha !== BASE_SHA || latest.title !== pr.title || latest.body !== pr.body) throw Error('PR head, base, title or body changed during verification');
  console.log(result.skipped ? 'No linked OPE issues; acceptance check skipped. Documents verified: 0.' : `Documents verified: ${result.checked}. Base: ${BASE_SHA}; head: ${HEAD_SHA}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
