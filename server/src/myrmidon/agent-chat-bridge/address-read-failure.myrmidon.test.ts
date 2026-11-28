import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "company-a";
const agentId = "11111111-1111-4111-8111-111111111111";
const endpointAgentId = "22222222-2222-4222-8222-222222222222";
const row = { id: agentId, name: "Support Agent", title: null, status: "active", metadata: { telegramAliases: ["support"] }, adapterConfig: {} };
type Failure = "select" | "where" | "orderBy" | "reject";

function fakeDb(failure?: Failure, error = new Error("directory failed")) {
  const captured: { fields?: Record<string, unknown>; where?: SQL } = {};
  let fail = failure;
  const maybeThrow = (stage: Failure) => {
    if (fail === stage) { fail = undefined; throw error; }
  };
  const chain = {
    select: vi.fn((fields: Record<string, unknown>) => { maybeThrow("select"); captured.fields = fields; return chain; }),
    from: vi.fn(() => chain),
    where: vi.fn((condition: SQL) => { maybeThrow("where"); captured.where = condition; return chain; }),
    orderBy: vi.fn(() => {
      maybeThrow("orderBy");
      if (fail === "reject") { fail = undefined; return Promise.reject(error); }
      return Promise.resolve([row]);
    }),
    insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
  };
  return { db: chain as unknown as Db, chain, captured, error };
}

const inputs = [
  { companyId, text: `agent://${agentId} hello`, endpointAgentId },
  { companyId, text: "@support hello", endpointAgentId },
];
const resolved = { kind: "resolved", addressee: { agentId, displayName: "Support Agent" } };

function expectNoWrites(chain: ReturnType<typeof fakeDb>["chain"]) {
  expect(chain.insert).not.toHaveBeenCalled();
  expect(chain.update).not.toHaveBeenCalled();
  expect(chain.delete).not.toHaveBeenCalled();
}

describe("bridge directory read failures", () => {
  it("does not read the directory for plain text", async () => {
    const { db, chain } = fakeDb();
    const input = { companyId, text: "hello there", endpointAgentId };
    const before = structuredClone(input);
    await expect(resolveBridgeAddressee(db, input)).resolves.toEqual({ kind: "none" });
    expect(chain.select).not.toHaveBeenCalled();
    expect(chain.from).not.toHaveBeenCalled();
    expect(chain.where).not.toHaveBeenCalled();
    expect(chain.orderBy).not.toHaveBeenCalled();
    expectNoWrites(chain);
    expect(input).toEqual(before);
  });

  it.each(inputs)("reads exactly one company-scoped directory for $text", async (input) => {
    const { db, chain, captured } = fakeDb();
    const before = structuredClone(input);
    await expect(resolveBridgeAddressee(db, input)).resolves.toEqual(resolved);
    expect(chain.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(captured.where!);
    expect(query.sql).toMatch(/"company_id" = \$1/);
    expect(query.params).toEqual([companyId]);
    expect(Object.keys(captured.fields ?? {})).toEqual(expect.arrayContaining(["status", "metadata", "adapterConfig"]));
    expectNoWrites(chain);
    expect(input).toEqual(before);
  });

  it.each(inputs.flatMap((input) => (["select", "where", "orderBy", "reject"] as const).map((stage) => ({ input, stage }))))(
    "propagates the same $stage error and retries independently for $input.text",
    async ({ input, stage }) => {
      const { db, chain, error } = fakeDb(stage);
      const before = structuredClone(input);
      await expect(resolveBridgeAddressee(db, input)).rejects.toBe(error);
      expect(input).toEqual(before);
      await expect(resolveBridgeAddressee(db, input)).resolves.toEqual(resolved);
      expect(chain.select).toHaveBeenCalledTimes(2);
      expectNoWrites(chain);
      expect(input).toEqual(before);
    },
  );
});
