// @vitest-environment jsdom
//
// myrmidon(1.6.6-LITELLM-WORKERS-UI): pins the worker-tab helpers and the
// acceptance points the UI owns: input validation 1..maxByMemory, the PUT body
// shape (no `auto` when the backend field is absent), the current->target
// status line, and the disabled auto-select switch when the backend has no
// field for it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkersPutBody,
  perWorkerCpuSeries,
  validateWorkerTarget,
  type LitellmWorkersState,
} from "./litellmWorkersApi";
import { applyStatusLine, GatewayWorkersTab } from "./GatewayWorkersTab";
import { ApiError } from "@/api/client";

vi.mock("./litellmWorkersApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./litellmWorkersApi")>();
  return {
    ...actual,
    litellmWorkersApi: {
      state: vi.fn(),
      apply: vi.fn(),
    },
  };
});

import { litellmWorkersApi } from "./litellmWorkersApi";

// React 19 only flushes concurrent work (including react-query's resolved
// promises) inside act() when this flag is set, same as the other component
// tests in this package (e.g. src/App.onboarding-launcher.test.tsx).
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const state = (over: Partial<LitellmWorkersState> = {}): LitellmWorkersState => ({
  current: 2,
  target: 2,
  maxByCpu: 8,
  maxByMemory: 4,
  metrics: { perWorkerCpu: [41, 66], medianLatencyMs: 210, queueDepth: 3 },
  ...over,
});

describe("myrmidon(1.6.6-LITELLM-WORKERS-UI) workers api helpers", () => {
  it("omits the auto field when the backend does not carry one", () => {
    expect(buildWorkersPutBody(3, null)).toEqual({ target: 3 });
    expect(buildWorkersPutBody(3, undefined)).toEqual({ target: 3 });
    expect(buildWorkersPutBody(3, true)).toEqual({ target: 3, auto: true });
    expect(buildWorkersPutBody(3, false)).toEqual({ target: 3, auto: false });
  });

  it("normalizes perWorkerCpu into one clamped series", () => {
    expect(perWorkerCpuSeries([41, 120, -5])).toEqual([41, 100, 0]);
    expect(perWorkerCpuSeries(62)).toEqual([62]);
    expect(perWorkerCpuSeries(null)).toEqual([]);
    expect(perWorkerCpuSeries(undefined)).toEqual([]);
    expect(perWorkerCpuSeries([40, "x" as unknown as number, NaN])).toEqual([40]);
  });

  it("validates the target against 1..maxByMemory", () => {
    expect(validateWorkerTarget("3", 4)).toBeNull();
    expect(validateWorkerTarget("", 4)).not.toBeNull();
    expect(validateWorkerTarget("0", 4)).not.toBeNull();
    expect(validateWorkerTarget("2.5", 4)).not.toBeNull();
    expect(validateWorkerTarget("5", 4)).toContain("4");
  });

  it("shows current -> target as the applying line and applied when equal", () => {
    expect(applyStatusLine(state({ current: 2, target: 4 }))).toContain("2 running -> 4 requested");
    expect(applyStatusLine(state({ current: 3, target: 3 }))).toContain("3 workers running");
    expect(applyStatusLine(undefined)).toBeNull();
  });
});

describe("myrmidon(1.6.6-LITELLM-WORKERS-UI) GatewayWorkersTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(litellmWorkersApi.state).mockReset();
    vi.mocked(litellmWorkersApi.apply).mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  // Renders the tab and waits for the mocked GET state to arrive, so every
  // test starts from the loaded (not "Waiting for the first metrics read…")
  // view. async act() drains the promise chain and flushes React's work.
  async function renderTab() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <GatewayWorkersTab companyId="company-a" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {});
  }

  async function typeInto(selector: string, text: string) {
    const el = container.querySelector(selector);
    if (!(el instanceof HTMLInputElement)) {
      throw new Error(`typeInto: "${selector}" did not resolve to an HTMLInputElement`);
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(el: Element) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function buttonWith(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  }

  it("renders the form from the GET state and metrics", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state());
    await renderTab();
    const text = container.textContent ?? "";
    expect(text).toContain("Worker processes");
    expect(text).toContain("Gateway metrics");
    expect(text).toContain("Auto-select");
    // backend without the `auto` field: the switch is disabled with an explanation
    expect(text).toContain("Not supported by this backend");
    expect(text).toContain("210 ms");
  });

  it("refuses to apply above maxByMemory on the client", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state({ maxByMemory: 4 }));
    await renderTab();
    await typeInto("#myrmidon-workers-target", "9");
    expect(container.textContent).toContain("memory ceiling");
    // no Apply button while the draft is invalid
    expect(buttonWith("Apply")).toBeUndefined();
  });

  it("applies through a confirm step and sends the PUT body without auto when unsupported", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state({ current: 2, target: 2 }));
    vi.mocked(litellmWorkersApi.apply).mockResolvedValue(state({ current: 4, target: 4 }));
    await renderTab();
    await typeInto("#myrmidon-workers-target", "4");
    const apply = buttonWith("Apply");
    expect(apply).toBeTruthy();
    await click(apply!);
    // confirmation step first — no PUT yet
    expect(litellmWorkersApi.apply).not.toHaveBeenCalled();
    const confirm = buttonWith("Confirm");
    expect(confirm).toBeTruthy();
    await click(confirm!);
    expect(litellmWorkersApi.apply).toHaveBeenCalledWith("company-a", 4, null);
    // let the resolved PUT settle inside act so onSuccess cache-set re-renders
    await act(async () => {});
  });

  it("surfaces the 400 text from the server on a rejected apply", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state({ current: 2, target: 2, maxByMemory: 12 }));
    vi.mocked(litellmWorkersApi.apply).mockRejectedValue(
      new ApiError("target 9 exceeds the memory limit of 6 workers", 400, { error: "no" }),
    );
    await renderTab();
    await typeInto("#myrmidon-workers-target", "9");
    await click(buttonWith("Apply")!);
    await click(buttonWith("Confirm")!);
    // let the rejected PUT settle inside act so the error renders
    await act(async () => {});
    expect(container.querySelector("[data-testid=myrmidon-workers-error]")?.textContent).toContain(
      "target 9 exceeds the memory limit of 6 workers",
    );
  });
});
