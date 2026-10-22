// @vitest-environment jsdom
// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the same-family badge is rendered on the
// reference-task results screen — the acceptance criterion the 05.10 review
// found unmet ("the badge is imported by nothing but its own test").
//
// View tier, no network: the pure view is rendered with fixture runs and the
// badge must appear on exactly the tasks with sameFamily === true.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReferenceTaskEvalsView } from "./ReferenceTaskEvalsPanel";
import type { EvalRunView } from "./evalsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function run(overrides: Partial<EvalRunView> = {}): EvalRunView {
  return {
    id: "run-1",
    companyId: "company-1",
    role: "engineer",
    subject: "engineer",
    kind: "first",
    status: "succeeded",
    model: "qwen-plus-free",
    verdict: null,
    verdictReason: null,
    startedAt: "2026-10-06T10:00:00.000Z",
    finishedAt: "2026-10-06T10:01:00.000Z",
    scores: {
      tasks: [
        {
          taskSlug: "t-same-family",
          criteria: { correctness: 3 },
          sameFamily: true,
          rawScore: 3,
          weight: 1,
          maxScore: 4,
        },
        {
          taskSlug: "t-other-family",
          criteria: { correctness: 4 },
          sameFamily: false,
          rawScore: 4,
          weight: 1,
          maxScore: 4,
        },
      ],
      totalScore: 7,
      maxScore: 8,
      scorePercent: 87.5,
      taskCount: 2,
      codeTaskCount: 0,
    },
    ...overrides,
  };
}

function render(runs: EvalRunView[]) {
  act(() =>
    root.render(
      <ReferenceTaskEvalsView
        runs={runs}
        selectedRunId={runs[0]?.id ?? null}
        onSelectRun={() => undefined}
        isLoading={false}
        errorMessage={null}
        emptyMessage="no runs"
        noRunSelectedMessage="no run selected"
      />,
    ),
  );
}

function rowFor(taskSlug: string): Element | undefined {
  return Array.from(container.querySelectorAll('[data-testid="reference-task-result"]')).find((row) =>
    row.textContent?.includes(taskSlug),
  );
}

describe("myrmidon(1.6.5 EVALS-JUDGE-FAMILY) reference-task results screen", () => {
  it("shows the same-family badge on a result with sameFamily and nowhere else", () => {
    render([run()]);

    const sameFamilyRow = rowFor("t-same-family");
    const otherRow = rowFor("t-other-family");

    expect(sameFamilyRow).toBeDefined();
    expect(otherRow).toBeDefined();
    expect(sameFamilyRow?.querySelector('[data-testid="same-family-badge"]')).not.toBeNull();
    expect(otherRow?.querySelector('[data-testid="same-family-badge"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="same-family-badge"]')).toHaveLength(1);
  });

  it("renders the run selector and the run's score summary", () => {
    render([run()]);

    expect(container.querySelector('[data-testid="reference-task-evals-run"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="reference-task-evals-score"]')?.textContent).toContain("87.5%");
    expect(container.querySelector('[data-testid="reference-task-evals-judge"]')?.textContent).toContain("qwen-plus-free");
  });

  it("shows no badge when the run scored no task from the same family", () => {
    const other = run({
      id: "run-2",
      scores: { ...run().scores!, tasks: [{ ...run().scores!.tasks[1]!, sameFamily: false }] },
    });
    render([other]);

    expect(container.querySelectorAll('[data-testid="reference-task-result"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="same-family-badge"]')).toHaveLength(0);
  });

  it("explains the empty state instead of rendering an empty table", () => {
    render([]);

    expect(container.querySelector('[data-testid="reference-task-evals-empty"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="reference-task-result"]')).toHaveLength(0);
  });
});