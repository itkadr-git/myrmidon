import { open, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));

/**
 * Snapshots numbered below this one predate the check: several of them point at
 * a snapshot that was never committed (0027, 0039, 0077, 0091, 0292, 0295). For
 * those only uniqueness, self-reference and cycles are enforced. From this
 * number on every snapshot must name the preceding snapshot as its parent,
 * because that is the chain `drizzle-kit generate` walks.
 */
export const STRICT_CHAIN_FROM = 296;

export type SnapshotLink = {
  readonly file: string;
  readonly id: string;
  readonly prevId: string;
};

export function snapshotNumber(file: string): number {
  const match = file.match(/^(\d{4})_snapshot\.json$/);
  return match ? Number(match[1]) : Number.NaN;
}

/** Returns human-readable problems; an empty list means the chain is sound. */
export function analyzeSnapshotChain(
  links: readonly SnapshotLink[],
  strictFrom: number = STRICT_CHAIN_FROM,
): string[] {
  const problems: string[] = [];
  const sorted = [...links].sort((a, b) => a.file.localeCompare(b.file));

  const byId = new Map<string, SnapshotLink>();
  for (const link of sorted) {
    const existing = byId.get(link.id);
    if (existing) {
      problems.push(`duplicate snapshot id ${link.id}: ${existing.file}, ${link.file}`);
    } else {
      byId.set(link.id, link);
    }
    if (link.prevId === link.id) {
      problems.push(`${link.file}: prevId points at the snapshot itself (${link.id})`);
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const link = sorted[index]!;
    const previous = sorted[index - 1]!;
    if (snapshotNumber(link.file) >= strictFrom && link.prevId !== previous.id) {
      problems.push(
        `${link.file}: prevId ${link.prevId} is not the id of the preceding snapshot ${previous.file} (${previous.id})`,
      );
    }
  }

  // A chain must not loop back on itself, wherever the parents point.
  for (const start of sorted) {
    const seen = new Set<string>([start.id]);
    let cursor = byId.get(start.prevId);
    while (cursor) {
      if (seen.has(cursor.id)) {
        problems.push(`${start.file}: prevId chain loops back through ${cursor.file}`);
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.prevId);
    }
  }

  return problems;
}

/** `id` and `prevId` sit in the first lines of a snapshot; avoid parsing 1.4 MB files. */
async function readLink(file: string): Promise<SnapshotLink> {
  const handle = await open(`${metaDir}/${file}`, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.toString("utf8", 0, bytesRead);
    const id = head.match(/^\s{2}"id":\s*"([^"]+)"/m)?.[1];
    const prevId = head.match(/^\s{2}"prevId":\s*"([^"]+)"/m)?.[1];
    if (!id || !prevId) {
      throw new Error(`${file}: cannot find top-level "id"/"prevId" in the first 8 KiB`);
    }
    return { file, id, prevId };
  } finally {
    await handle.close();
  }
}

async function main() {
  const files = (await readdir(metaDir)).filter((entry) => /^\d{4}_snapshot\.json$/.test(entry)).sort();
  const links = await Promise.all(files.map(readLink));
  const problems = analyzeSnapshotChain(links);
  if (problems.length > 0) {
    throw new Error(`Migration snapshot chain is broken:\n- ${problems.join("\n- ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
