import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const moduleOf = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, to, kind = 'eager', specifier = to ?? 'unknown') => ({ from, to, kind, specifier });
const run = (input, args = [], cwd = homedir()) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', cwd, timeout: 5000 });
const check = (report, expected) => {
  const input = JSON.stringify(report);
  for (const data of [input, input, JSON.stringify({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() })]) {
    const r = run(data);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `${JSON.stringify(expected)}\n`);
  }
};

// Enumerate vertex sequences directly, including duplicate-edge negative control.
function oracle(report, deduplicate = true) {
  let paths = [[report.entry]], shortest = new Map([[report.entry, [paths[0]]]]);
  while (paths.length) {
    const next = [];
    for (const path of paths) {
      let targets = report.edges.filter(e => e.from === path.at(-1) && e.kind === 'eager' && e.to !== null).map(e => e.to);
      if (deduplicate) targets = [...new Set(targets)];
      for (const target of targets) {
        if (path.includes(target)) continue;
        const candidate = [...path, target], old = shortest.get(target);
        if (!old) { shortest.set(target, [candidate]); next.push(candidate); }
        else if (old[0].length === candidate.length) { old.push(candidate); next.push(candidate); }
      }
    }
    paths = next;
  }
  const modules = [], unreachable = [];
  for (const mod of [...report.modules].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const found = shortest.get(mod.path);
    if (found) modules.push({ path: mod.path, depth: found[0].length - 1, shortestPaths: String(found.length) });
    else unreachable.push(mod.path);
  }
  return { entry: report.entry, modules, unreachable };
}

test('isolated entry and chain', () => {
  const isolated = { entry: 'e', modules: [moduleOf('e')], edges: [] };
  check(isolated, { entry: 'e', modules: [{ path: 'e', depth: 0, shortestPaths: '1' }], unreachable: [] });
  const chain = { entry: 'e', modules: ['e', 'a', 'b'].map(x => moduleOf(x)), edges: [edge('e', 'a'), edge('a', 'b')] };
  check(chain, oracle(chain));
});

test('oracle covers diamonds, aliases, lazy shortcut, cycles and exact identities', () => {
  const names = ['e', '__proto__', 'constructor', 'a|b', 'é', 'leaf', 'x', 'y'];
  const report = { entry: 'e', modules: [...names.map(x => moduleOf(x)), moduleOf('z', false), moduleOf('w', false)], edges: [edge('e', '__proto__'), edge('e', '__proto__', 'eager', 'alias'), edge('e', 'constructor'), edge('__proto__', 'a|b'), edge('constructor', 'a|b'), edge('a|b', 'é'), edge('a|b', 'x'), edge('é', 'leaf'), edge('x', 'leaf'), edge('leaf', 'y'), edge('e', 'leaf', 'lazy'), edge('e', null), edge('leaf', 'e'), edge('leaf', 'leaf'), edge('z', 'w'), edge('w', 'z')] };
  const expected = oracle(report);
  assert.equal(expected.modules.find(m => m.path === 'leaf').shortestPaths, '4');
  assert.notDeepEqual(expected, oracle(report, false));
  check(report, expected);
});

test('large layered DAG has exact count above 2^53', () => {
  const modules = [moduleOf('e')], edges = [];
  let prev = ['e'];
  for (let i = 0; i < 54; i++) {
    const next = [`${i}a`, `${i}b`];
    modules.push(...next.map(x => moduleOf(x)));
    for (const from of prev) for (const to of next) edges.push(edge(from, to));
    prev = next;
  }
  modules.push(moduleOf('end'));
  for (const from of prev) edges.push(edge(from, 'end'));
  // Add one independent route of the same length, making the total unrepresentable as a Number.
  let chain = 'e';
  for (let i = 0; i < 54; i++) {
    const next = `chain${i}`;
    modules.push(moduleOf(next));
    edges.push(edge(chain, next));
    chain = next;
  }
  edges.push(edge(chain, 'end'));
  const r = run(JSON.stringify({ entry: 'e', modules, edges }));
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  const output = JSON.parse(r.stdout);
  assert.equal(r.stdout, `${JSON.stringify(output)}\n`);
  assert.deepEqual(output.modules.find(m => m.path === 'end'), { path: 'end', depth: 55, shortestPaths: '18014398509481985' });
});

test('CLI errors classify and redact all data including disconnected graph', () => {
  const secret = 'synthetic-secret-sentinel';
  const valid = { entry: secret, modules: [moduleOf(secret), moduleOf('z', false)], edges: [] };
  const cases = [
    ['argv', JSON.stringify(valid), [secret]], ['json', `{${secret}`, []], ['shape', '{}', []],
    ['shape', JSON.stringify({ ...valid, modules: [moduleOf(secret), { ...moduleOf('z', false), bytes: 1.5 }] }), []],
    ['shape', JSON.stringify({ ...valid, edges: [edge('z', '')] }), []],
    ['graph', JSON.stringify({ ...valid, modules: [moduleOf(secret), moduleOf(secret)] }), []],
    ['graph', JSON.stringify({ ...valid, edges: [edge('z', 'missing')] }), []],
    ['graph', JSON.stringify({ ...valid, edges: [edge('z', 'z'), edge('z', 'z')] }), []],
    ['graph', JSON.stringify({ ...valid, modules: [moduleOf(secret, false), moduleOf('z', false)] }), []],
  ];
  for (const [category, input, args] of cases) {
    const r = run(input, args); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, `${category}\n`); assert.ok(!r.stderr.includes(secret));
  }
});

test('reads chunks until EOF', async () => {
  const input = JSON.stringify({ entry: 'e', modules: [moduleOf('e')], edges: [] });
  const child = spawn(process.execPath, [cli], { cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.write(input.slice(0, 7));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stdout, '');
  child.stdin.end(input.slice(7));
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0); assert.equal(stderr, '');
  assert.equal(stdout, `${JSON.stringify({ entry: 'e', modules: [{ path: 'e', depth: 0, shortestPaths: '1' }], unreachable: [] })}\n`);
});
