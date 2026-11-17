import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "33333333-3333-4333-8333-333333333333";

const alpha = Object.freeze({ id: A, name: "alpha-pilot", title: null, status: "active", adapterConfig: null, metadata: null });
const beta = Object.freeze({ id: B, name: "beta-pilot", title: null, status: "active", adapterConfig: null, metadata: null });
const both = Object.freeze([alpha, beta]);
const onlyBeta = Object.freeze([beta]);
const restored = Object.freeze([alpha, beta]);

const resolved = (agentId: string, displayName: string) => ({
  kind: "resolved", addressee: { agentId, displayName },
});

describe("computed alias membership reload", () => {
  it("reallocates both handles when an owner leaves and returns without mutating rows", async () => {
    let rows: readonly (typeof alpha | typeof beta)[] = both;
    let reads = 0;
    const chain = {
      select() { return chain; },
      from() { return chain; },
      where() { return chain; },
      orderBy() { reads += 1; return Promise.resolve(rows); },
    };
    const db = chain as unknown as Db;
    const before = structuredClone([both, onlyBeta, restored]);
    const transitions = [
      { rows: both, pilot: resolved(A, "alpha-pilot"), suffix: resolved(B, "beta-pilot") },
      { rows: onlyBeta, pilot: resolved(B, "beta-pilot"), suffix: { kind: "none" } },
      { rows: restored, pilot: resolved(A, "alpha-pilot"), suffix: resolved(B, "beta-pilot") },
    ];

    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (const transition of transitions) {
        rows = transition.rows;
        for (const [handle, expected] of [["pilot", transition.pilot], ["pilot-2", transition.suffix]] as const) {
          expect(await resolveBridgeAddressee(db, {
            companyId: "company-a", endpointAgentId: ENDPOINT, text: `@${handle}`,
          })).toEqual(expected);
        }
      }
    }
    expect(reads).toBe(12);
    expect([both, onlyBeta, restored]).toEqual(before);
    expect(Object.isFrozen(both) && Object.isFrozen(onlyBeta) && Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(alpha) && Object.isFrozen(beta)).toBe(true);
  });
});
