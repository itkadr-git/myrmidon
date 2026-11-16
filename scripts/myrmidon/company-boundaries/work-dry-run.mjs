import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const rollback = Object.freeze([
  'stop-writes', 'revoke-capabilities', 'preserve-audit-and-checkpoints',
  'restore-routing-and-memberships-from-snapshot', 'remove-provenance-rows-only', 'reconcile',
]);

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function list(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

// This is a provisional fixture schema, not the migration service contract.
export function planWork(input) {
  if (!input || input.fixture !== 'work-offline/v1') throw new TypeError('Expected work-offline/v1 fixture');
  const source = required(input.source, 'source');
  const target = required(input.target, 'target');
  if (source === target) throw new TypeError('source and target must be different');
  const sources = new Set();
  const targets = new Map();
  const mappings = list(input.entities, 'entities').map((entity) => {
    const kind = required(entity?.kind, 'kind');
    const id = required(entity?.id, 'id');
    const targetId = required(entity?.targetId, 'targetId');
    const key = `${kind}:${id}`;
    if (sources.has(key)) throw new TypeError(`duplicate source ${key}`);
    sources.add(key);
    const targetKey = JSON.stringify([kind, targetId]);
    const group = targets.get(targetKey) ?? { kind, targetId, sources: [] };
    group.sources.push(id);
    targets.set(targetKey, group);
    return { kind, sourceId: id, targetId };
  });
  const unknown = new Set();
  const relations = list(input.relations, 'relations').map((relation) => {
    const from = required(relation?.from, 'relation.from');
    const to = required(relation?.to, 'relation.to');
    for (const ref of [from, to]) if (!sources.has(ref)) unknown.add(ref);
    return { from, to };
  });
  const missingBindings = [];
  for (const binding of list(input.bindings, 'bindings')) {
    const entity = required(binding?.entity, 'binding.entity');
    const name = required(binding?.name, 'binding.name');
    if (!sources.has(entity)) unknown.add(entity);
    if (typeof binding.target !== 'string' || !binding.target.trim()) missingBindings.push({ entity, name });
  }
  const collisions = [...targets.values()].filter((group) => group.sources.length > 1);
  const unknownSources = [...unknown];
  return { mode: 'offline-fixture-only', source, target, mappings, relations, collisions, unknownSources, missingBindings,
    rollback: [...rollback], ready: collisions.length === 0 && unknownSources.length === 0 && missingBindings.length === 0 };
}

// No adapter to a real migrator exists yet; the transport is deliberately unused.
export async function dryRunWork(input, _transport) {
  return planWork(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node work-dry-run.mjs <offline-fixture.json>');
    const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
    console.log(JSON.stringify(await dryRunWork(fixture), null, 2));
  } catch (error) {
    console.error(`Offline fixture error: ${error.message}`);
    process.exitCode = 1;
  }
}
