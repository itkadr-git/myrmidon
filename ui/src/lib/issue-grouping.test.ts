import { describe, expect, it } from "vitest";
import { groupIssuesByTopic } from "./issue-grouping";

describe("groupIssuesByTopic", () => {
  const labels = [
    { id: "lbl-backend", name: "Backend" },
    { id: "lbl-ui", name: "UI" },
    { id: "lbl-infra", name: "Infra" },
  ];

  it("groups issues by their labels correctly", () => {
    const issues = [
      { id: "1", title: "Refactor API", labelIds: ["lbl-backend"] },
      { id: "2", title: "Theme switcher", labelIds: ["lbl-ui"] },
      { id: "3", title: "Fullstack task", labelIds: ["lbl-backend", "lbl-ui"] },
      { id: "4", title: "No label task", labelIds: [] },
    ];

    const result = groupIssuesByTopic(issues, labels, "Без темы");

    // Topics should be sorted alphabetically: Backend, UI, then "Без темы"
    expect(result.map((r) => r.label)).toEqual(["Backend", "UI", "Без темы"]);

    // "Backend" group should have issues 1 and 3
    const backendGroup = result.find((r) => r.label === "Backend");
    expect(backendGroup?.items.map((i) => i.id)).toEqual(["1", "3"]);

    // "UI" group should have issues 2 and 3 (multi-topic membership)
    const uiGroup = result.find((r) => r.label === "UI");
    expect(uiGroup?.items.map((i) => i.id)).toEqual(["2", "3"]);

    // "Без темы" group should have issue 4
    const noTopicGroup = result.find((r) => r.label === "Без темы");
    expect(noTopicGroup?.items.map((i) => i.id)).toEqual(["4"]);
  });

  it("supports [Topic] title prefix when issue has no labelIds", () => {
    const issues = [
      { id: "1", title: "[Analytics] Track ideas metrics", labelIds: [] },
      { id: "2", title: "[Analytics] Export CSV report", labelIds: [] },
      { id: "3", title: "Plain title idea", labelIds: [] },
    ];

    const result = groupIssuesByTopic(issues, labels, "Без темы");

    expect(result.map((r) => r.label)).toEqual(["Analytics", "Без темы"]);
    const analyticsGroup = result.find((r) => r.label === "Analytics");
    expect(analyticsGroup?.items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(analyticsGroup?.key).toBe("title_topic:analytics");

    const noTopicGroup = result.find((r) => r.label === "Без темы");
    expect(noTopicGroup?.items.map((i) => i.id)).toEqual(["3"]);
  });

  it("handles empty issues list gracefully", () => {
    const result = groupIssuesByTopic([], labels, "Без темы");
    expect(result).toEqual([]);
  });
});
