import { describe, expect, it } from "vitest";
import { createAdmKnowledgeAdapter } from "./adm-knowledge-adapter.js";

const adapter = createAdmKnowledgeAdapter({
  search: async () => [],
  list: async () => [],
  read: async () => null,
});

const base = {
  schema_version: 1,
  slug: "adm/reference/example",
  kind: "wiki",
  title: "Example",
  summary: "Summary",
  tags: ["example-tag"],
  triggers: ["deploy"],
  priority: 50,
  owner: "owner",
  source_ref: "source",
  sensitivity: "internal",
  status: "published",
  revision_id: "revision",
  updated_at: "2026-10-25T00:00:00.000Z",
};

describe("ADM knowledge metadata contract", () => {
  const valid: [string, Record<string, unknown>][] = [
    ["policy with owner", { slug: "adm/policy/a-1", kind: "rule", approver_kind: "owner" }],
    ["trigger with owner", { slug: "adm/trigger/a-1", kind: "rule", approver_kind: "owner" }],
    ["reference without approver", { slug: "adm/reference/a-1", kind: "wiki" }],
    ["skills without approver", { slug: "adm/skills/a-1", kind: "skill_card" }],
    ["lessons without approver", { slug: "adm/lessons/a-1", kind: "wiki" }],
    ["minimum title", { title: "a" }],
    ["maximum title", { title: "a".repeat(160) }],
    ["maximum summary", { summary: "a".repeat(300) }],
    ["empty summary", { summary: "" }],
    ["minimum priority", { priority: 0 }],
    ["maximum priority", { priority: 100 }],
    ["empty tags and triggers", { tags: [], triggers: [] }],
    ["all trigger values", { triggers: ["ssh", "deploy", "paperclip-api", "incident", "config-change", "release", "merge", "owner-message"] }],
    ["positive offset timestamp", { updated_at: "2026-10-25T12:30:00+05:30" }],
    ["negative offset timestamp", { updated_at: "2026-10-25T12:30:00-04:00" }],
    ...["draft", "proposed", "published", "archived"].map((status): [string, Record<string, unknown>] => [`status ${status}`, { status }]),
  ];
  it.each(valid)("accepts %s", (_name, patch) => {
    const input = { ...base, ...patch };
    expect(adapter.validateMetadata(input)).toEqual(input);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["policy without owner approval", { slug: "adm/policy/test", kind: "rule" }],
    ["trigger without owner approval", { slug: "adm/trigger/test", kind: "rule" }],
    ["rule approved by agent", { slug: "adm/policy/test", kind: "rule", approver_kind: "agent" }],
    ["policy wrong kind", { slug: "adm/policy/test", kind: "wiki" }],
    ["trigger wrong kind", { slug: "adm/trigger/test", kind: "wiki" }],
    ["reference wrong kind", { kind: "skill_card" }],
    ["skills wrong kind", { slug: "adm/skills/test", kind: "wiki" }],
    ["lessons wrong kind", { slug: "adm/lessons/test", kind: "skill_card" }],
    ["empty title", { title: "" }],
    ["title over maximum", { title: "a".repeat(161) }],
    ["summary over maximum", { summary: "a".repeat(301) }],
    ["negative priority", { priority: -1 }],
    ["priority over maximum", { priority: 101 }],
    ["fractional priority", { priority: 1.5 }],
    ["unknown namespace", { slug: "adm/unknown/test" }],
    ["empty slug suffix", { slug: "adm/reference/" }],
    ["uppercase slug", { slug: "adm/reference/Test" }],
    ["underscore in slug", { slug: "adm/reference/test_name" }],
    ["slash in slug suffix", { slug: "adm/reference/test/name" }],
    ["slug starts with hyphen", { slug: "adm/reference/-test" }],
    ["invalid tag", { tags: ["bad_tag"] }],
    ["empty tag", { tags: [""] }],
    ["uppercase tag", { tags: ["Tag"] }],
    ["unknown trigger", { triggers: ["unknown"] }],
    ["wrong schema version", { schema_version: 2 }],
    ["wrong sensitivity", { sensitivity: "public" }],
    ["unknown status", { status: "deleted" }],
    ["invalid date", { updated_at: "2026-02-30T12:30:00Z" }],
    ["timestamp without offset", { updated_at: "2026-10-25T12:30:00" }],
    ["empty owner", { owner: "" }],
    ["empty source", { source_ref: "" }],
    ["empty revision", { revision_id: "" }],
  ];
  it.each(invalid)("rejects %s", (_name, patch) => {
    expect(() => adapter.validateMetadata({ ...base, ...patch })).toThrow(
      expect.objectContaining({ name: "AdmConnectorError", code: "ADM_INVALID_METADATA" }),
    );
  });
});
