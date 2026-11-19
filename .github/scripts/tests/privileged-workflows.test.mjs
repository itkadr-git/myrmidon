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
