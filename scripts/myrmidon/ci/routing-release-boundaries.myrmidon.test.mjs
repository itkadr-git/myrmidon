import test from 'node:test';
import assert from 'node:assert/strict';
import { isReleasePR, getExecutionPriority, getRunnerPool } from './ci-routing.mjs';

const cases = [
  { name: 'release is a separate word', title: 'prepare release notes', expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'prerelease is not a separate word', title: 'prepare prerelease notes', expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'unreleased is not a separate word', title: 'document unreleased work', expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'numeric RC title', title: 'candidate RC.7', expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'nonnumeric rc title', title: 'candidate rc.x', expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'exact string release label', labels: ['release'], expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'exact object release label', labels: [{ name: 'release' }], expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'uppercase string label does not match', labels: ['RELEASE'], expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'uppercase object label does not match', labels: [{ name: 'RELEASE' }], expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'empty labels do not match', labels: [], expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'non-array labels do not match', labels: 'release', expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'release head branch', headRef: 'rel/1.7', expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'release base branch', baseRef: 'rel/1.7', expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'nested head is not a release branch', headRef: 'feature/rel/x', expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'nested base is not a release branch', baseRef: 'feature/rel/x', expected: [false, 'P2_NORMAL', 'ubuntu-latest'] },
  { name: 'main overrides release title', title: 'release 1.7', ref: 'refs/heads/main', expected: [true, 'P0_CRITICAL', 'vps-ci'] },
  { name: 'tag overrides release label', labels: ['release'], ref: 'refs/tags/v1.7', expected: [true, 'P0_CRITICAL', 'vps-ci'] },
  { name: 'main uses configured priority runner', ref: 'refs/heads/main', runners: { priorityRunner: 'fast', defaultRunner: 'standard' }, expected: [false, 'P0_CRITICAL', 'fast'] },
  { name: 'main falls back from empty priority runner', ref: 'refs/heads/main', runners: { priorityRunner: '' }, expected: [false, 'P0_CRITICAL', 'vps-ci'] },
  { name: 'release uses configured priority runner', title: 'release', runners: { priorityRunner: 'fast', defaultRunner: 'standard' }, expected: [true, 'P1_HIGH', 'fast'] },
  { name: 'release falls back from empty priority runner', title: 'release', runners: { priorityRunner: '' }, expected: [true, 'P1_HIGH', 'vps-ci'] },
  { name: 'ordinary PR uses configured default runner', title: 'fix button', runners: { priorityRunner: 'fast', defaultRunner: 'standard' }, expected: [false, 'P2_NORMAL', 'standard'] },
];

for (const { name, title = '', labels = [], headRef = '', baseRef = '', ref = '', runners = {}, expected } of cases) {
  test(name, () => {
    const release = isReleasePR({ title, labels, headRef, baseRef });
    const priority = getExecutionPriority({ eventName: 'pull_request', ref, prTitle: title, prLabels: labels, headRef, baseRef });
    const runner = getRunnerPool({ priority, ...runners });
    assert.deepEqual([release, priority, runner], expected);
  });
}
