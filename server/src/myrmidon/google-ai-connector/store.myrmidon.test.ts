// myrmidon(GOOGLE-AI-CONNECT-UI): connector store tests — no database.
//
// The document parser must degrade to empty on any malformed stored value
// (the key shares instance_settings.general with the vendor), the journal is a
// bounded newest-first window, and the preserve helper keeps only our key.

import { describe, expect, it } from "vitest";
import {
  GOOGLE_AI_CONNECTOR_GENERAL_KEY,
  appendGaiJournal,
  emptyGoogleAiConnectorDocument,
  memoryGoogleAiConnectorStore,
  parseGoogleAiConnectorDocument,
  preserveGoogleAiConnectorGeneralKey,
} from "./store.js";
import type { GaiJournalEntry } from "@paperclipai/shared/myrmidon-google-ai-connector";

function entry(index: number): GaiJournalEntry {
  return {
    id: `e${index}`,
    at: new Date(1_700_000_000_000 + index).toISOString(),
    actor: "agent-a",
    actorKind: "agent",
    action: "image",
    ok: true,
    detail: "ok",
  };
}

describe("parseGoogleAiConnectorDocument", () => {
  it("reads a malformed stored value as an empty document", () => {
    for (const raw of [undefined, null, "string", 42, [], {}]) {
      expect(parseGoogleAiConnectorDocument(raw)).toEqual(emptyGoogleAiConnectorDocument());
    }
  });

  it("drops malformed records but keeps the valid ones", () => {
    const doc = parseGoogleAiConnectorDocument({
      connections: [
        { id: "c1", companyId: "co1", secretId: "s1", connectedAt: "t", connectedBy: "u" },
        { id: "c2" },
      ],
      grants: [
        { id: "g1", companyId: "co1", capability: "generate_image", targetKind: "agent", agentId: "a1", caste: null, createdAt: "t", createdBy: "u" },
        { id: "g2", companyId: "co1", capability: "fly_a_kite", targetKind: "agent", createdAt: "t", createdBy: "u" },
        { id: "g3", companyId: "co1", capability: "creative_text", targetKind: "nobody", createdAt: "t", createdBy: "u" },
      ],
      journal: [{ id: "j1", at: "t", actor: "a1", actorKind: "owner", action: "connect", ok: false, detail: "x" }, { id: "j2" }],
    });
    expect(doc.connections.map((c) => c.id)).toEqual(["c1"]);
    expect(doc.grants.map((g) => g.id)).toEqual(["g1"]);
    expect(doc.journal.map((j) => j.id)).toEqual(["j1"]);
    // a status the writer did not recognize normalizes to the safe one
    expect(doc.connections[0]!.status).toBe("connected");
  });
});

describe("appendGaiJournal", () => {
  it("keeps newest first and bounds the window", () => {
    let doc = emptyGoogleAiConnectorDocument();
    for (let i = 0; i < 260; i += 1) doc = appendGaiJournal(doc, entry(i));
    expect(doc.journal).toHaveLength(200);
    expect(doc.journal[0]!.id).toBe("e259");
    expect(doc.journal.at(-1)!.id).toBe("e60");
  });
});

describe("preserveGoogleAiConnectorGeneralKey", () => {
  it("returns nothing when the stored general has no connector key", () => {
    expect(preserveGoogleAiConnectorGeneralKey(undefined)).toEqual({});
    expect(preserveGoogleAiConnectorGeneralKey({ other: 1 })).toEqual({});
    expect(preserveGoogleAiConnectorGeneralKey("nope")).toEqual({});
  });

  it("carries only our key over a vendor write", () => {
    const stored = { [GOOGLE_AI_CONNECTOR_GENERAL_KEY]: { version: 1 }, myrmidonCloudConnector: { keep: "theirs" } };
    expect(preserveGoogleAiConnectorGeneralKey(stored)).toEqual({ [GOOGLE_AI_CONNECTOR_GENERAL_KEY]: { version: 1 } });
  });
});

describe("memoryGoogleAiConnectorStore", () => {
  it("applies a mutation and reports whether the document changed", async () => {
    const store = memoryGoogleAiConnectorStore();
    const first = await store.mutate((current) => ({
      next: appendGaiJournal(current, entry(1)),
      result: "ok",
    }));
    expect(first.changed).toBe(true);
    expect(first.result).toBe("ok");
    const second = await store.mutate(() => ({ next: null, result: 0 }));
    expect(second.changed).toBe(false);
    expect((await store.read()).journal.map((j) => j.id)).toEqual(["e1"]);
  });
});
