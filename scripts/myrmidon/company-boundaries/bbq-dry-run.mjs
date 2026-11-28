import { pathToFileURL } from 'node:url';

// Synthetic planning input, not an export or the unfinished migration contract.
export const fixture = {
  label: 'synthetic',
  entities: [
    { kind: 'agent', id: 'bbq', owner: 'bbq' },
    { kind: 'project', id: 'shop', owner: 'bbq' },
    { kind: 'issue', id: 'task', owner: 'bbq', project: 'shop' },
  ],
  target: [{ kind: 'agent', id: 'bbq' }],
};

export function dryRun(input) {
  if (input?.label !== 'synthetic' || !Array.isArray(input.entities) || !Array.isArray(input.target)) {
    throw new Error('Only explicitly synthetic fixtures with entities and target arrays are accepted');
  }
  const keys = new Set(input.entities.map((entity) => `${entity.kind}:${entity.id}`));
  const target = new Set(input.target.map((entity) => `${entity.kind}:${entity.id}`));
  const relations = [];
  const unknown = [];
  const collisions = [];
  for (const entity of input.entities) {
    const source = `${entity.kind}:${entity.id}`;
    if (target.has(source)) collisions.push({ kind: entity.kind, key: entity.id });
    if (!entity.owner || !keys.has(`agent:${entity.owner}`)) {
      unknown.push({ entity: source, reason: 'missing owner' });
    } else if (entity.kind !== 'agent') {
      relations.push({ from: source, to: `agent:${entity.owner}`, kind: 'owner', status: 'resolved' });
    }
    if (entity.kind === 'issue') {
      if (!entity.project || !keys.has(`project:${entity.project}`)) {
        unknown.push({ entity: source, reason: 'missing project' });
      } else {
        relations.push({ from: source, to: `project:${entity.project}`, kind: 'project', status: 'resolved' });
      }
    }
  }
  return {
    fixture: 'synthetic',
    contract: 'placeholder-not-ope-12765',
    ready: false,
    relations,
    collisions,
    unknown,
    uncovered: ['memory', 'corpus', 'secret bindings', 'budgets', 'ACL', 'external integrations'].map((kind) => ({ kind, status: 'unknown' })),
    rollback: { available: false, reason: 'No migration, snapshot or provenance exists in this fixture.' },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This offline prototype accepts no arguments or real data');
  process.stdout.write(`${JSON.stringify(dryRun(fixture), null, 2)}\n`);
}
