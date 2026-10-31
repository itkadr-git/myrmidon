import { describe, expect, it } from "vitest";
import { isAdapterEnvironmentFailure } from "./execution-recovery-resolution.js";

const run = (overrides: Record<string, unknown> = {}) =>
  ({ errorCode: null, error: null, resultJson: null, ...overrides }) as Parameters<
    typeof isAdapterEnvironmentFailure
  >[0];

describe("adapter environment failure classification", () => {
  it.each(["antigravity_not_licensed", "antigravity_pool_unavailable"])(
    "recognizes structured adapter error %s",
    (errorCode) => {
      expect(isAdapterEnvironmentFailure(run({ errorCode }))).toBe(true);
    },
  );

  it("recognizes the Russian live license diagnostic without matching unrelated log excerpts", () => {
    expect(isAdapterEnvironmentFailure(run({ error: "Модуль antigravity не лицензирован на этом сервере" }))).toBe(true);
    expect(isAdapterEnvironmentFailure(run({ stderrExcerpt: "The open source LICENSE file is mentioned in docs" }))).toBe(false);
  });

  it("recognizes normalized adapter error families", () => {
    expect(isAdapterEnvironmentFailure(run({ resultJson: { errorFamily: "adapter_engine_unavailable" } }))).toBe(true);
    expect(isAdapterEnvironmentFailure(run({ resultJson: { errorFamily: "configuration_incomplete" } }))).toBe(true);
  });
});