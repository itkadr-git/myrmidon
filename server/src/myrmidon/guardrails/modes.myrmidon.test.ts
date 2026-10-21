import { describe, expect, it } from "vitest";
import { resolveGuardrailMode } from "./modes.js";

describe("guardrail mode inheritance", () => {
  it("resolves agent, caste, company, then flag-only", () => {
    const base = { rule: "secrets_output" as const };
    expect(resolveGuardrailMode(base.rule, [])).toMatchObject({ mode: "flag_only", source: "default" });
    expect(resolveGuardrailMode(base.rule, [{ ...base, level: "company", targetId: "c", mode: "block" }])).toMatchObject({ mode: "block", source: "company" });
    expect(resolveGuardrailMode(base.rule, [
      { ...base, level: "company", targetId: "c", mode: "block" },
      { ...base, level: "caste", targetId: "x", mode: "mask" },
      { ...base, level: "agent", targetId: "a", mode: "flag_only" },
    ])).toMatchObject({ mode: "flag_only", source: "agent" });
  });
});
