import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cycles source-byte refresh node contract', () => {
  it('runs the actual node suite', () => {
    const script = resolve(import.meta.dirname, '../../../scripts/myrmidon/bundle-audit/import-report-cycles-source-byte-refresh.myrmidon.test.mjs');
    const result = spawnSync(process.execPath, ['--test', script], { encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  }, 35000);
});
