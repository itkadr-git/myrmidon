// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TeamLivenessHealthCardView,
  metricLines,
  windowLabel,
} from "./TeamLivenessHealthCard";
import type { TeamLivenessMetrics } from "./teamLivenessApi";

// TEAM-LIVENESS-METRICS: the 24-hour health card. The numbers are the whole
// point of the card, so the suite reads them back from the DOM, and it checks
// the two states an operator actually meets: a first load and a failed read.

const metrics: TeamLivenessMetrics = {
  companyId: "company-a",
  windowHours: 24,
  from: "2026-10-04T12:00:00.000Z",
  to: "2026-10-05T12:00:00.000Z",
  autoResumes: 7,
  autoResumeExhaustions: 2,
  wakes: 41,
  stalledRuns: 3,
};

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

function render(props: Parameters<typeof TeamLivenessHealthCardView>[0]) {
  act(() => {
    root.render(<TeamLivenessHealthCardView {...props} />);
  });
}

function value(testId: string) {
  return container.querySelector(`[data-testid="myrmidon-team-liveness-${testId}"]`)?.textContent;
}

describe("TeamLivenessHealthCardView", () => {
  it("reads the four counters and the window back to the operator", () => {
    render({ metrics, loading: false, error: null });

    expect(value("autoResumes")).toBe("7");
    expect(value("autoResumeExhaustions")).toBe("2");
    expect(value("wakes")).toBe("41");
    expect(value("stalledRuns")).toBe("3");
    expect(container.textContent).toContain("last 24 h");
  });

  it("shows the loading line before the first read lands", () => {
    render({ metrics: null, loading: true, error: null });

    expect(container.querySelector('[data-testid="myrmidon-team-liveness-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-team-liveness-metrics"]')).toBeNull();
  });

  it("shows the failure instead of zeros when the read fails", () => {
    render({ metrics: null, loading: false, error: "Request failed: 403" });

    expect(container.querySelector('[data-testid="myrmidon-team-liveness-error"]')?.textContent).toBe(
      "Request failed: 403",
    );
    expect(container.querySelector('[data-testid="myrmidon-team-liveness-metrics"]')).toBeNull();
  });
});

describe("windowLabel", () => {
  it("reads as hours, singular for one hour", () => {
    expect(windowLabel({ ...metrics, windowHours: 24 })).toBe("last 24 h");
    expect(windowLabel({ ...metrics, windowHours: 1 })).toBe("last 1 h");
  });
});

describe("metricLines", () => {
  it("names every counter and keeps the order stable", () => {
    expect(metricLines(metrics).map((line) => line.key)).toEqual([
      "autoResumes",
      "autoResumeExhaustions",
      "wakes",
      "stalledRuns",
    ]);
  });
});