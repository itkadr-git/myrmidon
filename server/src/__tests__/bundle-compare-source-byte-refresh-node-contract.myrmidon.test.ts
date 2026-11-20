import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('compare source byte refresh node contract', () => {
  it('runs the scanner and consumer regression suite', () => {
    const testFile = resolve(import.meta.dirname, '../../../scripts/myrmidon/bundle-audit/import-report-compare-source-byte-refresh.myrmidon.test.mjs');
    const result = spawnSync(process.execPath, ['--test', testFile], { encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
  }, 40000);
});
