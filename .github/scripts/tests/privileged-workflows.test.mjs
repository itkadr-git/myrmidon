import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

function checkScriptGraph(entry) {
  const seen = new Set();
  const visit = (url) => {
    const path = fileURLToPath(url);
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:node:)?child_process|\b(?:eval|Function)\s*\(|\bimport\s*\(/, `${path} must not execute dynamic code`);
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      visit(pathToFileURL(resolve(dirname(path), match[1])));
    }
  };
  visit(entry);
  return seen;
}

test('review gate and all local imports cannot execute PR code', () => {
  const scripts = checkScriptGraph(new URL('../run-quality-gates.mjs', import.meta.url));
  assert.ok(scripts.has(fileURLToPath(new URL('../check-pr-dependencies.mjs', import.meta.url))));
  assert.ok(scripts.has(fileURLToPath(new URL('../check-pr-release-bootstrap.mjs', import.meta.url))));
});

// The acceptance gate walks one extra local import (the trusted-base reader)
// which legitimately spawns read-only `git show <base-ref>:<path>` lookups.
// Dynamic execution (eval/Function/dynamic import/shell) stays forbidden in
// the whole graph; child_process is allowed only as that static read-only git
// access in the reader module.
function checkAcceptanceScriptGraph(entry) {
  const seen = new Set();
  const visit = (url) => {
    const path = fileURLToPath(url);
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\b(?:eval|Function)\s*\(|\bimport\s*\(|\bexecSync\b|shell:\s*true/, `${path} must not execute dynamic code`);
    if (source.includes('child_process')) {
      assert.ok(path.endsWith('scripts/check-acceptance-scenarios.mjs'), `${path} unexpectedly uses child_process`);
      assert.doesNotMatch(source, /spawnSync\(\s*["'](?:bash|sh|python|curl|wget)["']/);
      assert.doesNotMatch(source, /spawnSync\([^)]*shell\s*:/s);
    }
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      visit(pathToFileURL(resolve(dirname(path), match[1])));
    }
  };
  visit(entry);
  return seen;
}

test('acceptance gate and all local imports cannot execute PR code', () => {
  const scripts = checkAcceptanceScriptGraph(new URL('../acceptance-gate.mjs', import.meta.url));
  assert.ok(scripts.has(fileURLToPath(new URL('../../../scripts/check-acceptance-scenarios.mjs', import.meta.url))));
});

test('commitperclip-review.yml requires no app secrets and uses minimal github.token permissions', () => {
  const yaml = readFileSync(new URL('../../workflows/commitperclip-review.yml', import.meta.url), 'utf8');
  const code = yaml.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  // No commitperclip App private key / token generation on the public runner:
  // the gates only read PR data and post/update issue comments.
  assert.doesNotMatch(code, /COMMITPERCLIP_KEY|3718661|get-bot-token/);
  assert.doesNotMatch(code, /secrets\./);
  assert.match(code, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(code, /^\s*contents: read$/m);
  assert.match(code, /^\s*pull-requests: read$/m);
  assert.match(code, /^\s*issues: write$/m);
});

test('myrmidon-acceptance-scenarios.yml is the only privileged workflow holding secrets', () => {
  for (const name of ['myrmidon-acceptance-scenarios.yml', 'commitperclip-review.yml']) {
    const yaml = readFileSync(new URL(`../../workflows/${name}`, import.meta.url), 'utf8');
    const code = yaml.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    for (const match of code.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      assert.ok(match[1].startsWith('MYRMIDON_ACCEPTANCE_'), `${name} must not reference secrets.${match[1]}; only the dedicated acceptance reader secrets are allowed`);
    }
  }
});

for (const name of ['myrmidon-acceptance-scenarios.yml', 'commitperclip-review.yml']) {
  test(`${name} uses only base code in privileged jobs`, () => {
    const yaml = readFileSync(new URL(`../../workflows/${name}`, import.meta.url), 'utf8');
    assert.match(yaml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.doesNotMatch(yaml, /allow-unsafe-pr-checkout|(?<![\w-])ref:\s*\$\{\{\s*github\.event\.pull_request\.head|git\s+(?:fetch|checkout|switch)|\b(?:bash|sh|node)\s+\$\{\{/i);
    assert.match(yaml, /persist-credentials: false/);
    assert.match(yaml, /types: \[[^\]]*\bedited\b/);
    assert.match(yaml, /package-manager-cache: false/);
  });
}
