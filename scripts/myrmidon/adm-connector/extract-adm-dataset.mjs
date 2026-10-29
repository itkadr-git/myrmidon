#!/usr/bin/env node
/**
 * Offline dataset extractor & sanitizer for ADM session prompts (OPE-9777 / OPE-9264).
 * Scans ADM session transcripts, filters user messages within the specified UTC window,
 * scrubs secrets (gitleaks / regex redaction) per policy OPE-1524, and deterministically
 * selects exactly targetCount (50) messages using uniform stride.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_START_UTC = '2026-10-20T00:00:00Z';
export const DEFAULT_END_UTC = '2026-10-27T00:00:00Z';
export const DEFAULT_TARGET_COUNT = 50;

/**
 * Redacts secret patterns per policy OPE-1524:
 * Paperclip tokens (pcp_...), GitHub tokens (ghp_...), Bearer headers,
 * private keys, API keys, and sensitive environment variables.
 */
export function scrubSecrets(text) {
  if (typeof text !== 'string') return '';

  let scrubbed = text;

  // Private key blocks
  scrubbed = scrubbed.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');

  // Paperclip tokens (pcp_...)
  scrubbed = scrubbed.replace(/pcp_[A-Za-z0-9_-]{8,}/g, '[REDACTED_PCP_TOKEN]');

  // GitHub tokens (ghp_, gho_, ghu_, ghb_, etc.)
  scrubbed = scrubbed.replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, '[REDACTED_GH_TOKEN]');

  // Bearer authentication headers
  scrubbed = scrubbed.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED_BEARER]');

  // Generic API keys or passwords in key=val or key: val (avoiding re-redacting [REDACTED_...])
  scrubbed = scrubbed.replace(/(api[_-]?key|token|secret|password|passwd)([\s:=]+)(['"]?)(?!\[REDACTED)[^\s'"&;,]{8,}\3/gi, '$1$2$3[REDACTED_SECRET]$3');

  return scrubbed;
}

/**
 * Required gitleaks stdin scan; refuse export if the scanner is unavailable or fails
 */
export function gitleaksScrub(text, bin = process.env.ADM_GITLEAKS_BIN || 'gitleaks') {
  try {
    const run = spawnSync(bin, ['stdin', '--no-banner', '--redact=100'], {
      input: text,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (run.error || run.status !== 0 || !run.stdout) {
      throw new Error('gitleaks scan failed; refusing to export data');
    }
    return run.stdout;
  } catch {
    throw new Error('gitleaks scan failed; refusing to export data');
  }
}

/**
 * Parses messages from a session file (JSON or JSONL)
 */
export function parseSessionMessages(content) {
  const messages = [];

  // Try JSON parse first
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const item of data) {
        messages.push(...extractFromItem(item));
      }
      return messages;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.messages)) {
        for (const item of data.messages) {
          messages.push(...extractFromItem(item));
        }
        return messages;
      }
      messages.push(...extractFromItem(data));
      return messages;
    }
  } catch {
    // Try line-delimited JSON
  }

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      messages.push(...extractFromItem(item));
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

function extractFromItem(item) {
  const result = [];
  if (!item || typeof item !== 'object') return result;

  // Claude Code transcript format: { type: "user" | "human", message: { text: "..." }, timestamp: "..." }
  // or { role: "user", content: "..." }
  const role = item.role || item.type || (item.message && item.message.role) || (item.message && item.message.type);
  if (role !== 'user' && role !== 'human') {
    return result;
  }

  let text = '';
  if (typeof item.content === 'string') {
    text = item.content;
  } else if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        text += (text ? '\n' : '') + part.text;
      } else if (typeof part === 'string') {
        text += (text ? '\n' : '') + part;
      }
    }
  } else if (item.message && typeof item.message.content === 'string') {
    text = item.message.content;
  } else if (item.message && typeof item.message.text === 'string') {
    text = item.message.text;
  } else if (typeof item.text === 'string') {
    text = item.text;
  }

  const timestamp = item.timestamp || item.created_at || item.createdAt || (item.message && (item.message.timestamp || item.message.createdAt)) || null;

  if (text.trim()) {
    result.push({ text: text.trim(), timestamp });
  }

  return result;
}

/**
 * Filters and samples exactly targetCount messages using uniform stride.
 */
export function sampleDataset(rawCandidates, {
  startUtc = DEFAULT_START_UTC,
  endUtc = DEFAULT_END_UTC,
  targetCount = DEFAULT_TARGET_COUNT,
  scan = gitleaksScrub
} = {}) {
  const startTime = Date.parse(startUtc);
  const endTime = Date.parse(endUtc);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime || !Number.isSafeInteger(targetCount) || targetCount < 1) {
    throw new Error('Invalid UTC window or target count');
  }

  // An unknown or invalid timestamp cannot establish provenance inside the window.
  const inWindow = [];
  for (const c of rawCandidates) {
    if (typeof c.text !== 'string' || !c.text.trim()) continue;
    if (typeof c.timestamp !== 'string') continue;
    const t = Date.parse(c.timestamp);
    if (!Number.isFinite(t) || t < startTime || t >= endTime) continue;
    inWindow.push({ ...c, timestamp: new Date(t).toISOString() });
  }

  // Deduplicate and scrub
  const seenTexts = new Set();
  const sanitized = [];

  for (const item of inWindow) {
    const clean = scan(scrubSecrets(item.text));
    const norm = clean.trim();
    if (norm.length < 5) continue; // Skip single punctuation / trivial noise
    if (seenTexts.has(norm)) continue;
    seenTexts.add(norm);

    sanitized.push({
      text: norm,
      timestamp: item.timestamp
    });
  }

  // Sort chronologically
  sanitized.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb;
    return a.text.localeCompare(b.text);
  });

  const N = sanitized.length;
  if (N < targetCount) {
    throw new Error(`Only ${N} eligible messages; ${targetCount} required`);
  }

  if (N === targetCount) {
    return sanitized.map((item, idx) => ({
      id: idx + 1,
      timestamp_utc: item.timestamp,
      text: item.text,
      scrubbed: true
    }));
  }

  // Deterministic uniform stride: index = floor(i * N / targetCount)
  const sampled = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.floor((i * N) / targetCount);
    const item = sanitized[idx];
    sampled.push({
      id: i + 1,
      timestamp_utc: item.timestamp,
      text: item.text,
      scrubbed: true
    });
  }

  return sampled;
}

/**
 * Scans directories recursively for session logs
 */
export function scanDirectory(dir) {
  const files = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory()) {
          files.push(...scanDirectory(fullPath));
        } else if (s.isFile() && (entry.endsWith('.json') || entry.endsWith('.jsonl') || entry.endsWith('.log'))) {
          files.push(fullPath);
        }
      } catch {
        // Skip unreadable
      }
    }
  } catch {
    // Skip unreadable directory
  }
  return files;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('extract-adm-dataset.mjs')) {
  const args = process.argv.slice(2);
  let inputDir = '';
  let outputFile = '';
  let startUtc = DEFAULT_START_UTC;
  let endUtc = DEFAULT_END_UTC;
  let targetCount = DEFAULT_TARGET_COUNT;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input-dir' && args[i + 1]) {
      inputDir = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputFile = args[++i];
    } else if (args[i] === '--start' && args[i + 1]) {
      startUtc = args[++i];
    } else if (args[i] === '--end' && args[i + 1]) {
      endUtc = args[++i];
    } else if (args[i] === '--target-count' && args[i + 1]) {
      targetCount = parseInt(args[++i], 10);
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (!inputDir) {
    console.error('Usage: node extract-adm-dataset.mjs --input-dir <path> [--output <path>] [--start <UTC>] [--end <UTC>] [--target-count <N>] [--dry-run]');
    process.exit(1);
  }

  const sessionFiles = scanDirectory(resolve(inputDir));
  console.log(`Found ${sessionFiles.length} candidate session files in ${inputDir}`);

  const rawCandidates = [];
  for (const f of sessionFiles) {
    try {
      const content = readFileSync(f, 'utf8');
      rawCandidates.push(...parseSessionMessages(content));
    } catch (e) {
      console.warn(`Could not read ${f}: ${e.message}`);
    }
  }

  console.log(`Extracted ${rawCandidates.length} raw user messages.`);
  const dataset = sampleDataset(rawCandidates, { startUtc, endUtc, targetCount });
  console.log(`Produced sanitized dataset with ${dataset.length} items (target: ${targetCount}).`);

  if (dryRun) {
    console.log(`Sanitized dataset has ${dataset.length} items; no messages printed.`);
  } else if (outputFile) {
    writeFileSync(resolve(outputFile), JSON.stringify(dataset, null, 2), 'utf8');
    console.log(`Saved dataset to ${outputFile}`);
  } else {
    console.log(JSON.stringify(dataset, null, 2));
  }
}
