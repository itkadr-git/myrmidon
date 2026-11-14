// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseFlakyGateState } from "@myrmidon/shared";
import { ReleaseFlakyWorkPanel } from "./ReleaseFlakyWorkPanel";
import { releaseFlakyWorkApi } from "@/api/releaseFlakyWork";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/releaseFlakyWork", () => ({
  releaseFlakyWorkApi: {
    retryJob: vi.fn(),
    recordWaiver: vi.fn(),
    resumeGate: vi.fn(),
  },
}));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ReleaseFlakyWorkPanel (OPE-13066)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  const baseBlockedState: ReleaseFlakyGateState = {
    releaseId: "rel-1.8.0-rc1",
    gateStatus: "blocked",
    canResume: false,
    blockingReason: "Release gate blocked on unresolved flaky CI job(s): unit-test",
    jobs: [
      {
        id: "job-1",
        jobName: "unit-test",
        headSha: "abc1234",
        attempt: 1,
        status: "failed",
        failureDetail: "Timeout in suite",
      },
    ],
    waivers: [],
  };

  it("renders blocked gate state, blocking reason, and failed job", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ReleaseFlakyWorkPanel initialState={baseBlockedState} />);
    });
    await flushReact();

    const gateBadge = container.querySelector('[data-testid="gate-status-badge"]');
    expect(gateBadge?.textContent).toBe("blocked");

    const reason = container.querySelector('[data-testid="blocking-reason-callout"]');
    expect(reason?.textContent).toContain("unit-test");

    const retryBtn = container.querySelector('[data-testid="retry-job-btn-job-1"]');
    expect(retryBtn).not.toBeNull();

    const resumeBtn = container.querySelector(
      '[data-testid="resume-gate-btn"]',
    ) as HTMLButtonElement | null;
    expect(resumeBtn?.disabled).toBe(true);

    root.unmount();
  });

  it("retries failed job through the product", async () => {
    const updatedState: ReleaseFlakyGateState = {
      ...baseBlockedState,
      gateStatus: "passed",
      canResume: true,
      blockingReason: undefined,
      jobs: [
        {
          id: "job-1",
          jobName: "unit-test",
          headSha: "abc1234",
          attempt: 2,
          status: "success",
        },
      ],
    };

    vi.mocked(releaseFlakyWorkApi.retryJob).mockResolvedValueOnce(updatedState);

    const root = createRoot(container);
    await act(async () => {
      root.render(<ReleaseFlakyWorkPanel initialState={baseBlockedState} />);
    });
    await flushReact();

    const retryBtn = container.querySelector(
      '[data-testid="retry-job-btn-job-1"]',
    ) as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
    });
    await flushReact();

    expect(releaseFlakyWorkApi.retryJob).toHaveBeenCalledWith("rel-1.8.0-rc1", {
      jobId: "job-1",
      outcome: "success",
    });

    const gateBadge = container.querySelector('[data-testid="gate-status-badge"]');
    expect(gateBadge?.textContent).toBe("passed");

    root.unmount();
  });

  it("records waiver with evidence and allows resuming gate", async () => {
    const updatedWaivedState: ReleaseFlakyGateState = {
      ...baseBlockedState,
      gateStatus: "passed",
      canResume: true,
      blockingReason: undefined,
      jobs: [
        {
          id: "job-1",
          jobName: "unit-test",
          headSha: "abc1234",
          attempt: 1,
          status: "waived",
        },
      ],
      waivers: [
        {
          job: "unit-test",
          reason: "Transient network failure in test runner",
          evidence: {
            headSha: "abc1234",
            job: "unit-test",
            attempt: 1,
            url: "https://ci.example.com/runs/1",
          },
          actor: { type: "user", id: "operator-1" },
          waivedAt: new Date().toISOString(),
        },
      ],
    };

    vi.mocked(releaseFlakyWorkApi.recordWaiver).mockResolvedValueOnce(updatedWaivedState);

    const root = createRoot(container);
    await act(async () => {
      root.render(<ReleaseFlakyWorkPanel initialState={baseBlockedState} />);
    });
    await flushReact();

    const openWaiverBtn = container.querySelector(
      '[data-testid="open-waiver-btn-job-1"]',
    ) as HTMLButtonElement;
    await act(async () => {
      openWaiverBtn.click();
    });
    await flushReact();

    // Check prefilled inputs
    const headShaInput = container.querySelector(
      '[data-testid="waiver-headsha-input"]',
    ) as HTMLInputElement;
    expect(headShaInput.value).toBe("abc1234");

    const reasonInput = container.querySelector(
      '[data-testid="waiver-reason-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(reasonInput, "Transient network failure in test runner");
    });
    await flushReact();

    const submitBtn = container.querySelector(
      '[data-testid="submit-waiver-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    await flushReact();

    expect(releaseFlakyWorkApi.recordWaiver).toHaveBeenCalled();

    root.unmount();
  });
});
