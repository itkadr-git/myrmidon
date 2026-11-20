#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const list = (v) => Array.isArray(v) && v.every(text);

export function audit(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.issues)) throw new Error('Snapshot must contain an issues array');
  const release = snapshot.release ?? {};
  const issues = snapshot.issues.map((issue) => {
    if (!issue || typeof issue !== 'object') return { id: null, codeInRelease: 'unknown', verified: 'unknown', outcome: 'UNKNOWN', reasons: ['invalid issue'] };
    const reasons = [];
    let codeInRelease = 'unknown';
    let verified = 'unknown';
    if (issue.kind === 'non-code') {
      return { id: issue.id ?? null, codeInRelease: 'not-applicable', verified: 'not-applicable', outcome: text(issue.skipReason) ? 'SKIPPED' : 'UNKNOWN', reasons: text(issue.skipReason) ? [issue.skipReason] : ['non-code skip requires a reason'] };
    }
    if (issue.kind !== 'code') reasons.push('issue kind is missing or invalid');
    if (issue.kind === 'code' && text(release.version) && list(release.commits) && list(issue.mergedCommits) && issue.mergedCommits.length > 0) {
      codeInRelease = issue.mergedCommits.every((commit) => release.commits.includes(commit)) ? 'yes' : 'no';
      if (codeInRelease === 'no') reasons.push('merged commit absent from release');
    } else reasons.push('release or merged commit membership is incomplete');
    const v = issue.verification;
    if (v && text(release.version) && text(v.version) && text(v.method) && text(v.result) && text(v.verifier) && text(issue.author)) {
      verified = v.version === release.version && v.result === 'pass' && v.verifier !== issue.author ? 'yes' : 'no';
      if (verified === 'no') reasons.push('verification is stale, failed, or self-verified');
    } else reasons.push('verification or author identity is incomplete');
    const outcome = codeInRelease === 'no' || verified === 'no' ? 'FAIL' : codeInRelease === 'yes' && verified === 'yes' && text(issue.id) ? 'PASS' : 'UNKNOWN';
    return { id: issue.id ?? null, codeInRelease, verified, outcome, reasons };
  });
  return { releaseVersion: release.version ?? null, issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node audit.mjs snapshot.json');
    const snapshot = JSON.parse(await readFile(process.argv[2], 'utf8'));
    console.log(JSON.stringify(audit(snapshot), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
