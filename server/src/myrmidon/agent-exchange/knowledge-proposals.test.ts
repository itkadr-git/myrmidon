// server/src/myrmidon/agent-exchange/knowledge-proposals.test.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-12 Ч2): the pure extraction contract — no DB,
// no model, no network. Covers the acceptance criteria: a trailing proposals
// block splits off into drafts, a missing/broken block degrades without
// throwing, the three-proposal cap keeps the first ones and reports itself,
// and the `suggest` input shape (single-line body, stable idempotency key
// from the room id and the index, `debate` source, `internal` trust).

import { describe, expect, it } from "vitest";
import {
  AGENT_EXCHANGE_PROPOSALS_PROMPT,
  extractRoomProposals,
  toSuggestionInput,
} from "./knowledge-proposals.js";

function block(items: unknown): string {
  return "```proposals\n" + JSON.stringify(items, null, 2) + "\n```";
}

const A = {
  title: "Pin the runner version",
  claim: "Pin the runner image version in the fleet config",
  positions: "All agreed; B noted the digest pin.",
};
const B = {
  title: "Retry once",
  claim: "Retry a failed model call once before failing the room",
  positions: "A against, B for: one retry only.",
};
const C = {
  title: "Log token spend",
  claim: "Log the token spend per participant",
  positions: "Agreed.",
};

describe("agent-exchange knowledge proposals (myrmidon 1.7 KNOWLEDGE-2.0 L-12 Ч2)", () => {
  it("splits two correct drafts off a trailing proposals block and strips it from the visible summary", () => {
    const answer = `Where we agree.\nNext step: pin the image.\n${block([A, B])}`;
    const result = extractRoomProposals(answer);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]).toMatchObject({ title: A.title, claim: A.claim, positions: A.positions });
    expect(result.drafts[1]).toMatchObject({ title: B.title, claim: B.claim, positions: B.positions });
    expect(result.visibleSummary).toBe("Where we agree.\nNext step: pin the image.");
    expect(result.visibleSummary).not.toContain("```proposals");
    expect(result.problems).toEqual([]);
  });

  it("passes the answer through unchanged when there is no proposals block", () => {
    const result = extractRoomProposals("Just a summary, no block.  \n");
    expect(result.visibleSummary).toBe("Just a summary, no block.");
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("reports proposals_block_invalid_json for a broken payload without throwing", () => {
    const answer = `Summary.\n\`\`\`proposals\n[{ "claim": unquoted\n\`\`\``;
    const result = extractRoomProposals(answer);
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual(["proposals_block_invalid_json"]);
    expect(result.visibleSummary).toBe("Summary.");
  });

  it("treats a non-array payload as an invalid block", () => {
    const result = extractRoomProposals(`Summary.\n${block({ claim: "not an array" })}`);
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual(["proposals_block_invalid_json"]);
  });

  it("keeps the first three of four items and reports proposals_over_limit", () => {
    const fourth = { title: "Too late", claim: "The fourth proposal", positions: "Dropped." };
    const result = extractRoomProposals(`Summary.\n${block([A, B, C, fourth])}`);
    expect(result.problems).toEqual(["proposals_over_limit"]);
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts.map((d) => d.claim)).toEqual([A.claim, B.claim, C.claim]);
  });

  it("collapses the claim to a single line so the suggest body never carries a newline", () => {
    const result = extractRoomProposals(
      `Summary.\n${block([{ title: "Multi\nline", claim: "line1\nline2\r\nline3", positions: "p" }])}`,
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.claim).toBe("line1 line2 line3");
    expect(result.drafts[0]!.title).toBe("Multi line");
    const input = toSuggestionInput("room-1", result.drafts[0]!, 0);
    expect(input.body).toBe("[exchange-room] line1 line2 line3");
    expect(input.body).not.toMatch(/[\r\n]/);
  });
  it("clamps over-long fields to the contract limits", () => {
    const result = extractRoomProposals(
      `Summary.\n${block([
        { title: "t".repeat(400), claim: "c".repeat(600), positions: "p".repeat(5000) },
      ])}`,
    );
    expect(result.drafts[0]!.title).toHaveLength(300);
    expect(result.drafts[0]!.claim).toHaveLength(500);
    expect(result.drafts[0]!.positions).toHaveLength(4000);
  });

  it("drops a targetSlug with characters outside [a-z0-9._/-] and keeps a valid one", () => {
    const result = extractRoomProposals(
      `Summary.\n${block([
        { ...A, targetSlug: "My Page! (bad)" },
        { ...B, targetSlug: "ops/runbooks/pg-2.v1" },
      ])}`,
    );
    expect(result.drafts[0]!.targetSlug).toBeUndefined();
    expect(result.drafts[1]!.targetSlug).toBe("ops/runbooks/pg-2.v1");
  });

  it("drops items with an empty or non-string claim", () => {
    const result = extractRoomProposals(
      `Summary.\n${block([{ title: "no claim", claim: "   ", positions: "p" }, { title: "n", claim: 42 }, A])}`,
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.claim).toBe(A.claim);
    expect(result.problems).toEqual([]);
  });

  it("keeps the text before and after a proposals block in the middle of the answer", () => {
    const answer = `before\n${block([])}\nafter`;
    const result = extractRoomProposals(answer);
    expect(result.visibleSummary).toBe("before\nafter");
    expect(result.drafts).toEqual([]);
  });

  it("extracts an unterminated block (no closing fence)", () => {
    const answer = `Summary.\n\`\`\`proposals\n${JSON.stringify([A])}`;
    const result = extractRoomProposals(answer);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.claim).toBe(A.claim);
    expect(result.visibleSummary).toBe("Summary.");
  });

  it("keeps nested backticks inside positions intact", () => {
    const item = { ...A, positions: "Use ```ts fenced examples in the runbook." };
    const result = extractRoomProposals(`Summary.\n${block([item])}`);
    expect(result.drafts[0]!.positions).toBe("Use ```ts fenced examples in the runbook.");
  });

  it("accepts an explicit empty array as nothing to propose", () => {
    const result = extractRoomProposals(`Summary.\n${block([])}`);
    expect(result.drafts).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("derives a stable idempotency key from the room and the index", () => {
    const draft = { title: "t", claim: "c", positions: "p" };
    const first = toSuggestionInput("room-42", draft, 0);
    const again = toSuggestionInput("room-42", draft, 0);
    const otherIndex = toSuggestionInput("room-42", draft, 2);
    const otherRoom = toSuggestionInput("room-43", draft, 0);
    expect(first.idempotencyKey).toBe("exchange-room:room-42:0");
    expect(again.idempotencyKey).toBe(first.idempotencyKey);
    expect(otherIndex.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(otherRoom.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("shapes the suggest input: debate source, internal trust, rationale, optional targetSlug", () => {
    const withSlug = toSuggestionInput("room-42", { ...A, targetSlug: "ops/runbooks/pg" }, 1);
    expect(withSlug).toEqual({
      body: `[exchange-room] ${A.claim}`,
      rationale: `${A.title}\n${A.positions}`,
      sourceKind: "debate",
      sourceRef: "room-42",
      trust: "internal",
      targetSlug: "ops/runbooks/pg",
      idempotencyKey: "exchange-room:room-42:1",
    });
    const bare = toSuggestionInput("room-42", { title: "", claim: A.claim, positions: A.positions }, 0);
    expect(bare).not.toHaveProperty("targetSlug");
    expect(bare.rationale).toBe(A.positions);
  });

  it("prompt fragment names the fenced block and the three-item cap", () => {
    expect(AGENT_EXCHANGE_PROPOSALS_PROMPT).toContain("```proposals");
    expect(AGENT_EXCHANGE_PROPOSALS_PROMPT).toContain("at most 3");
    expect(AGENT_EXCHANGE_PROPOSALS_PROMPT).toContain("empty array");
  });
});
