// @vitest-environment jsdom
//
// myrmidon(1.6.6-LITELLM-WORKERS-UI): pins the worker-tab helpers and the
// acceptance points the UI owns: input validation 1..maxByMemory, the PUT body
// shape (no `auto` when the backend field is absent), the current->target
// status line, and the disabled auto-select switch when the backend has no
// field for it.

import { flushSync } from "react-dom";
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

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  function render(): QueryClient {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={client}>
          <GatewayWorkersTab companyId="company-a" />
        </QueryClientProvider>,
      );
    });
    return client;
  }

  async function settled() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function typeInto(el: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function click(el: Element) {
    flushSync(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function buttonWith(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  }

  it("renders the form from the GET state and metrics", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state());
    render();
    await settled();
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
    render();
    await settled();
    const input = container.querySelector("#myrmidon-workers-target") as HTMLInputElement;
    typeInto(input, "9");
    expect(container.textContent).toContain("memory ceiling");
    // no Apply button while the draft is invalid
    expect(buttonWith("Apply")).toBeUndefined();
  });

  it("applies through a confirm step and sends the PUT body without auto when unsupported", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state({ current: 2, target: 2 }));
    vi.mocked(litellmWorkersApi.apply).mockResolvedValue(state({ current: 4, target: 4 }));
    render();
    await settled();
    const input = container.querySelector("#myrmidon-workers-target") as HTMLInputElement;
    typeInto(input, "4");
    const apply = buttonWith("Apply");
    expect(apply).toBeTruthy();
    click(apply!);
    // confirmation step first — no PUT yet
    expect(litellmWorkersApi.apply).not.toHaveBeenCalled();
    const confirm = buttonWith("Confirm");
    expect(confirm).toBeTruthy();
    click(confirm!);
    expect(litellmWorkersApi.apply).toHaveBeenCalledWith("company-a", 4, null);
  });

  it("surfaces the 400 text from the server on a rejected apply", async () => {
    vi.mocked(litellmWorkersApi.state).mockResolvedValue(state({ current: 2, target: 2, maxByMemory: 12 }));
    vi.mocked(litellmWorkersApi.apply).mockRejectedValue(
      new ApiError("target 9 exceeds the memory limit of 6 workers", 400, { error: "no" }),
    );
    render();
    await settled();
    const input = container.querySelector("#myrmidon-workers-target") as HTMLInputElement;
    typeInto(input, "9");
    click(buttonWith("Apply")!);
    click(buttonWith("Confirm")!);
    await settled();
    expect(container.querySelector("[data-testid=myrmidon-workers-error]")?.textContent).toContain(
      "target 9 exceeds the memory limit of 6 workers",
    );
  });
});
