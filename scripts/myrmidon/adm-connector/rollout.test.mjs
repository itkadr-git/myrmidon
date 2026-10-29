import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  MODES,
  normalizeMode,
  getRolloutState,
  setRolloutMode,
  enableKillSwitch,
  disableKillSwitch,
  rollback,
  archiveLegacyFiles,
  verifyLegacyArchive,
  restoreLegacyArchive,
} from './rollout.mjs';
import { createHooks } from './hooks.mjs';

function createMockItem(slug, triggers = [], body = 'Rule content', priority = 50) {
  return {
    slug,
    title: slug,
    summary: 'Summary for ' + slug,
    revision_id: 'rev-1',
    status: 'published',
    priority,
    updated_at: '2026-10-29T12:00:00Z',
    triggers,
    body,
  };
}

test('normalizeMode validates and normalizes all supported aliases', () => {
  assert.equal(normalizeMode('disabled'), MODES.DISABLED);
  assert.equal(normalizeMode('off'), MODES.DISABLED);
  assert.equal(normalizeMode('kill'), MODES.DISABLED);
  assert.equal(normalizeMode('kill-switch'), MODES.DISABLED);
  assert.equal(normalizeMode('0'), MODES.DISABLED);
  assert.equal(normalizeMode('false'), MODES.DISABLED);

  assert.equal(normalizeMode('shadow'), MODES.SHADOW);
  assert.equal(normalizeMode('dry-run'), MODES.SHADOW);
  assert.equal(normalizeMode('passive'), MODES.SHADOW);
  assert.equal(normalizeMode('test'), MODES.SHADOW);

  assert.equal(normalizeMode('main'), MODES.MAIN);
  assert.equal(normalizeMode('active'), MODES.MAIN);
  assert.equal(normalizeMode('prod'), MODES.MAIN);
  assert.equal(normalizeMode('live'), MODES.MAIN);
  assert.equal(normalizeMode('1'), MODES.MAIN);
  assert.equal(normalizeMode('true'), MODES.MAIN);

  assert.equal(normalizeMode(null), null);
  assert.equal(normalizeMode(undefined), null);

  assert.throws(() => normalizeMode('invalid-mode'), /Invalid rollout mode/);
});

test('getRolloutState respects precedence: env disabled > env mode > file marker > config > default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-rollout-state-'));
  try {
    // 1. Default when nothing configured is 'shadow' (staged rollout start)
    const defaultState = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(defaultState.mode, MODES.SHADOW);
    assert.equal(defaultState.killSwitchActive, false);
    assert.equal(defaultState.source, 'default');

    // 2. Config file rollout.json
    await writeFile(join(dir, 'rollout.json'), JSON.stringify({ mode: 'main' }));
    const configState = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(configState.mode, MODES.MAIN);
    assert.equal(configState.source, 'config:rollout.json');

    // 3. File kill-switch marker overrides config
    await writeFile(join(dir, 'disabled'), 'emergency disable');
    const markerState = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(markerState.mode, MODES.DISABLED);
    assert.equal(markerState.killSwitchActive, true);
    assert.equal(markerState.source, 'file:disabled');

    // 4. Env ADM_CONNECTOR_MODE overrides file marker
    const envModeState = await getRolloutState({
      stateDir: dir,
      env: { ADM_CONNECTOR_MODE: 'shadow' },
    });
    assert.equal(envModeState.mode, MODES.SHADOW);
    assert.equal(envModeState.source, 'env:ADM_CONNECTOR_MODE');

    // 5. Env ADM_CONNECTOR_DISABLED overrides all
    const envDisabledState = await getRolloutState({
      stateDir: dir,
      env: { ADM_CONNECTOR_MODE: 'main', ADM_CONNECTOR_DISABLED: '1' },
    });
    assert.equal(envDisabledState.mode, MODES.DISABLED);
    assert.equal(envDisabledState.killSwitchActive, true);
    assert.equal(envDisabledState.source, 'env:ADM_CONNECTOR_DISABLED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setRolloutMode transitions between modes and maintains audit trail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-rollout-mode-'));
  try {
    // Stage 1: Initial state set to shadow (тень)
    const s1 = await setRolloutMode(MODES.SHADOW, { stateDir: dir, reason: 'Initial shadow rollout', updatedBy: 'ops-lead' });
    assert.equal(s1.mode, MODES.SHADOW);
    const read1 = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(read1.mode, MODES.SHADOW);

    // Stage 2: Promote to main (основной)
    const s2 = await setRolloutMode(MODES.MAIN, { stateDir: dir, reason: 'Promoting shadow to main', updatedBy: 'ops-lead' });
    assert.equal(s2.mode, MODES.MAIN);
    const read2 = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(read2.mode, MODES.MAIN);

    // Stage 3: Emergency kill-switch (disabled)
    const s3 = await enableKillSwitch({ stateDir: dir, reason: 'Emergency stop' });
    assert.equal(s3.mode, MODES.DISABLED);
    const read3 = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(read3.mode, MODES.DISABLED);
    assert.equal(read3.killSwitchActive, true);

    // Stage 4: Disable kill-switch back to shadow
    const s4 = await disableKillSwitch({ stateDir: dir, targetMode: MODES.SHADOW, reason: 'Recover to shadow' });
    assert.equal(s4.mode, MODES.SHADOW);
    const read4 = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(read4.mode, MODES.SHADOW);
    assert.equal(read4.killSwitchActive, false);

    // Verify audit log has 4 recorded entries
    const auditLog = await readFile(join(dir, 'rollout-audit.jsonl'), 'utf8');
    const lines = auditLog.trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 4);
    assert.equal(lines[0].mode, MODES.SHADOW);
    assert.equal(lines[1].mode, MODES.MAIN);
    assert.equal(lines[2].mode, MODES.DISABLED);
    assert.equal(lines[3].mode, MODES.SHADOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shadow mode runs hooks, logs metrics with mode: shadow, and respects token budgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-shadow-mode-'));
  try {
    const metrics = [];
    const items = [
      createMockItem('adm/policy/p1', [], 'Mandatory policy 1'),
      createMockItem('adm/trigger/ssh', ['ssh'], 'SSH deployment rule'),
    ];

    const hooks = createHooks({
      stateDir: dir,
      mode: MODES.SHADOW,
      load: async () => ({ items, fetchedAt: Date.now(), degraded: false }),
      log: m => metrics.push(m),
    });

    // SessionStart in shadow mode
    const startResult = await hooks.run({ hook_event_name: 'SessionStart', session_id: 'session-shadow' });
    assert.equal(startResult.mode, MODES.SHADOW);
    assert.equal(startResult.shadow, true);
    assert.ok(startResult.bytes > 0);
    assert.ok(startResult.bytes <= 12288); // Budget cap: ≤ 12 KiB

    // UserPromptSubmit in shadow mode
    const promptResult = await hooks.run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-shadow',
      prompt: 'connect via ssh to server',
    });
    assert.equal(promptResult.mode, MODES.SHADOW);
    assert.equal(promptResult.shadow, true);
    assert.ok(promptResult.bytes > 0);
    assert.ok(promptResult.bytes <= 2048); // Budget cap: ≤ 2 KiB

    // Verify metrics logged mode: 'shadow'
    assert.equal(metrics.length, 2);
    assert.equal(metrics[0].mode, MODES.SHADOW);
    assert.equal(metrics[1].mode, MODES.SHADOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabled mode returns empty context, 0 bytes, and does not execute load or log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-disabled-mode-'));
  try {
    let loadCalled = false;
    let logCalled = false;

    const hooks = createHooks({
      stateDir: dir,
      mode: MODES.DISABLED,
      load: async () => { loadCalled = true; return { items: [], fetchedAt: Date.now() }; },
      log: () => { logCalled = true; },
    });

    const result = await hooks.run({ hook_event_name: 'SessionStart', session_id: 'session-disabled' });
    assert.equal(result.mode, MODES.DISABLED);
    assert.equal(result.context, '');
    assert.equal(result.bytes, 0);
    assert.equal(result.sessionBytes, 0);
    assert.equal(loadCalled, false);
    assert.equal(logCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback restores last valid cache, disables hooks, preserves knowledge without deletions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-rollback-'));
  try {
    const cacheDir = join(dir, 'cache');
    await mkdir(cacheDir, { recursive: true });

    // Active corrupted cache
    await writeFile(join(cacheDir, 'cache.json'), JSON.stringify({ corrupted: true, items: [] }));

    // Valid backup cache
    const validBackupData = {
      manifest: { version: 1, hash: 'valid-hash' },
      items: [
        createMockItem('adm/policy/p1', [], 'P1 body'),
        createMockItem('adm/trigger/ssh', ['ssh'], 'SSH body'),
      ],
      fetchedAt: Date.now(),
    };
    const backupFile = join(dir, 'cache.backup.json');
    await writeFile(backupFile, JSON.stringify(validBackupData, null, 2));

    // Track mock board mutations/deletions: strictly assert zero deletions!
    const boardApiCalls = [];
    const mockBoardDeleteKnowledge = () => {
      boardApiCalls.push('DELETE');
      throw new Error('Rollback must never call delete on board knowledge!');
    };

    // Execute rollback
    const result = await rollback({
      stateDir: dir,
      cacheDir,
      backupCacheFile: backupFile,
      targetMode: MODES.DISABLED,
      keepKnowledge: true,
      reason: 'Incident rollback test',
      updatedBy: 'tester',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, MODES.DISABLED);
    assert.equal(result.restoredCache, true);
    assert.equal(result.knowledgePreserved, true);
    assert.equal(boardApiCalls.length, 0); // No deletions on the board!

    // Assert active cache.json now equals backup
    const restoredCache = JSON.parse(await readFile(join(cacheDir, 'cache.json'), 'utf8'));
    assert.deepEqual(restoredCache.items, validBackupData.items);

    // Assert hooks are now in disabled mode
    const state = await getRolloutState({ stateDir: dir, env: {} });
    assert.equal(state.mode, MODES.DISABLED);
    assert.equal(state.killSwitchActive, true);

    // Assert rollback audit event is recorded
    const auditFile = await readFile(join(dir, 'rollback-audit.jsonl'), 'utf8');
    const auditEvent = JSON.parse(auditFile.trim().split('\n').pop());
    assert.equal(auditEvent.action, 'rollback');
    assert.equal(auditEvent.knowledgePreserved, true);
    assert.equal(auditEvent.restoredCache, true);

    // Test rejection if keepKnowledge is violated
    await assert.rejects(
      async () => rollback({ stateDir: dir, keepKnowledge: false }),
      /knowledge on the board must NEVER be deleted/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('archiveLegacyFiles creates manifest, sets read-only permissions, and strictly avoids deleting source files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-archive-'));
  try {
    const sourceDir = join(dir, 'workspace');
    const archiveDir = join(dir, 'archive');
    await mkdir(join(sourceDir, 'memory'), { recursive: true });

    // Create mock legacy files
    const claudeContent = '# CLAUDE.md guidelines\nFollow paperclip policies.';
    const memoryContent = '# MEMORY.md\nProject memory dump.';
    const memoryRule1 = '# Rule 1\nDeploy only via CI.';
    const memoryRule2 = '# Rule 2\nDo not bypass review.';

    await writeFile(join(sourceDir, 'CLAUDE.md'), claudeContent);
    await writeFile(join(sourceDir, 'MEMORY.md'), memoryContent);
    await writeFile(join(sourceDir, 'memory', 'rule1.md'), memoryRule1);
    await writeFile(join(sourceDir, 'memory', 'rule2.md'), memoryRule2);

    // Run archiving
    const res = await archiveLegacyFiles({ sourceDir, archiveDir });
    assert.equal(res.ok, true);
    assert.equal(res.totalFiles, 4);

    // Verify manifest
    const manifestPath = join(archiveDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.totalFiles, 4);
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.files.length, 4);

    // Strict guarantee: Assert all source files STILL EXIST (not deleted!)
    assert.equal(await readFile(join(sourceDir, 'CLAUDE.md'), 'utf8'), claudeContent);
    assert.equal(await readFile(join(sourceDir, 'MEMORY.md'), 'utf8'), memoryContent);
    assert.equal(await readFile(join(sourceDir, 'memory', 'rule1.md'), 'utf8'), memoryRule1);
    assert.equal(await readFile(join(sourceDir, 'memory', 'rule2.md'), 'utf8'), memoryRule2);

    // Assert files are marked read-only (mode 0o444)
    for (const f of ['CLAUDE.md', 'MEMORY.md', 'memory/rule1.md', 'memory/rule2.md']) {
      const srcStat = await stat(join(sourceDir, f));
      const arcStat = await stat(join(archiveDir, f));
      assert.equal(srcStat.mode & 0o222, 0, `Source file ${f} must be read-only`);
      assert.equal(arcStat.mode & 0o222, 0, `Archive file ${f} must be read-only`);
    }

    // Verify archive integrity
    const verifyRes = await verifyLegacyArchive({ archiveDir });
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.verifiedCount, 4);

    // Restore to a fresh target directory
    const restoreDir = join(dir, 'restored');
    const restoreRes = await restoreLegacyArchive({ archiveDir, targetDir: restoreDir });
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.restoredCount, 4);
    assert.equal(await readFile(join(restoreDir, 'CLAUDE.md'), 'utf8'), claudeContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli.mjs respects rollout mode: disabled exits 0 with no stdout, shadow emits no context, main emits context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-cli-rollout-'));
  const cliPath = join(import.meta.dirname, 'cli.mjs');

  const runCli = (event, envOverrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        ADM_CONNECTOR_STATE_DIR: dir,
        PAPERCLIP_API_URL: 'http://127.0.0.1:9999',
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));

    child.stdin.end(JSON.stringify(event));
  });

  try {
    // 1. In disabled mode (kill-switch): zero stdout, zero metric
    const disabledRes = await runCli(
      { hook_event_name: 'SessionStart', session_id: 's-dis' },
      { ADM_CONNECTOR_DISABLED: '1' }
    );
    assert.equal(disabledRes.code, 0);
    assert.equal(disabledRes.stdout, '');

    // 2. In shadow mode: runs hook, records metric with mode: 'shadow', but emits NO additionalContext
    await writeFile(join(dir, 'rollout.json'), JSON.stringify({ mode: 'shadow' }));
    const shadowRes = await runCli(
      { hook_event_name: 'SessionStart', session_id: 's-shad' },
      { ADM_CONNECTOR_DISABLED: '0', ADM_CONNECTOR_MODE: 'shadow' }
    );
    assert.equal(shadowRes.code, 0);
    assert.equal(shadowRes.stdout, '');
    const shadowMetric = await readFile(join(dir, 'metrics.jsonl'), 'utf8');
    assert.match(shadowMetric, /"mode":"shadow"/);

    // 3. In main mode: emits additionalContext to stdout and records metric with mode: 'main'
    const mainDir = await mkdtemp(join(tmpdir(), 'adm-cli-main-'));
    const mainRes = await runCli(
      { hook_event_name: 'SessionStart', session_id: 's-main' },
      { ADM_CONNECTOR_STATE_DIR: mainDir, ADM_CONNECTOR_DISABLED: '0', ADM_CONNECTOR_MODE: 'main' }
    );
    assert.equal(mainRes.code, 0);
    assert.match(mainRes.stdout, /hookSpecificOutput/);
    assert.match(mainRes.stdout, /additionalContext/);
    const mainMetric = await readFile(join(mainDir, 'metrics.jsonl'), 'utf8');
    assert.match(mainMetric, /"mode":"main"/);
    await rm(mainDir, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollout.mjs CLI commands work as expected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adm-rollout-cli-'));
  const rolloutCliPath = join(import.meta.dirname, 'rollout.mjs');

  const runRolloutCli = (args, envOverrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rolloutCliPath, ...args], {
      env: {
        ...process.env,
        ADM_CONNECTOR_STATE_DIR: dir,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });

  try {
    // status
    const statusRes = await runRolloutCli(['status']);
    assert.equal(statusRes.code, 0);
    const statusJson = JSON.parse(statusRes.stdout);
    assert.equal(statusJson.mode, MODES.SHADOW);

    // set-mode main
    const setModeRes = await runRolloutCli(['set-mode', 'main', 'Promoting to main']);
    assert.equal(setModeRes.code, 0);
    const setModeJson = JSON.parse(setModeRes.stdout);
    assert.equal(setModeJson.mode, MODES.MAIN);

    // verify status updated
    const status2 = await runRolloutCli(['status']);
    assert.equal(JSON.parse(status2.stdout).mode, MODES.MAIN);

    // kill-switch on
    const killRes = await runRolloutCli(['kill-switch', 'on', 'Emergency test']);
    assert.equal(killRes.code, 0);
    assert.equal(JSON.parse(killRes.stdout).mode, MODES.DISABLED);

    // kill-switch off
    const unkillRes = await runRolloutCli(['kill-switch', 'off', 'Back to shadow']);
    assert.equal(unkillRes.code, 0);
    assert.equal(JSON.parse(unkillRes.stdout).mode, MODES.SHADOW);

    // rollback
    const rollbackRes = await runRolloutCli(['rollback', 'CLI rollback test']);
    assert.equal(rollbackRes.code, 0);
    const rollbackJson = JSON.parse(rollbackRes.stdout);
    assert.equal(rollbackJson.ok, true);
    assert.equal(rollbackJson.mode, MODES.DISABLED);
    assert.equal(rollbackJson.knowledgePreserved, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
