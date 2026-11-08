import { describe, expect, it } from "vitest";
import { buildRecoveryDedupeKey } from "@myrmidon/shared";
import { classifyGithubRecoveryCause } from "./classify-github.js";
import { githubRecoveryFixtures, unknownGithubSignal } from "./__fixtures__/github-signals.js";

describe("classifyGithubRecoveryCause", () => {
  it.each(githubRecoveryFixtures)("classifies observed signal from $source", (fixture) => {
    expect(classifyGithubRecoveryCause({ message: fixture.message })).toMatchObject({
      kind: fixture.kind,
      cause: fixture.cause,
      scope: "github:unspecified",
    });
  });

  it("returns null for an unknown non-GitHub signal", () => {
    expect(classifyGithubRecoveryCause({ message: unknownGithubSignal.message })).toBeNull();
  });

  it("scopes and deduplicates the same event deterministically", () => {
    const signal = {
      message: githubRecoveryFixtures[0]!.message,
      repository: "BastionPrime/ops-tools",
      pullRequest: 10,
    };
    const first = classifyGithubRecoveryCause(signal);
    const second = classifyGithubRecoveryCause({ ...signal });
    expect(first).toEqual(second);
    expect(first?.scope).toBe("bastionprime/ops-tools#10");
    expect(first?.dedupeKey).toBe(buildRecoveryDedupeKey({
      kind: first!.kind,
      scope: first!.scope,
      cause: first!.cause,
    }));
  });
});
