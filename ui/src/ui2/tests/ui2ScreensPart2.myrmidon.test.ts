// ui/src/ui2/tests/ui2ScreensPart2.myrmidon.test.ts
import { describe, expect, it } from \"vitest\";
import { UI2_ROUTE_TABLE, isUi2RouteElementAPlaceholder } from \"../routes\";

describe(\"myrmidon(OPE-3918) UI-2.0 screens part 2 coverage\", () => {
  it(\"includes Server Fleet, Budgets, Guardrails, Channels/Access, and Commander screens\", () => {
    const keys = new Set(UI2_ROUTE_TABLE.map((e) => e.key));
    expect(keys.has(\"fleet\")).toBe(true);
    expect(keys.has(\"settings-runs-queue\")).toBe(true);
    expect(keys.has(\"settings-system\")).toBe(true);
    expect(keys.has(\"settings-language\")).toBe(true);
    expect(keys.has(\"commander\")).toBe(true);
    expect(keys.has(\"knowledge\")).toBe(true);
    expect(keys.has(\"decisions\")).toBe(true);
    expect(keys.has(\"costs\")).toBe(true);
    expect(keys.has(\"agent-overview\")).toBe(true);
    expect(keys.has(\"agents-fleet\")).toBe(true);
    expect(keys.has(\"more\")).toBe(true);
  });

  it(\"ensures none of the part 2 screens are placeholders\", () => {
    for (const entry of UI2_ROUTE_TABLE) {
      expect(isUi2RouteElementAPlaceholder(entry.element), `entry ${entry.key}`).toBe(false);
    }
  });
});
