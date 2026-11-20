import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { errorMessage, redactSecrets, publishKnowledgeExport, type GitExportRunner } from "./git-export-git.js";
import { runKnowledgeExportPass } from "./git-export-job.js";
import { buildKnowledgeGitTree } from "./git-export.js";
import type { KnowledgeTreeDoc, KnowledgeTreePage } from "./domain.js";

const page = (): KnowledgeTreePage => ({
  slug: "ops/runbook",
  title: "Runbook",
  summary: null,
  kind: "wiki",
  folder: "ops",
  tags: [],
  roles: [],
  status: "published",
  approvalRequired: false,
  approverKind: null,
  content: "Safe content.\n",
});

const doc = (): KnowledgeTreeDoc => ({ nestId: "nest-1", pages: [page()] });

function syntheticSecrets() {
  const bearer = ["bear", "er", "-synthetic-redaction"].join("");
  const pcpKey = ["pcp", "_", "synthetic-redaction-key"].join("");
  const urlToken = ["url", "-synthetic-redaction-token"].join("");
  return { bearer, pcpKey, urlToken };
}

function failingRunner(secrets: ReturnType<typeof syntheticSecrets>): GitExportRunner {
  return {
    async git(_cwd, args) {
      throw new Error(
        [
          `Command failed: git ${args.join(" ")}`,
          `Authorization:   BeArEr ${secrets.bearer}`,
          `x-api-key: ${secrets.pcpKey}`,
          `fatal: unable to access 'https://user:${secrets.urlToken}@example.test/knowledge.git/path'`,
        ].join("\n"),
      );
    },
  };
}

describe("knowledge export error redaction", () => {
  it("redacts Bearer authorization values regardless of case and whitespace", () => {
    const { bearer } = syntheticSecrets();
    const message = `Authorization: Bearer ${bearer}\nauthorization:\t bEaReR   ${bearer}`;

    const redacted = redactSecrets(message);

    expect(redacted).not.toContain(bearer);
    expect(redacted).toContain("Authorization: Bearer <redacted>");
    expect(redacted).toContain("authorization:\t bEaReR   <redacted>");
  });

  it("redacts pcp_ keys outside URLs and preserves safe host and path text", () => {
    const { pcpKey } = syntheticSecrets();
    const message = `push failed for example.test/knowledge.git with ${pcpKey}; retry example.test/knowledge.git`;

    const redacted = redactSecrets(message);

    expect(redacted).not.toContain(pcpKey);
    expect(redacted).toContain("example.test/knowledge.git");
    expect(redacted).toContain("push failed");
  });

  it("redacts multiple secret forms in a multiline error and retains ordinary text", () => {
    const secrets = syntheticSecrets();
    const message = [
      "publish failed",
      `Authorization: bearer ${secrets.bearer}`,
      `configured key=${secrets.pcpKey}`,
      `remote https://user:${secrets.urlToken}@example.test/knowledge.git/path`,
      "safe diagnostic host/path example.test/knowledge.git",
    ].join("\n");

    const redacted = errorMessage(new Error(message));

    expect(redacted).not.toContain(secrets.bearer);
    expect(redacted).not.toContain(secrets.pcpKey);
    expect(redacted).not.toContain(secrets.urlToken);
    expect(redacted).toContain("publish failed");
    expect(redacted).toContain("safe diagnostic host/path example.test/knowledge.git");
  });

  it("keeps the existing URL userinfo redaction", () => {
    const { urlToken } = syntheticSecrets();

    expect(redactSecrets(`fatal https://user:${urlToken}@example.test/repo.git`)).toBe(
      "fatal https://<redacted>@example.test/repo.git",
    );
  });

  it("returns a generic message for non-Error thrown values", () => {
    expect(errorMessage({ message: "not trusted" })).toBe("unknown error");
  });

  it("keeps publish failures free of raw secrets and Error cause", async () => {
    const secrets = syntheticSecrets();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "knowledge-export-redaction-"));
    try {
      const err = await publishKnowledgeExport({
        workDir,
        repoUrl: `https://user:${secrets.urlToken}@example.test/knowledge.git`,
        branch: "knowledge-export",
        tree: buildKnowledgeGitTree(doc()),
        runner: failingRunner(secrets),
      }).then(
        () => null,
        (value: unknown) => value as Error,
      );

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).not.toContain(secrets.bearer);
      expect(err?.message).not.toContain(secrets.pcpKey);
      expect(err?.message).not.toContain(secrets.urlToken);
      expect("cause" in (err as object)).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("redacts the JSON log sink and counts a publish failure without false success", async () => {
    const secrets = syntheticSecrets();
    const lines: string[] = [];
    const sink = (fields: object, message: string) => lines.push(JSON.stringify({ fields, message }));
    const result = await runKnowledgeExportPass({} as never, {
      settings: {
        enabled: true,
        repoUrl: `https://user:${secrets.urlToken}@example.test/knowledge.git`,
        branch: "knowledge-export",
        intervalHours: 24,
      },
      ports: {
        listCompanyIds: async () => ["company-1"],
        exportCompany: async () => {
          const { serializeKnowledgeTree } = await import("./domain.js");
          return serializeKnowledgeTree(doc());
        },
        publish: async (input) =>
          publishKnowledgeExport({
            workDir: input.workDir,
            repoUrl: input.repoUrl,
            branch: input.branch,
            tree: input.tree,
            runner: failingRunner(secrets),
            pathPrefix: input.pathPrefix,
          }),
        log: { info: sink, warn: sink, error: sink },
      },
    });

    expect(result).toMatchObject({ enabled: true, companies: 1, committed: 0, unchanged: 0, failed: 1 });
    expect(lines.length).toBeGreaterThan(0);
    const serialized = lines.join("\n");
    expect(serialized).not.toContain(secrets.bearer);
    expect(serialized).not.toContain(secrets.pcpKey);
    expect(serialized).not.toContain(secrets.urlToken);
  });
});
