// Sources must return metadata only. Never pass secret values or memory contents.
// A successful check requires a positive capability result, not just a binding ID.
export async function preflight(expected, source) {
  const checks = {};
  async function check(name, fn) {
    try { checks[name] = await fn(); } catch { checks[name] = 'UNKNOWN'; }
  }
  const validList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  const containsAll = (actual, required) => required.every((item) => actual.includes(item));
  await check('identity', async () => {
    const value = await source.identity();
    if (!value || ![value.companyId, value.agentId, expected?.companyId, expected?.agentId]
      .every((id) => typeof id === 'string' && id.trim().length > 0)) return 'UNKNOWN';
    return value.companyId === expected.companyId && value.agentId === expected.agentId ? 'PASS' : 'FAIL';
  });
  await check('bindings', async () => {
    const value = await source.bindings();
    if (!Array.isArray(value) || !validList(expected.bindings)) return 'UNKNOWN';
    for (const key of expected.bindings) {
      const binding = value.find((item) => item?.key === key);
      if (!binding) return 'FAIL';
      if (binding.resolvable === false) return 'FAIL';
      if (binding.resolvable !== true) return 'UNKNOWN';
    }
    return 'PASS';
  });
  for (const name of ['skills', 'instructions']) {
    await check(name, async () => {
      const value = await source[name]();
      if (!validList(value) || !validList(expected[name])) return 'UNKNOWN';
      return containsAll(value, expected[name]) ? 'PASS' : 'FAIL';
    });
  }
  await check('memory', async () => {
    const value = await source.memory();
    if (!value || typeof value.namespace !== 'string' || typeof expected.memoryNamespace !== 'string') return 'UNKNOWN';
    if (value.namespace !== expected.memoryNamespace || value.accessible === false) return 'FAIL';
    return value.accessible === true ? 'PASS' : 'UNKNOWN';
  });
  const values = Object.values(checks);
  return { status: values.includes('FAIL') ? 'FAIL' : values.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS', checks };
}
