import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitleaksScan } from './adm-migrate.mjs';

const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.SHIM_CAPTURE, JSON.stringify({ args, input, config: process.env.GITLEAKS_CONFIG ?? null, configPath: process.env.GITLEAKS_CONFIG_PATH ?? null }));
const report = args.find((arg) => arg.startsWith('--report-path='))?.slice('--report-path='.length);
if (process.env.SHIM_REPORT !== 'missing') fs.writeFileSync(report, process.env.SHIM_REPORT);
process.exit(Number(process.env.SHIM_EXIT));
`;

function runScanner({ status = 0, report = '', missingBin = false, input = 'line one\nline two\n', check }) {
  const root = mkdtempSync(join(tmpdir(), 'adm-process-test-'));
  const bin = join(root, 'scanner');
  const capture = join(root, 'capture.json');
  const keys = ['ADM_GITLEAKS_BIN', 'GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_PATH', 'SHIM_CAPTURE', 'SHIM_REPORT', 'SHIM_EXIT'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const before = new Set(readdirSync(tmpdir()));
  try {
    writeFileSync(bin, shim, { mode: 0o755 });
    Object.assign(process.env, {
      ADM_GITLEAKS_BIN: missingBin ? join(root, 'absent') : bin,
      GITLEAKS_CONFIG: 'config-must-not-leak',
      GITLEAKS_CONFIG_PATH: 'path-must-not-leak',
      SHIM_CAPTURE: capture,
      SHIM_REPORT: report,
      SHIM_EXIT: String(status),
    });
    let result;
    let error;
    try { result = gitleaksScan(input); } catch (caught) { error = caught; }
    const observed = missingBin ? null : JSON.parse(readFileSync(capture, 'utf8'));
    check({ result, error, observed, input });
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    const leaked = readdirSync(tmpdir()).filter((name) => !before.has(name) && name.startsWith('adm-gitleaks-'));
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(leaked, [], 'scanner report directory must be removed');
  }
}

const clean = { clean: true, findings: [] };

test('scanner receives exact stdin and required argv', () => {
  runScanner({ input: 'synthetic input\nUnicode: \u2603\n', check: ({ result, error, observed, input }) => {
    assert.equal(error, undefined);
    assert.deepEqual(result, clean);
    assert.equal(observed.input, input);
    assert.deepEqual(observed.args.slice(0, 3), ['stdin', '--no-banner', '--report-format=json']);
    assert.equal(observed.args.length, 4);
    assert.match(observed.args[3], /^--report-path=.+\/adm-gitleaks-[^/]+\/report\.json$/);
  } });
});

test('scanner child does not inherit GITLEAKS_CONFIG', () => {
  runScanner({ check: ({ observed }) => assert.equal(observed.config, null) });
});

test('scanner child does not inherit GITLEAKS_CONFIG_PATH', () => {
  runScanner({ check: ({ observed }) => assert.equal(observed.configPath, null) });
});

test('exit zero is clean', () => {
  runScanner({ status: 0, check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one returns JSON findings', () => {
  const findings = [{ RuleID: 'synthetic', Secret: 'fixture-value', StartLine: 2 }];
  runScanner({ status: 1, report: JSON.stringify(findings), check: ({ result, error }) => {
    assert.equal(error, undefined);
    assert.deepEqual(result, { clean: false, findings });
  } });
});

test('exit one with empty report is clean', () => {
  runScanner({ status: 1, report: '', check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one with whitespace report is clean', () => {
  runScanner({ status: 1, report: ' \n ', check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one with empty JSON array is clean', () => {
  runScanner({ status: 1, report: '[]', check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one with malformed report rejects', () => {
  runScanner({ status: 1, report: '[invalid', check: ({ error }) => assert.ok(error instanceof SyntaxError) });
});

test('exit one with missing report rejects', () => {
  runScanner({ status: 1, report: 'missing', check: ({ error }) => assert.equal(error?.code, 'ENOENT') });
});

test('exit two fails closed', () => {
  runScanner({ status: 2, check: ({ error }) => assert.match(error?.message ?? '', /failed closed with status 2/) });
});

test('missing executable fails closed', () => {
  runScanner({ missingBin: true, check: ({ error }) => assert.equal(error?.code, 'ENOENT') });
});
