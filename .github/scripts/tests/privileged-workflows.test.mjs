import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const name of ['myrmidon-acceptance-scenarios.yml', 'commitperclip-review.yml']) {
  test(`${name} uses only base code in privileged jobs`, () => {
    const yaml = readFileSync(new URL(`../../workflows/${name}`, import.meta.url), 'utf8');
    assert.match(yaml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.doesNotMatch(yaml, /allow-unsafe-pr-checkout|(?<![\w-])ref:\s*\$\{\{\s*github\.event\.pull_request\.head|git\s+(?:fetch|checkout|switch)|\b(?:bash|sh|node)\s+\$\{\{/i);
    assert.match(yaml, /persist-credentials: false/);
  });
}
