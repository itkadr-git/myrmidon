import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const entities = new Map([
  ['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'],
  ...Array.from('|`[]!*_\\()', c => [c, `&#${c.codePointAt(0)};`]),
  ...Array.from({ length: 32 }, (_, n) => [String.fromCharCode(n), `&#${n};`]),
  ...Array.from({ length: 33 }, (_, n) => [String.fromCharCode(n + 127), `&#${n + 127};`]),
]);

function expected(value) {
  return Array.from(value, c => entities.get(c) ?? c).join('');
}

function fixture(path, specifier) {
  return {
    modules: [{ path, bytes: 7, eager: true }],
    edges: [{ from: path, specifier, kind: 'eager', to: null }],
    counts: { modules: 1, eagerModules: 1, edges: 1 },
    bytes: { total: 7, eager: 7 },
  };
}

function output(path, specifier) {
  return [
    '## Import report summary', '',
    'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |', '| modules | 1 |',
    '| eagerModules | 1 |', '| totalBytes | 7 |', '| eagerBytes | 7 |', '',
    '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |',
    `| ${expected(path)} | 7 |`, '', '### Unresolved dependencies', '',
    '| Specifier | Kind | From |', '| --- | --- | --- |',
    `| ${expected(specifier)} | eager | ${expected(path)} |`, '', 'Omitted: 0', '',
  ].join('\n');
}

test('encodes each untrusted path, specifier and from character without changing table structure', () => {
  const cases = [...entities.keys(), 'A', 'z', '0', ' ', '.', '/', ':', 'é', '中', '😀'];
  for (const field of ['path/from', 'specifier']) {
    for (const char of cases) {
      const value = `before${char}after`;
      const path = field === 'path/from' ? value : 'safe-path';
      const specifier = field === 'specifier' ? value : 'safe-package';
      const result = spawnSync(process.execPath, [cli], {
        input: JSON.stringify(fixture(path, specifier)), encoding: 'utf8', timeout: 10000,
      });
      const label = `${field} U+${char.codePointAt(0).toString(16)}`;
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.equal(result.stderr, '', label);
      assert.equal(result.stdout, output(path, specifier), label);
      assert.doesNotMatch(result.stdout, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/u, label);
    }
  }
});

test('renders HTML-like payloads as inert text without double encoding', () => {
  const path = '<script>alert("x&y")</script>|\n';
  const specifier = '[link](javascript:alert(1)) &amp; <img src=x>';
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(fixture(path, specifier)), encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, output(path, specifier));
});
