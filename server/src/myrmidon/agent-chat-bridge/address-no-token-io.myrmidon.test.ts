import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "11111111-1111-4111-8111-111111111111";

function throwingDb() {
  const sentinel = new Error("unexpected catalog read");
  const select = vi.fn(() => { throw sentinel; });
  return { db: { select } as unknown as Db, select, sentinel };
}

function resolve(db: Db, text: string) {
  return resolveBridgeAddressee(db, { companyId, endpointAgentId: agentId, text });
}

describe("address resolution without catalog IO", () => {
  it.each([
    ["empty", ""],
    ["whitespace", " \t\n "],
    ["sentence", "Please prepare the report."],
    ["bare at sign", "Please ask @"],
    ["different URI scheme", `other-agent://${agentId}`],
  ])("returns none without select for %s", async (_label, text) => {
    const { db, select } = throwingDb();
    expect(await resolve(db, text)).toEqual({ kind: "none" });
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["@known", `agent://${agentId}`])("reaches select for %s", async (text) => {
    const { db, select, sentinel } = throwingDb();
    await expect(resolve(db, text)).rejects.toBe(sentinel);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not cache a catalog failure across tokenless calls", async () => {
    const { db, select, sentinel } = throwingDb();
    expect(await resolve(db, "before")).toEqual({ kind: "none" });
    expect(select).not.toHaveBeenCalled();
    await expect(resolve(db, "@known")).rejects.toBe(sentinel);
    expect(select).toHaveBeenCalledTimes(1);
    expect(await resolve(db, "after")).toEqual({ kind: "none" });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
