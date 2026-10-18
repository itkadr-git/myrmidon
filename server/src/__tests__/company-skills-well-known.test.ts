import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companySkills, companies, createDb, folders } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  companySkillService,
  extractRequiredEnvFromMarkdown,
  parseSkillImportSourceInput,
} from "../services/company-skills.ts";
import { removeRuntimeSkillCache } from "../services/runtime-skill-cache.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ORIGIN = "https://skills.example";
const INDEX_URL = `${ORIGIN}/.well-known/agent-skills/index.json`;

function sha256Hex(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Minimal USTAR writer good enough for test archives: 512-byte headers with
 * name/mode/uid/gid/size/mtime/checksum/typeflag/magic and 512-byte data
 * blocks, gzipped. Supports crafting unsafe fixtures (absolute paths, `..`,
 * symlink entries) that the importer must reject.
 */
function buildTarGz(
  entries: Array<{ path: string; content: string; typeflag?: string; linkName?: string }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const name = Buffer.from(entry.path, "utf8");
    name.copy(header, 0, 0, Math.min(name.length, 100));
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    const data = Buffer.from(entry.content ?? "", "utf8");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("17000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write(entry.typeflag ?? "0", 156, "ascii");
    if (entry.linkName) {
      const link = Buffer.from(entry.linkName, "utf8");
      link.copy(header, 157, 0, Math.min(link.length, 100));
    }
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(header);
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
      data.copy(padded, 0);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

const DEMO_SKILL_MD = [
  "---",
  "name: demo-skill",
  "description: Demo well-known skill",
  "---",
  "",
  "Export KIE_API_KEY first: `echo $KIE_API_KEY`.",
  "Optionally set process.env.DEMO_SKILL_TOKEN and os.environ.get(\"FOO_SECRET\").",
].join("\n");

type StubRoute = { match: string | RegExp; respond: (url: string) => Response };

function stubFetch(routes: StubRoute[]) {
  const upstream = vi.fn(async (input: string | URL) => {
    const url = String(input);
    for (const route of routes) {
      const hit = typeof route.match === "string" ? url === route.match : route.match.test(url);
      if (hit) return route.respond(url);
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function indexPayload(overrides: Record<string, unknown> = {}) {
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "demo-skill",
        type: "archive",
        description: "Demo well-known skill",
        url: "demo-skill.tar.gz",
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ...overrides,
      },
    ],
  };
}

describe("parseSkillImportSourceInput well-known detection", () => {
  it("recognizes bare HTTPS sites and their discovery index URLs", () => {
    expect(parseSkillImportSourceInput("https://kie.ai").wellKnownOrigin).toBe("https://kie.ai");
    expect(parseSkillImportSourceInput("npx skills add https://kie.ai").wellKnownOrigin).toBe("https://kie.ai");
    expect(
      parseSkillImportSourceInput("https://kie.ai/.well-known/agent-skills/index.json").wellKnownOrigin,
    ).toBe("https://kie.ai");
  });

  it("keeps GitHub, skills.sh and file-style sources out of well-known", () => {
    expect(parseSkillImportSourceInput("https://github.com/acme/repo").wellKnownOrigin).toBeNull();
    expect(parseSkillImportSourceInput("acme/repo").wellKnownOrigin).toBeNull();
    expect(parseSkillImportSourceInput("acme/repo/skill").wellKnownOrigin).toBeNull();
    expect(parseSkillImportSourceInput("https://skills.sh/acme/repo/skill").wellKnownOrigin).toBeNull();
    expect(parseSkillImportSourceInput("https://example.com/skills/demo.md").wellKnownOrigin).toBeNull();
  });
});

describe("extractRequiredEnvFromMarkdown", () => {
  it("extracts *_KEY / *_TOKEN / *_SECRET and explicit env references", () => {
    const env = extractRequiredEnvFromMarkdown(DEMO_SKILL_MD);
    expect(env).toContain("KIE_API_KEY");
    expect(env).toContain("DEMO_SKILL_TOKEN");
    expect(env).toContain("FOO_SECRET");
    expect(env).toEqual([...env].sort());
  });

  it("ignores prose without env-shaped tokens", () => {
    expect(extractRequiredEnvFromMarkdown("Just a plain markdown file.")).toEqual([]);
  });
});

describeEmbeddedPostgres("companySkillService well-known discovery + import", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipInstanceId: string | undefined;
  let paperclipHome: string | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-well-known-skills-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-well-known-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Well-known tests", issuePrefix: `WK${companyId.slice(0, 4)}` });
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const row of await db.select().from(companySkills)) {
      await removeRuntimeSkillCache(
        path.join(paperclipHome!, "instances", "default", "skills", row.companyId),
        row.id,
      ).catch(() => undefined);
    }
    await db.delete(companySkills);
    await db.delete(folders);
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await db.delete(authUsers).catch(() => undefined);
    await db.delete(companies).catch(() => undefined);
    await tempDb?.cleanup();
  });

  it("discovers skills from a mocked well-known index", async () => {
    stubFetch([{ match: INDEX_URL, respond: () => jsonResponse(indexPayload()) }]);
    const result = await svc.discoverSkills(companyId, ORIGIN);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe("demo-skill");
    expect(result.skills[0]!.description).toBe("Demo well-known skill");
    expect(result.skills[0]!.url).toBe(`${ORIGIN}/demo-skill.tar.gz`);
    expect(result.skills[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects discovery of non well-known sources with a clear 422", async () => {
    stubFetch([]);
    await expect(svc.discoverSkills(companyId, "https://github.com/acme/repo")).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_discovery_invalid_source" },
    });
  });

  it("rejects malformed index payloads with a clear 422", async () => {
    stubFetch([{ match: INDEX_URL, respond: () => new Response("plain text", { status: 200 }) }]);
    await expect(svc.discoverSkills(companyId, ORIGIN)).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_discovery_invalid" },
    });
  });

  it("imports a well-known skill when the digest matches and extracts requiredEnv", async () => {
    const archive = buildTarGz([
      { path: "SKILL.md", content: DEMO_SKILL_MD },
      { path: "references/en.md", content: "# Reference\n" },
    ]);
    const digest = `sha256:${sha256Hex(archive)}`;
    stubFetch([
      { match: INDEX_URL, respond: () => jsonResponse(indexPayload({ digest })) },
      { match: `${ORIGIN}/demo-skill.tar.gz`, respond: () => new Response(archive, { status: 200 }) },
    ]);

    const result = await svc.importFromSource(companyId, ORIGIN, { skillName: "demo-skill" });
    expect(result.imported).toHaveLength(1);
    const skill = result.imported[0]!;
    expect(skill.sourceType).toBe("well_known");
    expect(skill.sourceLocator).toBe(ORIGIN);
    expect(skill.slug).toBe("demo-skill");
    const metadata = skill.metadata as Record<string, unknown>;
    expect(metadata.digest).toBe(digest);
    expect(metadata.requiredEnv).toEqual(expect.arrayContaining(["KIE_API_KEY", "DEMO_SKILL_TOKEN", "FOO_SECRET"]));

    const detail = await svc.detail(companyId, skill.id);
    expect(detail?.requiredEnv).toEqual(expect.arrayContaining(["KIE_API_KEY"]));
    expect(detail?.sourceBadge).toBe("well_known");

    const versions = await svc.listVersions(companyId, skill.id);
    expect(versions).toHaveLength(1);

    const file = await svc.readFile(companyId, skill.id, "references/en.md");
    expect(file?.content).toContain("Reference");
  });

  it("rejects imports when the archive digest does not match the index", async () => {
    const archive = buildTarGz([{ path: "SKILL.md", content: DEMO_SKILL_MD }]);
    stubFetch([
      {
        match: INDEX_URL,
        respond: () => jsonResponse(indexPayload({ digest: `sha256:${"f".repeat(64)}` })),
      },
      { match: `${ORIGIN}/demo-skill.tar.gz`, respond: () => new Response(archive, { status: 200 }) },
    ]);
    await expect(svc.importFromSource(companyId, ORIGIN, { skillName: "demo-skill" })).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_digest_mismatch" },
    });
  });

  it("rejects archives with path traversal or absolute paths", async () => {
    const traversal = buildTarGz([
      { path: "SKILL.md", content: DEMO_SKILL_MD },
      { path: "../evil.md", content: "# evil\n" },
    ]);
    const digest = `sha256:${sha256Hex(traversal)}`;
    stubFetch([
      { match: INDEX_URL, respond: () => jsonResponse(indexPayload({ digest, name: "evil-skill", description: null })) },
      { match: `${ORIGIN}/evil-skill.tar.gz`, respond: () => new Response(traversal, { status: 200 }) },
    ]);
    await expect(svc.importFromSource(companyId, ORIGIN, { skillName: "evil-skill" })).rejects.toMatchObject({ status: 422 });

    const absolute = buildTarGz([
      { path: "SKILL.md", content: DEMO_SKILL_MD },
      { path: "/etc/passwd", content: "nope\n" },
    ]);
    const absoluteDigest = `sha256:${sha256Hex(absolute)}`;
    stubFetch([
      {
        match: INDEX_URL,
        respond: () => jsonResponse(indexPayload({ digest: absoluteDigest, name: "abs-skill", url: "abs-skill.tar.gz" })),
      },
      { match: `${ORIGIN}/abs-skill.tar.gz`, respond: () => new Response(absolute, { status: 200 }) },
    ]);
    await expect(svc.importFromSource(companyId, ORIGIN, { skillName: "abs-skill" })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects symlink entries in archives", async () => {
    const archive = buildTarGz([
      { path: "SKILL.md", content: DEMO_SKILL_MD },
      { path: "link.md", content: "", typeflag: "2", linkName: "SKILL.md" },
    ]);
    const digest = `sha256:${sha256Hex(archive)}`;
    stubFetch([
      { match: INDEX_URL, respond: () => jsonResponse(indexPayload({ digest, name: "link-skill", url: "link-skill.tar.gz" })) },
      { match: `${ORIGIN}/link-skill.tar.gz`, respond: () => new Response(archive, { status: 200 }) },
    ]);
    await expect(svc.importFromSource(companyId, ORIGIN, { skillName: "link-skill" })).rejects.toMatchObject({ status: 422 });
  });

  it("re-imports an updated archive as a new version and keeps unchanged digests quiet", async () => {
    const firstArchive = buildTarGz([{ path: "SKILL.md", content: DEMO_SKILL_MD }]);
    const firstDigest = `sha256:${sha256Hex(firstArchive)}`;
    const routes: StubRoute[] = [
      { match: INDEX_URL, respond: () => jsonResponse(indexPayload({ digest: firstDigest, name: "cycle-skill", url: "cycle-skill.tar.gz" })) },
      { match: `${ORIGIN}/cycle-skill.tar.gz`, respond: () => new Response(firstArchive, { status: 200 }) },
    ];
    stubFetch(routes);
    const first = await svc.importFromSource(companyId, ORIGIN, { skillName: "cycle-skill" });
    const skill = first.imported[0]!;
    expect(await svc.listVersions(companyId, skill.id)).toHaveLength(1);

    // Same digest: the import is idempotent and adds no version.
    const repeat = await svc.importFromSource(companyId, ORIGIN, { skillName: "cycle-skill" });
    expect(repeat.imported[0]!.id).toBe(skill.id);
    expect(await svc.listVersions(companyId, skill.id)).toHaveLength(1);

    // New content + new digest: a new version is recorded.
    const secondArchive = buildTarGz([{ path: "SKILL.md", content: `${DEMO_SKILL_MD}\nUpdated body.\n` }]);
    const secondDigest = `sha256:${sha256Hex(secondArchive)}`;
    routes[0]!.respond = () => jsonResponse(indexPayload({ digest: secondDigest, name: "cycle-skill", url: "cycle-skill.tar.gz" }));
    routes[1]!.respond = () => new Response(secondArchive, { status: 200 });
    const updated = await svc.importFromSource(companyId, ORIGIN, { skillName: "cycle-skill" });
    expect(updated.imported[0]!.id).toBe(skill.id);
    const versions = await svc.listVersions(companyId, skill.id);
    expect(versions).toHaveLength(2);
  });
});
