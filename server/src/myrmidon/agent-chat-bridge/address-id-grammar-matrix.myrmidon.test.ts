import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const COMPANY = "company-a";
const TARGET = "abcdef01-2345-4abc-8def-123456789abc";
const WRITER = "12345678-abcd-4abc-8def-123456789abc";
const rows = [
  { id: TARGET, name: "Target", title: null, status: "active", metadata: null, adapterConfig: null },
  { id: WRITER, name: "Writer", title: null, status: "active", metadata: { telegramAliases: ["writer"] }, adapterConfig: null },
];

function fakeDb(): Db {
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where() { return { orderBy: async () => rows }; },
  };
  return chain as unknown as Db;
}

async function resolve(text: string) {
  return resolveBridgeAddressee(fakeDb(), { companyId: COMPANY, endpointAgentId: WRITER, text });
}

const targetResult = { kind: "resolved", addressee: { agentId: TARGET, displayName: "Target" } };
const writerResult = { kind: "resolved", addressee: { agentId: WRITER, displayName: "Writer" } };

describe("explicit agent URI grammar matrix", () => {
  it.each([
    ["start", `agent://${TARGET} @writer`],
    ["space", `hello agent://${TARGET} @writer`],
    ["tab", `hello\tagent://${TARGET} @writer`],
    ["newline", `hello\nagent://${TARGET} @writer`],
    ["mixed-case scheme", `AgEnT://${TARGET} @writer`],
    ["uppercase UUID", `agent://${TARGET.toUpperCase()} @writer`],
    ["mixed-case scheme and UUID", `AGENT://${TARGET.toUpperCase()} @writer`],
  ])("recognizes %s and selects the exact ID", async (_label, text) => {
    expect(await resolve(text)).toEqual(targetResult);
  });

  it.each([
    ["empty URI", "agent://"],
    ["short UUID", `agent://${TARGET.slice(0, -1)}`],
    ["long UUID", `agent://${TARGET}a`],
    ["bad hex", `agent://g${TARGET.slice(1)}`],
    ["suffix", `agent://${TARGET}suffix`],
    ["punctuation", `agent://${TARGET},`],
    ["two identical URIs", `agent://${TARGET} agent://${TARGET}`],
    ["valid then invalid", `agent://${TARGET} agent://bad`],
    ["invalid then valid", `agent://bad agent://${TARGET}`],
  ])("rejects %s without falling back to the writer", async (_label, explicit) => {
    expect(await resolve(`@writer ${explicit}`)).toEqual({ kind: "invalid_id" });
  });

  it.each([
    ["bare UUID", TARGET],
    ["URI inside a word", `prefixagent://${TARGET}`],
  ])("treats %s as ordinary text", async (_label, text) => {
    expect(await resolve(text)).toEqual({ kind: "none" });
    expect(await resolve(`@writer ${text}`)).toEqual(writerResult);
    expect(await resolve(`@writer ${text}`)).toEqual(await resolve("@writer hello"));
  });
});
