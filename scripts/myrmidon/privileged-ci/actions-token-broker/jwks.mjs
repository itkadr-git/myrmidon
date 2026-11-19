const JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';

// Fetch afresh; a network or parsing error must never fall back to untrusted keys.
export async function loadGitHubKeys(request = fetch) {
  const response = await request(JWKS_URL, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || response.status !== 200) throw new Error('GitHub JWKS unavailable');
  const document = await response.json();
  if (!document || !Array.isArray(document.keys)) throw new Error('invalid GitHub JWKS');
  return document.keys;
}
