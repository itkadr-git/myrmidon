import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const names = Array.from({ length: 12000 }, (_, i) => `node-${String(i).padStart(5, '0')}`);
const extra = ['other-a', 'other-b'];
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });

function fixture(closing) {
  const paths = [...names, ...extra];
  const edges = names.slice(1).map((to, i) => edge(names[i], to));
  edges.push(edge(extra[0], extra[1]), edge(extra[1], extra[1]));
  if (closing) edges.push(edge(names.at(-1), names[0], closing));
  return { entry: names[0], modules: paths.map(path => ({ path, bytes: 1, eager: true })), edges };
}

function expected(cyclic) {
  const components = cyclic
    ? [{ id: names[0], paths: names, bytes: names.length }]
    : names.map(path => ({ id: path, paths: [path], bytes: 1 }));
  components.push(...extra.map(path => ({ id: path, paths: [path], bytes: 1 })));
  const edges = cyclic ? [] : names.slice(1).map((to, i) => ({ from: names[i], to }));
  edges.push({ from: extra[0], to: extra[1] });
  return { entry: names[0], components, edges };
}

for (const closing of [null, 'eager', 'lazy']) {
  test(`deep condensation: ${closing ?? 'DAG'} closing edge`, t => {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    const tmp = mkdtempSync(join(root, 'condensation-scale-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const report = fixture(closing);
    const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
    for (const mode of ['eager', 'all']) {
      const outputs = [report, reversed].map(input => {
        const result = spawnSync(process.execPath, [cli, mode], {
          input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
          maxBuffer: 32 * 1024 * 1024, shell: false, env: { ...process.env, TMPDIR: tmp },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        return result.stdout;
      });
      const cyclic = closing === 'eager' || (closing === 'lazy' && mode === 'all');
      const actual = JSON.stringify(JSON.parse(outputs[0]));
      const wanted = JSON.stringify(expected(cyclic));
      assert.ok(actual === wanted, `${mode}: complete condensation does not match fixture geometry`);
      assert.equal(outputs[1], outputs[0], 'reversed input must produce identical bytes');
    }
  });
}
