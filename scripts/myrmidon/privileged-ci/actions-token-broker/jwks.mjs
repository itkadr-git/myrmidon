const JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const MAX_JWKS_BYTES = 128 * 1024;

// Fetch afresh; a network or parsing error must never fall back to untrusted keys.
export async function loadGitHubKeys(request = fetch) {
  const response = await request(JWKS_URL, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || response.status !== 200) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw new Error('GitHub JWKS unavailable');
  }
  let document;
  if (response.body === undefined && request !== fetch) {
    document = await response.json();
  } else {
    if (!response.body) throw new Error('invalid GitHub JWKS');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JWKS_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error('GitHub JWKS too large');
        }
        chunks.push(value);
      }
      document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { reader.releaseLock(); }
  }
  if (!document || !Array.isArray(document.keys)) throw new Error('invalid GitHub JWKS');
  return document.keys;
}
