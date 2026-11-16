import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const worker = `
import { gitleaksScan } from ${JSON.stringify(new URL('./adm-migrate.mjs', import.meta.url).href)};
try { console.log(JSON.stringify({ result: gitleaksScan(process.env.SCAN_INPUT) })); }
catch (error) { console.log(JSON.stringify({ error: { name: error.name, message: error.message, code: error.code } })); }
`;

const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
if (process.env.SHIM_REPORT === 'hang') {
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(process.env.SHIM_CAPTURE, JSON.stringify({ args, input, config: process.env.GITLEAKS_CONFIG ?? null, configPath: process.env.GITLEAKS_CONFIG_PATH ?? null }));
  const report = args.find((arg) => arg.startsWith('--report-path='))?.slice('--report-path='.length);
  if (process.env.SHIM_REPORT !== 'missing') fs.writeFileSync(report, process.env.SHIM_REPORT);
  process.exit(Number(process.env.SHIM_EXIT));
}
`;

async function runScanner({ status = 0, report = '', missingBin = false, input = 'line one\nline two\n', check }) {
  const root = mkdtempSync(join(tmpdir(), 'adm-process-test-'));
  const bin = join(root, 'scanner');
  const capture = join(root, 'capture.json');
  const keys = ['ADM_GITLEAKS_BIN', 'GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_PATH', 'SHIM_CAPTURE', 'SHIM_REPORT', 'SHIM_EXIT'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let timedOut = false;
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
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
      env: { ...process.env, SCAN_INPUT: input, TMPDIR: root },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 5000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(timedOut, false, 'scanner subprocess timed out');
    assert.equal(code, 0, `scanner worker failed: ${stderr}`);
    const response = JSON.parse(stdout);
    const error = response.error && Object.assign(new Error(response.error.message), response.error);
    const observed = missingBin ? null : JSON.parse(readFileSync(capture, 'utf8'));
    check({ result: response.result, error, observed, input });
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    const leaked = readdirSync(root).filter((name) => name.startsWith('adm-gitleaks-'));
    rmSync(root, { recursive: true, force: true });
    if (!timedOut) assert.deepEqual(leaked, [], 'scanner report directory must be removed');
  }
}

test('hanging scanner is terminated by the harness', async () => {
  await assert.rejects(runScanner({ report: 'hang', check: () => assert.fail('scanner must time out') }), /scanner subprocess timed out/);
});

const clean = { clean: true, findings: [] };

test('scanner receives exact stdin and required argv', () => {
  return runScanner({ input: 'synthetic input\nUnicode: \u2603\n', check: ({ result, error, observed, input }) => {
    assert.equal(error, undefined);
    assert.deepEqual(result, clean);
    assert.equal(observed.input, input);
    assert.deepEqual(observed.args.slice(0, 3), ['stdin', '--no-banner', '--report-format=json']);
    assert.equal(observed.args.length, 4);
    assert.match(observed.args[3], /^--report-path=.+\/adm-gitleaks-[^/]+\/report\.json$/);
  } });
});

test('scanner child does not inherit GITLEAKS_CONFIG', () => {
  return runScanner({ check: ({ observed }) => assert.equal(observed.config, null) });
});

test('scanner child does not inherit GITLEAKS_CONFIG_PATH', () => {
  return runScanner({ check: ({ observed }) => assert.equal(observed.configPath, null) });
});

test('exit zero is clean', () => {
  return runScanner({ status: 0, check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one returns JSON findings', () => {
  const findings = [{ RuleID: 'synthetic', Secret: 'fixture-value', StartLine: 2 }];
  return runScanner({ status: 1, report: JSON.stringify(findings), check: ({ result, error }) => {
    assert.equal(error, undefined);
    assert.deepEqual(result, { clean: false, findings });
  } });
});

test('exit one with empty report is clean', () => {
  return runScanner({ status: 1, report: '', check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one with whitespace report is clean', () => {
  return runScanner({ status: 1, report: ' \n ', check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one with empty JSON array is clean', () => {
  return runScanner({ status: 1, report: '[]', check: ({ result, error }) => { assert.equal(error, undefined); assert.deepEqual(result, clean); } });
});

test('exit one with malformed report rejects', () => {
  return runScanner({ status: 1, report: '[invalid', check: ({ error }) => assert.equal(error?.name, 'SyntaxError') });
});

test('exit one with missing report rejects', () => {
  return runScanner({ status: 1, report: 'missing', check: ({ error }) => assert.equal(error?.code, 'ENOENT') });
});

test('exit two fails closed', () => {
  return runScanner({ status: 2, check: ({ error }) => assert.match(error?.message ?? '', /failed closed with status 2/) });
});

test('missing executable fails closed', () => {
  return runScanner({ missingBin: true, check: ({ error }) => assert.equal(error?.code, 'ENOENT') });
});
