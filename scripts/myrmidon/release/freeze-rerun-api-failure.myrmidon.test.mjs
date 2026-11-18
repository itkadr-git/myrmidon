import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release-freeze-rerun.sh", import.meta.url));
const repo = "example-owner/example-repo";
const sha = "a".repeat(40);
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[2]?.includes('/pulls?')) {
  if (process.env.FAIL_LIST === 'pulls') process.exit(17);
  console.log(process.env.HEAD_SHA + ' 42');
} else if (args[0] === 'api' && args[2]?.includes('/actions/workflows/')) {
  if (process.env.FAIL_LIST === 'runs') process.exit(18);
  console.log('9001 ' + process.env.HEAD_SHA);
} else if (args[0] === 'run' && args[1] === 'rerun') {
  process.exit(0);
} else {
  console.error('unexpected gh invocation');
  process.exit(19);
}
`;

function exercise({ failList = '', gateOpen = true } = {}) {
  const root = process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(process.env.HOME, '.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'freeze-rerun-contract-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 });
    const gate = path.join(dir, 'gate');
    fs.writeFileSync(gate, `#!/usr/bin/env bash\n[[ "$#" -eq 1 && "$1" == --check ]] || exit 2\nexit ${gateOpen ? 0 : 1}\n`, { mode: 0o755 });
    const callsPath = path.join(dir, 'calls');
    const result = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 10000,
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir, BASH_ENV: '',
        GITHUB_REPOSITORY: repo, GITHUB_TOKEN: 'fake-token', GH_TOKEN: '',
        RELEASE_FREEZE_CHECK: gate, CALLS: callsPath, FAIL_LIST: failList, HEAD_SHA: sha,
      },
    });
    assert.ifError(result.error);
    const calls = fs.existsSync(callsPath)
      ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { result, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertPullQuery(call) {
  assert.deepEqual(call, ['api', '--paginate', `repos/${repo}/pulls?state=open&base=main&per_page=100`, '--jq', '.[] | "\\(.head.sha) \\(.number)"']);
}

function assertRunQuery(call) {
  assert.equal(call[0], 'api');
  assert.equal(call[1], '--paginate');
  assert.match(call[2], new RegExp(`^repos/${repo}/actions/workflows/myrmidon-release-freeze\\.yml/runs\\?event=pull_request&status=failure&created=%3E%3D\\d{4}-\\d{2}-\\d{2}&per_page=100$`));
  assert.deepEqual(call.slice(3), ['--jq', '.workflow_runs[] | "\\(.id) \\(.head_sha)"']);
}

test('pull listing failure stops before failed runs and rerun', () => {
  const { result, calls } = exercise({ failList: 'pulls' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '[release-freeze-rerun] ERROR: cannot list open pull requests\n');
  assert.equal(calls.length, 1);
  assertPullQuery(calls[0]);
});

test('failed-run listing failure stops before rerun', () => {
  const { result, calls } = exercise({ failList: 'runs' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '[release-freeze-rerun] ERROR: cannot list failed gate runs\n');
  assert.equal(calls.length, 2);
  assertPullQuery(calls[0]);
  assertRunQuery(calls[1]);
});

test('closed gate prevents every gh call even if listings would fail', () => {
  const { result, calls } = exercise({ failList: 'pulls', gateOpen: false });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '[release-freeze-rerun] the freeze is active or its state is unreadable — nothing to re-run\n');
  assert.deepEqual(calls, []);
});

test('open gate reruns exactly one current head', () => {
  const { result, calls } = exercise();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `[release-freeze-rerun] re-ran the gate run 9001 of PR #42 (${sha.slice(0, 12)})\n[release-freeze-rerun] re-ran 1 gate run(s), 0 could not be re-run\n`);
  assert.equal(calls.length, 3);
  assertPullQuery(calls[0]);
  assertRunQuery(calls[1]);
  assert.deepEqual(calls[2], ['run', 'rerun', '9001', '--failed', '--repo', repo]);
});
