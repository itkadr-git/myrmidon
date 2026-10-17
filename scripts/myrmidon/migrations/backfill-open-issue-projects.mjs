#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const OPEN = new Set(['todo', 'in_progress', 'in_review', 'blocked', 'backlog']);
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath) {
  console.error('Usage: node scripts/myrmidon/migrations/backfill-open-issue-projects.mjs <snapshot.json> [report.json]');
  process.exit(2);
}

const input = JSON.parse(await readFile(inputPath, 'utf8'));
const { issues, memberships = [], projects = [] } = input;
if (!Array.isArray(issues) || !Array.isArray(memberships) || !Array.isArray(projects)) {
  throw new Error('Input must contain issues, memberships, and projects arrays');
}
const projectIds = new Set(projects.map(({ id }) => id));
const projectById = new Map(projects.map(({ id, name }) => [id, name]));
const memberProjects = new Map();
for (const { agentId, projectId, confirmed } of memberships) {
  if (!agentId || !projectIds.has(projectId)) throw new Error('Membership references an unknown agent or project');
  if (confirmed !== true) continue;
  const ids = memberProjects.get(agentId) ?? new Set();
  ids.add(projectId);
  memberProjects.set(agentId, ids);
}
const issueById = new Map(issues.map((issue) => [issue.id, issue]));
const counts = { assignee: 0, parent: 0, creatorDefault: 0, excluded: 0 };
const plan = [];

function resolve(ids, rule) {
  if (ids.size === 1) return { projectId: [...ids][0], rule };
  if (ids.size > 1) return { excluded: `ambiguous_${rule}` };
  return null;
}

for (const issue of issues) {
  if (!OPEN.has(issue.status) || issue.projectId) continue;
  let result = null;
  if (issue.assigneeAgentId) {
    result = resolve(memberProjects.get(issue.assigneeAgentId) ?? new Set(), 'assignee');
  }
  if (!result && issue.parentId) {
    const parent = issueById.get(issue.parentId);
    if (parent?.projectId && projectIds.has(parent.projectId)) result = { projectId: parent.projectId, rule: 'parent' };
  }
  if (!result) {
    const creatorId = issue.createdByAgentId;
    const defaults = creatorId ? (input.creatorDefaultProjects?.[creatorId] ?? []) : [];
    result = resolve(new Set(defaults), 'creatorDefault');
  }
  if (result?.projectId) {
    counts[result.rule]++;
    plan.push({ issueId: issue.id, projectId: result.projectId, projectName: projectById.get(result.projectId), rule: result.rule });
  } else {
    counts.excluded++;
    plan.push({ issueId: issue.id, excluded: result?.excluded ?? 'no_confirmed_mapping' });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  inputIssueCount: issues.length,
  openWithoutProject: plan.length,
  plannedChanges: plan.filter((row) => row.projectId).length,
  counts,
  finalOpenWithoutProject: counts.excluded,
  plan,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, text);
else process.stdout.write(text);
