// @vitest-environment jsdom
//
// myrmidon(1.6.5 RUN-PRIORITY B): the wait line under a queued run's chat
// card. It renders what the server knows (metadata or the part A endpoint),
// stays silent when the server knows nothing, and never lets a failing
// position read throw into the thread.

import { act, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockGet = vi.hoisted(() => vi.fn());

// Hoisted mock: vi.mock factories run before top-level declarations, so the
// stubs live in vi.hoisted. ApiError must be a REAL class — runQueueApi checks
// `err instanceof ApiError` for the not-served degradation.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: {
      get: (path: string) => mockGet(path),
      patch: async () => ({}) as never,
    },
  };
});

import { RunQueueWaitLine } from "./RunQueueWaitLine";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockGet.mockReset();
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

async function render(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function line() {
  return container.querySelector('[data-testid="run-queue-wait-line"]')?.textContent ?? null;
}

describe("RunQueueWaitLine", () => {
  it("renders the position and the reason straight from comment metadata", async () => {
    await render(
      <RunQueueWaitLine
        runId="run-1"
        metadata={{ queuePosition: 3, queueLength: 12, waitReason: "host_cpu" }}
      />,
    );
    expect(line()).toBe("Queue position 3 of 12, waiting: the host CPU ceiling is closed");
    // The position is known: no endpoint call was needed.
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("fills a missing rank from the part A endpoint", async () => {
    mockGet.mockResolvedValueOnce({
      position: { runId: "run-1", position: 5, queueLength: 9, waitReason: "priority", queuedAt: null },
    });
    await render(<RunQueueWaitLine runId="run-1" metadata={{ waitReason: "priority" }} />);
    expect(mockGet).toHaveBeenCalledWith("/myrmidon/run-queue/position?runId=run-1");
    expect(line()).toBe("Queue position 5 of 9, waiting: higher-priority runs are ahead");
  });

  it("shows the reason alone on an old server that carries waitReason only", async () => {
    mockGet.mockResolvedValueOnce(null); // part A endpoint not deployed
    await render(<RunQueueWaitLine runId="run-2" metadata={{ waitReason: "host_memory" }} />);
    expect(line()).toBe("waiting: the host free-memory floor is closed");
  });

  it("renders nothing when neither source answers (pre-part-A world)", async () => {
    mockGet.mockResolvedValueOnce(null);
    await render(<RunQueueWaitLine runId="run-3" metadata={{ queueState: "queued" }} />);
    expect(line()).toBe(null);
  });

  it("a failing position read degrades to the card without the line", async () => {
    mockGet.mockRejectedValueOnce(new Error("network down"));
    await render(<RunQueueWaitLine runId="run-4" metadata={null} />);
    expect(line()).toBe(null);
  });

  it("no runId — no fetch, no line", async () => {
    await render(<RunQueueWaitLine runId={null} metadata={{ queuePosition: 1 }} />);
    expect(mockGet).not.toHaveBeenCalled();
    expect(line()).toBe(null);
  });
});
