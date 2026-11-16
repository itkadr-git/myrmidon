import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

interface Row {
  id: string;
  name: string;
  title: string | null;
  status: string;
  metadata: Record<string, unknown>;
  adapterConfig: Record<string, unknown>;
}

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const hiddenId = "33333333-3333-4333-8333-333333333333";
const base: Row = { id: firstId, name: "LiveOne", title: null, status: "idle", metadata: {}, adapterConfig: {} };

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fakeDb(rows: Row[]): Db {
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where() { return chain; },
    orderBy() { return Promise.resolve(rows); },
  };
  return chain as unknown as Db;
}

function resolve(rows: Row[], handle: string) {
  return resolveBridgeAddressee(fakeDb(freezeDeep(rows)), {
    companyId: "company-a", endpointAgentId: firstId, text: `@${handle}`,
  });
}

const hiddenCases: Array<[string, Partial<Row>]> = [
  ["paused", { status: "paused" }],
  ["terminated", { status: "terminated" }],
  ["pending approval", { status: "pending_approval" }],
  ["retired", { name: "Archive-retired" }],
  ["plugin service", { metadata: { pluginManagedAgent: true } }],
  ["false plugin marker", { metadata: { pluginManagedAgent: false } }],
  ["managed service", { metadata: { paperclipManagedResource: {} } }],
  ["false managed marker", { metadata: { paperclipManagedResource: false } }],
];

describe("textual bridge addressing ignores hidden cards", () => {
  it.each(hiddenCases)("excludes %s from name, title and both alias sources", async (_label, hiddenChange) => {
    for (const field of ["name", "title", "metadata", "adapterConfig"] as const) {
      // A retired name is necessarily hidden, so match that name using a live alias.
      const handle = field === "name" && hiddenChange.name ? "Archive-retired" : "shared";
      const live: Row = { ...base, metadata: { telegramAliases: [handle] } };
      const other: Row = { ...base, id: secondId, name: "LiveTwo", status: "running", adapterConfig: { telegramAliases: [handle] } };
      const hidden: Row = {
        ...base, id: hiddenId, name: field === "name" ? handle : "Hidden",
        ...hiddenChange,
        title: field === "title" ? handle : null,
        metadata: { ...hiddenChange.metadata, ...(field === "metadata" ? { telegramAliases: [handle] } : {}) },
        adapterConfig: field === "adapterConfig" ? { telegramAliases: [handle] } : {},
      };
      const expected = { kind: "resolved", addressee: { agentId: firstId, displayName: live.name } };
      expect(await resolve([hidden, live], handle)).toEqual(expected);
      expect(await resolve([live, hidden], handle)).toEqual(expected);
      expect(await resolve([hidden, live], handle)).toEqual(expected);
      expect(await resolve([hidden], handle)).toEqual({ kind: "none" });
      expect(await resolve([live, hidden, other], handle)).toEqual({
        kind: "ambiguous", handle: handle.toLowerCase(), candidates: [
          { agentId: firstId, name: live.name }, { agentId: secondId, name: other.name },
        ],
      });
    }
  });

  it.each(hiddenCases)("does not let %s reserve a live computed alias", async (_label, hiddenChange) => {
    for (const source of ["metadata", "adapterConfig"] as const) {
      const hidden: Row = {
        ...base, id: hiddenId, name: "Hidden", ...hiddenChange,
        metadata: { ...hiddenChange.metadata, ...(source === "metadata" ? { telegramAliases: ["pilot"] } : {}) },
        adapterConfig: source === "adapterConfig" ? { telegramAliases: ["pilot"] } : {},
      };
      const live: Row = { ...base, name: "team-pilot", status: "running" };
      const expected = { kind: "resolved", addressee: { agentId: firstId, displayName: live.name } };
      expect(await resolve([hidden, live], "pilot")).toEqual(expected);
      expect(await resolve([live, hidden], "pilot")).toEqual(expected);
      expect(await resolve([hidden, live], "pilot-2")).toEqual({ kind: "none" });
    }
  });
});
