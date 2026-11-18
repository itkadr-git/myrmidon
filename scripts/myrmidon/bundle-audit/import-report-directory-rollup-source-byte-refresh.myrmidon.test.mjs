import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const run = (script, arg, input) => {
  const result = spawnSync(process.execPath, [script, arg], { encoding: 'utf8', timeout: 10000, input });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

const sources = (eagerText, lazyText) => ({
  'entry.mjs': "import './eager/a.mjs';\nimport('./lazy/b.mjs');\nthrow new Error('must not execute entry');\n",
  'eager/a.mjs': `import '../shared/leaf.mjs';\nexport const value = '${eagerText}';\nthrow new Error('must not execute eager');\n`,
  'eager/sibling.mjs': "import '../shared/leaf.mjs';\nthrow new Error('must not execute eager sibling');\n",
  'shared/leaf.mjs': "throw new Error('must not execute shared leaf');\n",
  'lazy/b.mjs': `import './sibling.mjs';\n/* ${lazyText} */\nthrow new Error('must not execute lazy');\n`,
  'lazy/sibling.mjs': "throw new Error('must not execute lazy sibling');\n",
});

const states = [
  sources('a', 'a'),
  sources('longer ASCII value', 'longer ASCII comment'),
  sources('\u00e9\u732b', '\u96ea\nsecond line'),
];
// Keep the eager sibling reachable without changing any import between states.
for (const state of states) state['eager/a.mjs'] = "import './sibling.mjs';\n" + state['eager/a.mjs'];

const expected = source => {
  const size = path => Buffer.byteLength(source[path], 'utf8');
  return { entry: 'entry.mjs', directories: [
    { directory: '.', modules: 1, eagerModules: 1, totalBytes: size('entry.mjs'), eagerBytes: size('entry.mjs') },
    { directory: 'eager', modules: 2, eagerModules: 2, totalBytes: size('eager/a.mjs') + size('eager/sibling.mjs'), eagerBytes: size('eager/a.mjs') + size('eager/sibling.mjs') },
    { directory: 'lazy', modules: 2, eagerModules: 0, totalBytes: size('lazy/b.mjs') + size('lazy/sibling.mjs'), eagerBytes: 0 },
    { directory: 'shared', modules: 1, eagerModules: 1, totalBytes: size('shared/leaf.mjs'), eagerBytes: size('shared/leaf.mjs') },
  ] };
};

test('refreshes directory bytes from unchanged source paths and topology', () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'directory-refresh-'));
  try {
    const reportPath = join(root, 'report.json');
    const savedReportPath = join(root, 'report-a.json');
    let topology, firstOutput;
    assert.ok(Buffer.byteLength(states[2]['eager/a.mjs']) > states[2]['eager/a.mjs'].length);
    assert.ok(Buffer.byteLength(states[2]['lazy/b.mjs']) > states[2]['lazy/b.mjs'].length);
    for (const [index, source] of [states[0], states[1], states[2], states[0]].entries()) {
      for (const [path, content] of Object.entries(source)) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      const scan = run(scanner, join(root, 'entry.mjs'));
      const report = JSON.parse(scan);
      const currentTopology = { entry: report.entry, edges: report.edges, modules: report.modules.map(({ path, eager }) => ({ path, eager })) };
      if (index === 0) topology = currentTopology;
      else assert.deepEqual(currentTopology, topology);
      assert.deepEqual(report.modules.map(({ path, bytes }) => ({ path, bytes })), Object.keys(source).sort().map(path => ({ path, bytes: Buffer.byteLength(source[path], 'utf8') })));
      writeFileSync(reportPath, scan);
      const output = run(consumer, reportPath);
      assert.equal(output, JSON.stringify(expected(source)) + '\n');
      assert.equal(run(consumer, '-', scan), output);
      if (index === 0) {
        firstOutput = output;
        writeFileSync(savedReportPath, scan);
      }
      if (index === 1) {
        assert.notEqual(output, firstOutput);
        assert.equal(run(consumer, savedReportPath), firstOutput);
        assert.equal(run(consumer, '-', readFileSync(savedReportPath, 'utf8')), firstOutput);
      }
      if (index === 3) assert.equal(output, firstOutput);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
