// server/src/myrmidon/knowledge/migrate/migrate.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): unit tests for the plugin transfer tool.
// No database: `runImport` is driven through the structural `KnowledgeWriter`
// interface, which the K-1 service satisfies as-is.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MigrateInputError,
  classifyPath,
  parseFrontmatter,
  parseSlugMap,
  planMigration,
  rewriteLinks,
  runImport,
  seedSlugMap,
  serializeSlugMap,
  type CreateKnowledgeInput,
  type DraftKnowledgeInput,
  type KnowledgeActor,
  type KnowledgeWriter,
  type MigrateMap,
} from "./index.js";

const AGENT: KnowledgeActor = { actorType: "agent", actorId: "ef2496db-56cd-4700-be3e-194fcc6f2a6a", kind: null };

/** A page long enough not to be mistaken for a stub (>= 200 bytes). */
function long(text: string): string {
  return `${text}\n\n${"filler sentence about the knowledge base. ".repeat(8)}\n`;
}

const roots: string[] = [];

function makeExport(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-migrate-test-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function emptyMap(overrides: Partial<MigrateMap> = {}): MigrateMap {
  return { version: 1, expectedTotal: 6, pages: {}, checks: [], ...overrides };
}

interface WriterLog {
  create: Array<{ input: CreateKnowledgeInput; actor: KnowledgeActor }>;
  draft: Array<{ nestId: string; slug: string; input: DraftKnowledgeInput; actor: KnowledgeActor }>;
  supersede: Array<{ nestId: string; slug: string; bySlug: string }>;
  search: string[];
}

function stubWriter(log: WriterLog, options: { failOn?: string } = {}): KnowledgeWriter {
  return {
    async create(input, actor) {
      if (options.failOn === input.slug) {
        throw Object.assign(new Error("slug taken"), { code: "knowledge_slug_taken" });
      }
      log.create.push({ input, actor });
      return { id: `id-${input.slug}`, slug: input.slug };
    },
    async draft(nestId, slug, input, actor) {
      log.draft.push({ nestId, slug, input, actor });
      return { id: `id-${slug}`, slug };
    },
    async supersede(nestId, slug, _actor, input) {
      log.supersede.push({ nestId, slug, bySlug: input.bySlug });
      return {};
    },
    async searchNest(_nestId, query) {
      log.search.push(query);
      return [{ itemId: "id-product/roles-and-castes", slug: "product/roles-and-castes", title: "Roles and castes" }];
    },
  };
}

function emptyLog(): WriterLog {
  return { create: [], draft: [], supersede: [], search: [] };
}

describe("frontmatter", () => {
  it("parses the block, keeps lists and quotes, and strips it from the body", () => {
    const parsed = parseFrontmatter(
      ['---', 'title: "Hosts and roles"', "tags: [infra, hosts]", "sources:", "  - OPE-3933", "  - https://example.invalid/doc", "reviewed: 3", "draft: false", "---", "# Heading", "body text"].join("\n"),
    );
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data["title"]).toBe("Hosts and roles");
    expect(parsed.data["tags"]).toEqual(["infra", "hosts"]);
    expect(parsed.data["sources"]).toEqual(["OPE-3933", "https://example.invalid/doc"]);
    expect(parsed.data["reviewed"]).toBe(3);
    expect(parsed.data["draft"]).toBe(false);
    expect(parsed.keys).toEqual(["title", "tags", "sources", "reviewed", "draft"]);
    expect(parsed.body.startsWith("# Heading")).toBe(true);
    expect(parsed.body).not.toContain("title:");
  });

  it("treats a page without a block as body-only and counts malformed lines", () => {
    const bare = parseFrontmatter("# Just a page\n");
    expect(bare.hasFrontmatter).toBe(false);
    expect(bare.body).toBe("# Just a page\n");

    const broken = parseFrontmatter(["---", "title: ok", "this line is not a pair", "---", "body"].join("\n"));
    expect(broken.malformedLines).toBe(1);
    expect(broken.data["title"]).toBe("ok");
  });
});

describe("classify (§5.3)", () => {
  it("puts the root index in G and journals in F", () => {
    expect(classifyPath("index.md", 10)).toMatchObject({ class: "G", action: "replace_index" });
    expect(classifyPath("log.md", 10)).toMatchObject({ class: "F", action: "drop" });
    expect(classifyPath("myrmidon/log-2026.md", 9000)).toMatchObject({ class: "F", action: "drop" });
    expect(classifyPath("journal/log.md", 9000)).toMatchObject({ class: "F", action: "drop" });
  });

  it("drops template project pages but rescues the release and the 1.6 decision check", () => {
    expect(classifyPath("projects/alpha/index.md", 900)).toMatchObject({ class: "D", action: "drop" });
    expect(classifyPath("projects/alpha/history.md", 900)).toMatchObject({ class: "D", action: "drop" });
    expect(classifyPath("myrmidon/release-1.6.md", 900)).toMatchObject({ class: "D", action: "import", target: "releases/1.6.0", publish: true });
    expect(classifyPath("myrmidon/decisions-1.6.md", 900)).toMatchObject({ class: "D", action: "import", target: "decisions/1.6-release-registry" });
  });

  it("turns regulations into drafts of kind=rule with the §5.3 approver default", () => {
    expect(classifyPath("regulations/secrets.md", 900)).toMatchObject({ class: "B", action: "import", kind: "rule", target: "regulations/secrets", approverKind: "owner" });
    expect(classifyPath("regulations/acceptance.md", 900)).toMatchObject({ class: "B", approverKind: "adm" });
    expect(classifyPath("regulations/unheard-of.md", 900)).toMatchObject({ class: "B", approverKind: null });
  });

  it("drops stubs, rewrites the schema page, and keeps content waves regardless of size", () => {
    expect(classifyPath("meta/scratch-note.md", 40)).toMatchObject({ class: "E", action: "drop" });
    expect(classifyPath("meta/about-this-wiki.md", 40)).toMatchObject({ class: "E", action: "import", target: "meta/schema" });
    expect(classifyPath("glossary/term.md", 30)).toMatchObject({ class: "A", action: "import", target: "glossary/term" });
  });

  it("maps the content waves onto their target prefixes and everything else throws", () => {
    expect(classifyPath("myrmidon/company-bootstrap.md", 900)).toMatchObject({ class: "A", target: "architecture/company-bootstrap" });
    expect(classifyPath("bbq/entities.md", 900)).toMatchObject({ class: "A", target: "directions/entities" });
    expect(classifyPath("company/roles-adm.md", 900)).toMatchObject({ class: "A", target: "product/roles-and-castes" });
    expect(classifyPath("company/structure.md", 900)).toMatchObject({ class: "A", target: "product/company-structure" });
    expect(classifyPath("process/release.md", 900)).toMatchObject({ class: "A", target: "runbooks/release" });
    expect(classifyPath("infra/hosts.md", 900)).toMatchObject({ class: "A", target: "infra/hosts" });
    expect(classifyPath("arch/old-answer.md", 900)).toMatchObject({ class: "C", action: "merge", target: "arch/old-answer" });
    expect(() => classifyPath("nowhere/page.md", 900)).toThrow(/Unclassified source path/);
  });
});

describe("slug map", () => {
  it("round-trips a hand-edited map and validates it hard", () => {
    const map = parseSlugMap(
      JSON.stringify({
        version: 1,
        expectedTotal: 170,
        defaultSources: ["OPE-3933"],
        pages: { "myrmidon/foo.md": { class: "A", action: "import", target: "architecture/foo" } },
        checks: [{ query: "bootstrap", expect: "architecture/company-bootstrap" }],
      }),
    );
    expect(map.expectedTotal).toBe(170);
    expect(map.pages["myrmidon/foo.md"]?.target).toBe("architecture/foo");
    expect(map.checks?.[0]?.expect).toBe("architecture/company-bootstrap");
    expect(JSON.parse(serializeSlugMap(map))).toMatchObject({ version: 1, expectedTotal: 170 });

    expect(() => parseSlugMap(JSON.stringify({ version: 2, expectedTotal: 1, pages: {} }))).toThrow(MigrateInputError);
    expect(() => parseSlugMap(JSON.stringify({ version: 1, expectedTotal: 1, pages: { a: { class: "Z", action: "drop" } } }))).toThrow(/unknown class/);
    expect(() => parseSlugMap(JSON.stringify({ version: 1, expectedTotal: 1, pages: { a: { class: "A", action: "import" } } }))).toThrow(/needs a target/);
    expect(() => parseSlugMap("not json")).toThrow(/not valid JSON/);
  });
});

describe("links", () => {
  it("rewrites through the map, keeps alias and anchor, and leaves the unknown verbatim", () => {
    const result = rewriteLinks("see [[bar|Bars]], [[bar#top]] and [[ghost]]", (target) => (target === "bar" ? "architecture/bar" : null));
    expect(result.content).toBe("see [[architecture/bar|Bars]], [[architecture/bar#top]] and [[ghost]]");
    expect(result.total).toBe(3);
    expect(result.resolved).toBe(2);
    expect(result.unresolved).toEqual(["ghost"]);
  });
});

describe("classify run", () => {
  it("reports classes, their sum, the parsed frontmatter and the link rate", () => {
    const root = makeExport({
      "index.md": "# Index\n",
      "log.md": "- did a thing\n",
      "myrmidon/foo.md": `---\ntitle: Foo\ntags: [arch]\n---\n${long("Foo body")}\nsee [[bar]] and [[ghost]]\n`,
      "myrmidon/bar.md": long("Bar body"),
      "regulations/secrets.md": long("Secrets stay out of knowledge"),
      "arch/old-answer.md": long("An old answer page"),
    });
    const plan = planMigration({ root, map: emptyMap(), expectedTotal: 6 });

    expect(plan.report.source.pages).toBe(6);
    expect(plan.report.classes).toMatchObject({ A: 2, B: 1, C: 1, F: 1, G: 1 });
    expect(plan.report.classes["E"]).toBe(0);
    expect(plan.report.classSum).toMatchObject({ expected: 6, actual: 6, ok: true });
    expect(plan.report.actions).toMatchObject({ import: 3, merge: 1, drop: 1, replace_index: 1 });
    expect(plan.report.frontmatter.withBlock).toBe(1);
    expect(Object.keys(plan.report.frontmatter.keys).sort()).toEqual(["tags", "title"]);
    expect(plan.report.links).toMatchObject({ total: 2, resolved: 1, percent: 50, unresolvedTargets: ["ghost"] });
    expect(plan.report.seededFromRules).toHaveLength(6);
    expect(plan.report.mergeNeedsDecision).toEqual(["arch/old-answer.md"]);

    // A wrong expectation is a red control, not a silent pass.
    const mismatch = planMigration({ root, map: emptyMap(), expectedTotal: 170 });
    expect(mismatch.report.classSum).toMatchObject({ expected: 170, actual: 6, ok: false });
  });
});

describe("import run", () => {
  const files = {
    "myrmidon/foo.md": `---\ntitle: Foo\ntags: [arch]\nsources: [OPE-3999]\n---\n${long("Foo body")}\nsee [[bar]]\n`,
    "myrmidon/bar.md": long("Bar body"),
    "company/roles-adm.md": long("# Adm caste roles"),
    "company/roles-bbq.md": long("# Bbq caste roles"),
    "arch/old-answer.md": long("An old answer page"),
  };

  function map(): MigrateMap {
    return parseSlugMap(
      JSON.stringify({
        version: 1,
        expectedTotal: 5,
        defaultSources: ["OPE-3933"],
        pages: { "arch/old-answer.md": { class: "C", action: "merge", target: "arch/old-answer", mergeInto: "architecture/foo" } },
        checks: [{ query: "roles", expect: "product/roles-and-castes" }],
      }),
    );
  }

  it("writes items, folds a shared target into an extra revision, and supersedes merged pages", async () => {
    const root = makeExport(files);
    const plan = planMigration({ root, map: map(), expectedTotal: 5 });
    const log = emptyLog();
    const report = await runImport({ plan, service: stubWriter(log), companyId: "company-1", nestId: "nest-1", actor: AGENT, dryRun: false });

    // company/roles-adm.md and company/roles-bbq.md share a target: one item,
    // two revisions — the second page's knowledge is appended, not dropped.
    const roles = log.create.filter((call) => call.input.slug === "product/roles-and-castes");
    expect(roles).toHaveLength(1);
    expect(roles[0]?.input.title).toBe("Adm caste roles");
    expect(report.appended).toBe(1);
    const appended = log.draft.find((call) => call.slug === "product/roles-and-castes");
    expect(appended?.input.content).toContain("Adm caste roles");
    expect(appended?.input.content).toContain("Bbq caste roles");
    expect(appended?.input.sources?.some((source) => source.ref === "wiki/company/roles-bbq.md")).toBe(true);

    // Sources: the plugin page, the page's own frontmatter ref, the run default.
    const foo = log.create.find((call) => call.input.slug === "architecture/foo");
    expect(foo?.input.sources).toEqual([
      { kind: "document", ref: "wiki/myrmidon/foo.md" },
      { kind: "issue", ref: "OPE-3999" },
      { kind: "issue", ref: "OPE-3933" },
    ]);
    expect(foo?.input.content).toContain("[[architecture/bar]]");
    expect(foo?.input.tags).toEqual(["arch"]);

    // The merged page is created (its knowledge survives) and then superseded.
    expect(log.supersede).toEqual([{ nestId: "nest-1", slug: "arch/old-answer", bySlug: "architecture/foo" }]);
    expect(report.superseded).toEqual(["arch/old-answer"]);
    expect(report.mergeNeedsDecision).toEqual([]);

    expect(report.created).toBe(4);
    expect(report.revisionsWritten).toBe(5);
    expect(report.frontmatterParsed).toBe(1);
    expect(report.checks).toEqual([{ query: "roles", expect: "product/roles-and-castes", found: true, slug: "product/roles-and-castes" }]);
    expect(report.classSum).toMatchObject({ actual: 5, expected: 5, ok: true });
    expect(report.failed).toEqual([]);
  });

  it("writes nothing in dry-run but reports the same numbers", async () => {
    const root = makeExport(files);
    const plan = planMigration({ root, map: map(), expectedTotal: 5, dryRun: true });
    const log = emptyLog();
    const report = await runImport({ plan, service: stubWriter(log), companyId: "company-1", nestId: "nest-1", actor: AGENT, dryRun: true });

    expect(log.create).toEqual([]);
    expect(log.draft).toEqual([]);
    expect(log.supersede).toEqual([]);
    expect(log.search).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.created).toBe(4);
    expect(report.appended).toBe(1);
    expect(report.superseded).toEqual(["arch/old-answer"]);
    expect(report.checks[0]?.found).toBe(false);
  });

  it("reports a failing page by its code and keeps going", async () => {
    const root = makeExport(files);
    const plan = planMigration({ root, map: map(), expectedTotal: 5 });
    const log = emptyLog();
    const report = await runImport({
      plan,
      service: stubWriter(log, { failOn: "architecture/bar" }),
      companyId: "company-1",
      nestId: "nest-1",
      actor: AGENT,
      dryRun: false,
    });
    expect(report.failed).toContainEqual({ path: "myrmidon/bar.md", code: "knowledge_slug_taken" });
    expect(report.created).toBe(3);
  });
});

describe("seeding the operator's map", () => {
  it("seeds every page from the classifier and leaves the operator's checks alone", () => {
    const root = makeExport({ "myrmidon/foo.md": long("Foo"), "regulations/secrets.md": long("Secrets") });
    const plan = planMigration({ root, map: emptyMap({ expectedTotal: 2, defaultSources: ["OPE-3933"] }), expectedTotal: 2 });
    const seeded = seedSlugMap(plan);
    expect(Object.keys(seeded.pages).sort()).toEqual(["myrmidon/foo.md", "regulations/secrets.md"]);
    expect(seeded.pages["regulations/secrets.md"]).toMatchObject({ class: "B", action: "import", kind: "rule", approverKind: "owner" });
    expect(seeded.defaultSources).toEqual(["OPE-3933"]);
    expect(seeded.expectedTotal).toBe(2);
  });
});