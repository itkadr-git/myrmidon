const API = 'https://api.github.com';

// The transport, signing key and policy are supplied by the server, never by callers.
export function createInstallationClient({ installationId, repositoryId, permissions, appJwt, request = fetch }) {
  if (!/^[1-9][0-9]*$/.test(installationId) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !permissions || !Object.keys(permissions).length || Object.values(permissions).some(value => !['read', 'write'].includes(value)) || typeof appJwt !== 'function') throw new Error('invalid installation policy');
  const body = JSON.stringify({ repository_ids: [repositoryId], permissions: { ...permissions } });
  return {
    async issue() {
      const jwt = await appJwt();
      const response = await request(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST', headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, body,
      });
      if (!response.ok) throw new Error('installation token issuance failed');
      const result = await response.json();
      if (typeof result.token !== 'string' || !result.token || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('invalid installation response');
      return { token: result.token, expiresAt: result.expires_at };
    },
    async revoke(token) {
      if (typeof token !== 'string' || !token) throw new Error('invalid token');
      const response = await request(`${API}/installation/token`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (!response.ok) throw new Error('installation token revocation failed');
    },
  };
}
