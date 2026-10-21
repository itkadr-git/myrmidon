// myrmidon(UI2): route and source guards for the Commander screen.
import { describe, expect, it } from "vitest";
import { UI2_ROUTE_TABLE } from "../routes";

describe("myrmidon(UI2) commander", () => {
  it("registers the company-prefixed route separately from chat", () => {
    const routes = new Map(UI2_ROUTE_TABLE.map((entry) => [entry.key, entry]));
    expect(routes.get("commander")?.path).toBe("commander");
    expect(routes.get("commander")?.legacyPath).toBe("/dashboard");
    expect(routes.get("commander-chat")?.path).toBe("commander-chat");
  });

  it("keeps the Commander implementation under its dedicated screen module", () => {
    expect(UI2_ROUTE_TABLE.find((entry) => entry.key === "commander")?.element).toBeTruthy();
  });
});
