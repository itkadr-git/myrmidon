const API = 'https://api.github.com';

// The transport, signing key and policy are supplied by the server, never by callers.
export function createInstallationClient({ installationId, repositoryId, permissions, appJwt, request = fetch }) {
  if (!/^[1-9][0-9]*$/.test(installationId) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !permissions || !Object.keys(permissions).length || Object.values(permissions).some(value => !['read', 'write'].includes(value)) || typeof appJwt !== 'function') throw new Error('invalid installation policy');
  const fixedPermissions = { ...permissions };
  const body = JSON.stringify({ repository_ids: [repositoryId], permissions: fixedPermissions });
  return {
    async issue() {
      const jwt = await appJwt();
      const response = await request(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, body,
      });
      if (!response.ok) throw new Error('installation token issuance failed');
      const result = await response.json();
      if (typeof result.token !== 'string' || !result.token) throw new Error('invalid installation response');
      const allowedPermissions = { ...fixedPermissions, metadata: 'read' };
      const scopeValid = result.permissions && typeof result.permissions === 'object' && !Array.isArray(result.permissions)
        && Object.entries(result.permissions).every(([name, value]) => allowedPermissions[name] === value)
        && Object.entries(fixedPermissions).every(([name, value]) => result.permissions[name] === value)
        && Array.isArray(result.repositories) && result.repositories.length === 1 && result.repositories[0]?.id === repositoryId;
      if (!scopeValid || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) {
        await this.revoke(result.token);
        throw new Error('invalid installation response');
      }
      return { token: result.token, expiresAt: result.expires_at };
    },
    async revoke(token) {
      if (typeof token !== 'string' || !token) throw new Error('invalid token');
      const response = await request(`${API}/installation/token`, { method: 'DELETE', redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (!response.ok) throw new Error('installation token revocation failed');
    },
  };
}
