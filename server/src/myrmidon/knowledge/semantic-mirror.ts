import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { knowledgeItems, knowledgeRevisions } from "@myrmidon/db";

export type MirrorPage = {
  itemId: string;
  slug: string;
  title: string;
  revision: number;
  lang: string;
  space: string;
  content: string;
};

type Fetch = typeof fetch;

export function splitSections(content: string): string[] {
  const sections = content.split(/(?=^#{1,6}\s+\S)/m).map((part) => part.trim()).filter(Boolean);
  return sections.length ? sections : (content.trim() ? [content.trim()] : []);
}

export function createSemanticMirror(url: string, token: string, request: Fetch = fetch) {
  const base = url.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await request(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`RAGFlow ${method} ${path}: HTTP ${response.status}`);
    const result = await response.json() as { code: number; message?: string; data: T };
    if (result.code !== 0) throw new Error(`RAGFlow ${method} ${path}: ${result.message ?? result.code}`);
    return result.data;
  }

  async function dataset(nestId: string): Promise<string> {
    const name = `knowledge-mirror:${nestId}`;
    const existing = await call<{ id: string; name: string }[]>("GET", `/datasets?name=${encodeURIComponent(name)}`);
    const found = existing.find((entry) => entry.name === name);
    if (found) return found.id;
    const created = await call<{ id: string }>("POST", "/datasets", { name, parse_type: 1, parser_id: "general" });
    return created.id;
  }

  async function documents(datasetId: string, itemId: string) {
    const name = `${itemId}.txt`;
    const result = await call<{ docs: { id: string; name: string }[] }>("GET", `/datasets/${datasetId}/documents?name=${encodeURIComponent(name)}&page_size=100`);
    return result.docs.filter((doc) => doc.name === name);
  }

  async function remove(nestId: string, itemId: string) {
    const id = await dataset(nestId);
    const existing = await documents(id, itemId);
    if (existing.length) await call("DELETE", `/datasets/${id}/documents`, { ids: existing.map((doc) => doc.id) });
  }

  async function upsert(page: MirrorPage) {
    const id = await dataset(page.space);
    const existing = await documents(id, page.itemId);
    // Replace chunks under the existing document so retries cannot accumulate stale sections.
    const document = existing[0] ?? (await call<{ id: string }[]>("POST", `/datasets/${id}/documents?type=empty`, { name: `${page.itemId}.txt` }))[0];
    if (!document) throw new Error("RAGFlow did not create a mirror document");
    await call("PATCH", `/datasets/${id}/documents/${document.id}`, {
      meta_fields: { slug: page.slug, revision: page.revision, lang: page.lang, space: page.space },
    });
    if (existing.length) await call("DELETE", `/datasets/${id}/documents/${document.id}/chunks`, { delete_all: true });
    for (const section of splitSections(page.content)) {
      await call("POST", `/datasets/${id}/documents/${document.id}/chunks`, { content: `${page.title}\n${section}` });
    }
  }

  async function search(nestId: string, query: string, limit: number): Promise<string[]> {
    const id = await dataset(nestId);
    const result = await call<{ chunks: { document_id: string; document_metadata?: { slug?: string } }[] }>("POST", "/retrieval", {
      question: query, dataset_ids: [id], page_size: limit, reference_metadata: { include: true },
    });
    const slugs = new Set<string>();
    for (const chunk of result.chunks ?? []) {
      if (chunk.document_metadata?.slug) slugs.add(chunk.document_metadata.slug);
      else if (chunk.document_id) {
        const document = await call<{ meta_fields?: { slug?: string } }>("GET", `/datasets/${id}/documents/${chunk.document_id}`);
        if (document.meta_fields?.slug) slugs.add(document.meta_fields.slug);
      }
    }
    return [...slugs];
  }
  return { upsert, remove, search };
}

export async function rebuildSemanticMirror(db: Db, nestId: string, mirror: ReturnType<typeof createSemanticMirror>) {
  const items = await db.select().from(knowledgeItems).where(eq(knowledgeItems.nestId, nestId));
  let indexed = 0;
  for (const item of items) {
    if (!item.deliveredRevisionId || item.status === "archived" || item.status === "superseded") {
      await mirror.remove(nestId, item.id);
      continue;
    }
    const [revision] = await db.select().from(knowledgeRevisions).where(and(
      eq(knowledgeRevisions.itemId, item.id), eq(knowledgeRevisions.id, item.deliveredRevisionId),
    )).limit(1);
    if (!revision) continue;
    await mirror.upsert({ itemId: item.id, slug: item.slug, title: item.title, revision: revision.revisionNumber, lang: revision.lang, space: nestId, content: revision.content });
    indexed++;
  }
  return { indexed };
}
