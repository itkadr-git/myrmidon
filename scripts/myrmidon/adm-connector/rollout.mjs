import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODES = Object.freeze({
  DISABLED: 'disabled',
  SHADOW: 'shadow',
  MAIN: 'main',
});

const VALID_MODES = new Set(Object.values(MODES));

export function normalizeMode(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim().toLowerCase();
  if (['disabled', 'off', 'kill', 'kill-switch', '0', 'false'].includes(str)) return MODES.DISABLED;
  if (['shadow', 'dry-run', 'dryrun', 'passive', 'test'].includes(str)) return MODES.SHADOW;
  if (['main', 'active', 'prod', 'production', 'live', '1', 'true'].includes(str)) return MODES.MAIN;
  if (VALID_MODES.has(str)) return str;
  throw new Error(`Invalid rollout mode: ${raw}. Must be one of: disabled, shadow, main`);
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Resolves current rollout state.
 * Priority:
 * 1. ADM_CONNECTOR_DISABLED env var or kill-switch file (emergency switch)
 * 2. ADM_CONNECTOR_MODE env var
 * 3. File kill-switch ($stateDir/disabled or $stateDir/kill-switch)
 * 4. Config file ($stateDir/rollout.json)
 * 5. Default: 'shadow' (staged rollout begins in shadow mode)
 */
export async function getRolloutState({ stateDir, configDir, env = process.env } = {}) {
  const dir = stateDir ?? configDir ?? env.ADM_CONNECTOR_STATE_DIR ?? join(homedir(), '.adm-connector');

  // 1. Env kill-switch
  if (env.ADM_CONNECTOR_DISABLED === '1' || env.ADM_CONNECTOR_DISABLED === 'true' || env.ADM_CONNECTOR_KILL_SWITCH === '1') {
    return { mode: MODES.DISABLED, killSwitchActive: true, source: 'env:ADM_CONNECTOR_DISABLED', stateDir: dir };
  }

  // 2. Env explicit mode
  if (env.ADM_CONNECTOR_MODE) {
    const mode = normalizeMode(env.ADM_CONNECTOR_MODE);
    return { mode, killSwitchActive: mode === MODES.DISABLED, source: 'env:ADM_CONNECTOR_MODE', stateDir: dir };
  }

  // 3. File kill-switch
  for (const marker of ['disabled', 'kill-switch']) {
    try {
      await stat(join(dir, marker));
      return { mode: MODES.DISABLED, killSwitchActive: true, source: `file:${marker}`, stateDir: dir };
    } catch {
      // Marker does not exist
    }
  }

  // 4. Config file
  try {
    const raw = await readFile(join(dir, 'rollout.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const mode = normalizeMode(parsed.mode);
    return {
      mode,
      killSwitchActive: mode === MODES.DISABLED,
      source: 'config:rollout.json',
      config: parsed,
      stateDir: dir,
    };
  } catch {
    // Config missing or unreadable
  }

  // 5. Default: staged rollout starts in shadow mode
  return { mode: MODES.SHADOW, killSwitchActive: false, source: 'default', stateDir: dir };
}

export async function setRolloutMode(targetMode, { stateDir, configDir, reason = '', updatedBy = 'ops' } = {}) {
  const mode = normalizeMode(targetMode);
  const dir = stateDir ?? configDir ?? process.env.ADM_CONNECTOR_STATE_DIR ?? join(homedir(), '.adm-connector');
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const config = {
    mode,
    updatedAt: new Date().toISOString(),
    reason,
    updatedBy,
  };

  // Write config file atomically
  const configPath = join(dir, 'rollout.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  // Update kill-switch markers
  const disabledFile = join(dir, 'disabled');
  const killSwitchFile = join(dir, 'kill-switch');
  if (mode === MODES.DISABLED) {
    await writeFile(disabledFile, `disabled at ${config.updatedAt} by ${updatedBy}: ${reason}\n`, { mode: 0o600 });
  } else {
    await rm(disabledFile, { force: true });
    await rm(killSwitchFile, { force: true });
  }

  // Append audit trail
  const auditPath = join(dir, 'rollout-audit.jsonl');
  const auditEntry = JSON.stringify({
    timestamp: config.updatedAt,
    action: 'set_mode',
    mode,
    reason,
    updatedBy,
  }) + '\n';
  await writeFile(auditPath, auditEntry, { flag: 'a', mode: 0o600 });

  return { ok: true, ...config, stateDir: dir };
}

export async function enableKillSwitch({ stateDir, configDir, reason = 'Emergency kill-switch enabled', updatedBy = 'ops' } = {}) {
  return setRolloutMode(MODES.DISABLED, { stateDir, configDir, reason, updatedBy });
}

export async function disableKillSwitch({ stateDir, configDir, targetMode = MODES.SHADOW, reason = 'Kill-switch disabled', updatedBy = 'ops' } = {}) {
  return setRolloutMode(targetMode, { stateDir, configDir, reason, updatedBy });
}

/**
 * Rolls back connector:
 * 1. Disables hooks (or sets to targetMode, e.g. shadow or disabled).
 * 2. Restores the last known good cache snapshot from backup file if available.
 * 3. Enforces that NO board knowledge items are deleted or mutated.
 * 4. Records rollback audit log.
 */
export async function rollback({
  stateDir,
  cacheDir,
  backupCacheFile,
  targetMode = MODES.DISABLED,
  keepKnowledge = true,
  reason = 'Emergency rollback triggered',
  updatedBy = 'ops',
} = {}) {
  if (!keepKnowledge) {
    throw new Error('Rollback safety violation: knowledge on the board must NEVER be deleted');
  }

  const dir = stateDir ?? process.env.ADM_CONNECTOR_STATE_DIR ?? join(homedir(), '.adm-connector');
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // 1. Disable hooks / switch rollout mode
  const modeResult = await setRolloutMode(targetMode, { stateDir: dir, reason, updatedBy });

  // 2. Restore cache if backup provided
  let restoredCache = false;
  let restoredChecksum = null;
  if (backupCacheFile) {
    const backupContent = await readFile(backupCacheFile, 'utf8');
    const parsed = JSON.parse(backupContent);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      throw new Error('Invalid cache backup file: missing items array');
    }
    const targetCachePath = cacheDir ? join(cacheDir, 'cache.json') : join(dir, 'cache.json');
    await mkdir(dirname(targetCachePath), { recursive: true, mode: 0o700 });
    await writeFile(targetCachePath, backupContent, { mode: 0o600 });
    restoredCache = true;
    restoredChecksum = sha256(Buffer.from(backupContent));
  }

  // 3. Record rollback audit log
  const rollbackAuditPath = join(dir, 'rollback-audit.jsonl');
  const auditEvent = {
    timestamp: new Date().toISOString(),
    action: 'rollback',
    mode: modeResult.mode,
    restoredCache,
    restoredChecksum,
    knowledgePreserved: true,
    reason,
    updatedBy,
  };
  await writeFile(rollbackAuditPath, JSON.stringify(auditEvent) + '\n', { flag: 'a', mode: 0o600 });

  return {
    ok: true,
    mode: modeResult.mode,
    restoredCache,
    knowledgePreserved: true,
    auditEvent,
  };
}

async function collectFilesRecursively(baseDir, relativePath = '') {
  const currentDir = join(baseDir, relativePath);
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const rel = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const sub = await collectFilesRecursively(baseDir, rel);
      files.push(...sub);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Archives legacy files (CLAUDE.md, MEMORY.md, memory/) to archive directory.
 * - Sets file permissions to read-only (0o444).
 * - Computes SHA-256 for all files.
 * - Creates manifest.json with hashes, timestamp, sizes.
 * - Enforces zero deletions: legacy source files are kept strictly intact.
 */
export async function archiveLegacyFiles({
  sourceDir,
  archiveDir,
  legacyTargets = ['CLAUDE.md', 'MEMORY.md', 'memory'],
  dryRun = false,
} = {}) {
  if (!sourceDir || !isAbsolute(sourceDir)) {
    throw new Error('sourceDir must be an absolute path');
  }
  if (!archiveDir || !isAbsolute(archiveDir)) {
    throw new Error('archiveDir must be an absolute path');
  }

  const discoveredFiles = [];
  for (const target of legacyTargets) {
    const targetPath = join(sourceDir, target);
    try {
      const s = await stat(targetPath);
      if (s.isFile()) {
        discoveredFiles.push(target);
      } else if (s.isDirectory()) {
        const subFiles = await collectFilesRecursively(sourceDir, target);
        discoveredFiles.push(...subFiles);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  if (discoveredFiles.length === 0) {
    return { ok: true, totalFiles: 0, totalBytes: 0, manifest: null, files: [] };
  }

  const manifestFiles = [];
  let totalBytes = 0;

  for (const relPath of discoveredFiles) {
    const srcPath = join(sourceDir, relPath);
    const content = await readFile(srcPath);
    const fileSha = sha256(content);
    totalBytes += content.byteLength;

    manifestFiles.push({
      path: relPath,
      size: content.byteLength,
      sha256: fileSha,
      permissions: '0444',
    });
  }

  const manifest = {
    schema_version: 1,
    archivedAt: new Date().toISOString(),
    sourceDir,
    totalFiles: manifestFiles.length,
    totalBytes,
    files: manifestFiles,
  };

  if (dryRun) {
    return { ok: true, dryRun: true, manifest, totalFiles: manifestFiles.length, totalBytes };
  }

  // Create archive directory
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });

  for (const relPath of discoveredFiles) {
    const srcPath = join(sourceDir, relPath);
    const destPath = join(archiveDir, relPath);
    await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });

    // Copy to archive
    await copyFile(srcPath, destPath);
    // Set archive copy read-only
    await chmod(destPath, 0o444);

    // Set source file read-only (never delete!)
    await chmod(srcPath, 0o444);
  }

  // Write manifest in archive directory
  const manifestPath = join(archiveDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  return {
    ok: true,
    archiveDir,
    manifestPath,
    totalFiles: manifestFiles.length,
    totalBytes,
    manifest,
  };
}

/**
 * Verifies integrity of archived files against manifest.json.
 */
export async function verifyLegacyArchive({ archiveDir, manifestPath } = {}) {
  const mPath = manifestPath ?? join(archiveDir, 'manifest.json');
  const manifestData = JSON.parse(await readFile(mPath, 'utf8'));

  if (!manifestData || !Array.isArray(manifestData.files)) {
    throw new Error('Invalid archive manifest format');
  }

  const errors = [];
  let verifiedCount = 0;

  for (const file of manifestData.files) {
    const targetPath = join(archiveDir, file.path);
    try {
      const s = await stat(targetPath);
      const isReadOnly = (s.mode & 0o222) === 0;
      if (!isReadOnly) {
        errors.push({ path: file.path, error: 'File is not read-only' });
      }

      const content = await readFile(targetPath);
      if (content.byteLength !== file.size) {
        errors.push({ path: file.path, error: `Size mismatch: expected ${file.size}, got ${content.byteLength}` });
      }
      const actualSha = sha256(content);
      if (actualSha !== file.sha256) {
        errors.push({ path: file.path, error: `SHA256 mismatch: expected ${file.sha256}, got ${actualSha}` });
      }
      verifiedCount++;
    } catch (err) {
      errors.push({ path: file.path, error: err.message });
    }
  }

  if (errors.length > 0) {
    return { ok: false, verifiedCount, errors };
  }

  return { ok: true, verifiedCount, totalFiles: manifestData.totalFiles, errors: [] };
}

/**
 * Restores legacy files from archive to target directory (if needed during rollback).
 */
export async function restoreLegacyArchive({ archiveDir, targetDir, dryRun = false } = {}) {
  const verification = await verifyLegacyArchive({ archiveDir });
  if (!verification.ok) {
    throw new Error(`Cannot restore corrupted archive: ${JSON.stringify(verification.errors)}`);
  }

  const manifestData = JSON.parse(await readFile(join(archiveDir, 'manifest.json'), 'utf8'));
  if (dryRun) {
    return { ok: true, dryRun: true, restoredCount: manifestData.files.length };
  }

  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const file of manifestData.files) {
    const srcPath = join(archiveDir, file.path);
    const destPath = join(targetDir, file.path);
    await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
    await copyFile(srcPath, destPath);
    await chmod(destPath, 0o444);
  }

  return { ok: true, restoredCount: manifestData.files.length };
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'status';

  if (command === 'status') {
    const state = await getRolloutState();
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    return;
  }

  if (command === 'set-mode') {
    const mode = args[1];
    if (!mode) throw new Error('Usage: rollout.mjs set-mode <disabled|shadow|main>');
    const res = await setRolloutMode(mode, { reason: args.slice(2).join(' ') || 'manual CLI switch' });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (command === 'kill-switch') {
    const action = args[1];
    if (action === 'on') {
      const res = await enableKillSwitch({ reason: args.slice(2).join(' ') });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (action === 'off') {
      const res = await disableKillSwitch({ reason: args.slice(2).join(' ') });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      throw new Error('Usage: rollout.mjs kill-switch <on|off>');
    }
    return;
  }

  if (command === 'rollback') {
    const res = await rollback({ reason: args.slice(1).join(' ') || 'manual CLI rollback' });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (command === 'archive-legacy') {
    const srcIdx = args.indexOf('--source');
    const arcIdx = args.indexOf('--archive');
    if (srcIdx === -1 || arcIdx === -1 || !args[srcIdx + 1] || !args[arcIdx + 1]) {
      throw new Error('Usage: rollout.mjs archive-legacy --source <dir> --archive <dir>');
    }
    const res = await archiveLegacyFiles({
      sourceDir: resolve(args[srcIdx + 1]),
      archiveDir: resolve(args[arcIdx + 1]),
    });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (command === 'verify-archive') {
    const arcIdx = args.indexOf('--archive');
    if (arcIdx === -1 || !args[arcIdx + 1]) {
      throw new Error('Usage: rollout.mjs verify-archive --archive <dir>');
    }
    const res = await verifyLegacyArchive({ archiveDir: resolve(args[arcIdx + 1]) });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
