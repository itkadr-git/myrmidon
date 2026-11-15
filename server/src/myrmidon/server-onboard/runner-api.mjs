// Keep credentials in request headers only; never include response bodies in errors.
export function createRunnerApi({ baseUrl, companyId, token, fetch: fetchImpl = globalThis.fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Fleet onboarding API requires an HTTPS URL without credentials');
  if (!companyId || !token) throw new Error('Fleet onboarding company and executor token are required');
  const prefix = new URL('/api/myrmidon/fleet/onboard-jobs/', base);
  async function post(path, body, emptyAllowed = false) {
    const response = await fetchImpl(new URL(path, prefix), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-onboard-token': token },
      body: JSON.stringify({ ...body, companyId }),
      redirect: 'error',
    });
    if (emptyAllowed && response.status === 204) return null;
    if (!response.ok) throw new Error(`Fleet onboarding API returned HTTP ${response.status}`);
    return response.json();
  }
  return {
    claim: () => post('claim', {}, true),
    report: (jobId, report) => {
      if ('companyId' in report) return Promise.reject(new Error('companyId cannot be overridden'));
      return post(`${encodeURIComponent(jobId)}/report`, report);
    },
    recordOwnedResource: (jobId, resource) => post(`${encodeURIComponent(jobId)}/owned-resources`, { resource }),
  };
}
