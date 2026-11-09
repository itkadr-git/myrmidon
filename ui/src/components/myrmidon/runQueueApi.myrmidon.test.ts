// myrmidon(1.6.5 RUN-PRIORITY B): the run-queue client contract — the position
// endpoint answers with null (never a throw, never a made-up number) while
// part A is not deployed, the line formatter renders "position N of M,
// waiting: <reason>" from either source, and the metadata parse accepts only
// the shape the server carries.
import { describe, it, expect, vi } from "vitest";

const { mockGet, mockPatch } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPatch: vi.fn() }));

// Hoisted mock: vi.mock factories run before top-level declarations, so the
// stubs live in vi.hoisted. ApiError stays REAL (spread of importOriginal) —
// runQueueApi checks `err instanceof ApiError` for the not-served degradation.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: {
      get: (path: string) => mockGet(path),
      patch: (path: string, body: unknown) => mockPatch(path, body),
    },
  };
});
import { ApiError } from "@/api/client";

import {
  describeRunQueuePosition,
  isRunQueueWaitReason,
  runQueueApi,
} from "./runQueueApi";
import {
  mergeRunQueuePosition,
  runQueuePositionFromMetadata,
} from "./RunQueueWaitLine";

function enT(key: string, options?: Record<string, unknown>) {
  // A tiny catalog stand-in: the real strings live in the fork catalogs and
  // the parity test checks them; this formatter test needs the shape.
  const catalog: Record<string, string> = {
    "runQueue.position.of": "Queue position {{position}} of {{total}}",
    "runQueue.position.only": "Queue position {{position}}",
    "runQueue.waiting": "waiting: {{reason}}",
    "runQueue.waitReason.host_cpu": "the host CPU ceiling is closed",
    "runQueue.waitReason.host_memory": "the host free-memory floor is closed",
    "runQueue.waitReason.priority": "higher-priority runs are ahead",
  };
  let text = catalog[key] ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), String(value));
  }
  return text;
}

describe("runQueueApi.position — degrades before part A is deployed", () => {
  it("returns null on 404/405 (endpoint not served yet)", async () => {
    mockGet.mockRejectedValueOnce(new ApiError("not found", 404, undefined));
    await expect(runQueueApi.position("run-1")).resolves.toBeNull();
    mockGet.mockRejectedValueOnce(new ApiError("method not allowed", 405, undefined));
    await expect(runQueueApi.position("run-1")).resolves.toBeNull();
  });

  it("rethrows a real failure (a broken server is not 'no data')", async () => {
    mockGet.mockRejectedValueOnce(new ApiError("boom", 500, undefined));
    await expect(runQueueApi.position("run-1")).rejects.toBeInstanceOf(ApiError);
  });

  it("reads the position envelope", async () => {
    mockGet.mockResolvedValueOnce({
      position: { runId: "run-1", position: 3, queueLength: 12, waitReason: "host_cpu", queuedAt: null, waitDetail: null },
    });
    await expect(runQueueApi.position("run-1")).resolves.toMatchObject({ position: 3, queueLength: 12, waitReason: "host_cpu" });
    expect(mockGet).toHaveBeenLastCalledWith("/myrmidon/run-queue/position?runId=run-1");
  });
});

describe("runQueueApi.priority — same degradation, settings round-trip", () => {
  it("null on 404; PATCH goes to the settings endpoint", async () => {
    mockGet.mockRejectedValueOnce(new ApiError("not found", 404, undefined));
    await expect(runQueueApi.priority()).resolves.toBeNull();
    mockPatch.mockResolvedValueOnce({ settings: {}, sources: {} });
    await runQueueApi.updatePriority({ agingStepPerHour: 1 });
    expect(mockPatch).toHaveBeenCalledWith("/myrmidon/run-queue/priority", { agingStepPerHour: 1 });
  });
});

describe("wait reason vocabulary", () => {
  it("accepts the admission reasons and the part A 'priority' reason", () => {
    expect(isRunQueueWaitReason("host_cpu")).toBe(true);
    expect(isRunQueueWaitReason("host_memory")).toBe(true);
    expect(isRunQueueWaitReason("priority")).toBe(true);
    expect(isRunQueueWaitReason("made-up-reason")).toBe(false);
  });
});

describe("runQueuePositionFromMetadata", () => {
  it("reads the queue fields the server carries on the comment", () => {
    const pos = runQueuePositionFromMetadata("run-7", {
      queuePosition: 2, queueLength: 9, waitReason: "priority",
    });
    expect(pos).toMatchObject({ runId: "run-7", position: 2, queueLength: 9, waitReason: "priority" });
  });

  it("ignores foreign values and answers null when the comment carries nothing", () => {
    expect(runQueuePositionFromMetadata("run-7", {})).toBeNull();
    expect(runQueuePositionFromMetadata(null, { queuePosition: 1 })).toBeNull();
    expect(runQueuePositionFromMetadata("run-7", { queuePosition: "two" })).toBeNull();
  });

  it("myrmidon(1.6.7 RUN-LIMITS): reads the concurrency hold's waitDetail numbers", () => {
    const pos = runQueuePositionFromMetadata("run-8", {
      waitReason: "agent_concurrency",
      waitDetail: { limit: 2, limitSource: "gateway", running: 2 },
    });
    expect(pos).toMatchObject({
      runId: "run-8",
      waitReason: "agent_concurrency",
      waitDetail: { limit: 2, limitSource: "gateway", running: 2 },
    });
  });

  it("myrmidon(1.6.7 RUN-LIMITS): a foreign waitDetail shape reads as null fields, not a crash", () => {
    const pos = runQueuePositionFromMetadata("run-9", {
      waitReason: "agent_concurrency",
      waitDetail: "full",
    });
    expect(pos?.waitDetail).toMatchObject({ limit: null, limitSource: null, running: null });
    expect(runQueuePositionFromMetadata("run-10", { waitDetail: { limit: 3 } })).toMatchObject({
      waitDetail: { limit: 3, limitSource: null, running: null },
    });
  });
});

describe("describeRunQueuePosition — 'position N of M, waiting: <reason>'", () => {
  const catalog = {
    "runQueue.waiting": "waiting: {{reason}}",
    "runQueue.waitReason.agent_concurrency": "the agent's own concurrency limit is full",
    "runQueue.waitReason.priority": "higher-priority runs are ahead",
    "runQueue.waitDetailLimit": "limit {{limit}}{{source}}",
    "runQueue.limitSource.gateway": " (gateway)",
    "runQueue.limitSource.memory": " (memory)",
    "runQueue.limitSource.board": " (board)",
  };
  const t = (key: string, options?: Record<string, unknown>) => {
    let text = (catalog as Record<string, string>)[key] ?? key;
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), String(value));
    }
    return text;
  };

  it("renders both halves when both are known", () => {
    expect(describeRunQueuePosition(
      { runId: "r", position: 3, queueLength: 12, waitReason: "host_cpu", queuedAt: null, waitDetail: null },
      enT,
    )).toBe("Queue position 3 of 12, waiting: the host CPU ceiling is closed");
  });

  it("renders the reason alone when the rank is unknown (pre-part-A host_cpu gate)", () => {
    expect(describeRunQueuePosition(
      { runId: "r", position: null, queueLength: null, waitReason: "host_memory", queuedAt: null, waitDetail: null },
      enT,
    )).toBe("waiting: the host free-memory floor is closed");
  });

  it("keeps an unknown reason visible as its raw token rather than dropping it", () => {
    expect(describeRunQueuePosition(
      { runId: "r", position: 1, queueLength: null, waitReason: "quantum_gate", queuedAt: null, waitDetail: null },
      enT,
    )).toBe("Queue position 1, waiting: quantum_gate");
  });

  it("shows nothing without data — never a made-up position", () => {
    expect(describeRunQueuePosition(null, enT)).toBeNull();
    expect(describeRunQueuePosition(
      { runId: "r", position: null, queueLength: null, waitReason: null, queuedAt: null, waitDetail: null },
      enT,
    )).toBeNull();
  });

  it("the fallback (no catalog access) still renders English text, not keys", () => {
    const line = describeRunQueuePosition(
      { runId: "r", position: 4, queueLength: 8, waitReason: "priority", queuedAt: null, waitDetail: null },
    );
    expect(line).toBe("Queue position 4 of 8, waiting: higher-priority runs are ahead");
  });

  it("myrmidon(1.6.7 RUN-LIMITS): an agent_concurrency hold names its limit and the binding ceiling", () => {
    expect(describeRunQueuePosition(
      {
        runId: "r", position: null, queueLength: null,
        waitReason: "agent_concurrency", queuedAt: null,
        waitDetail: { limit: 2, limitSource: "gateway", running: 2 },
      },
      t,
    )).toBe("waiting: the agent's own concurrency limit is full — limit 2 (gateway)");
    expect(describeRunQueuePosition(
      {
        runId: "r", position: null, queueLength: null,
        waitReason: "agent_concurrency", queuedAt: null,
        waitDetail: { limit: 1, limitSource: "memory", running: 1 },
      },
      t,
    )).toBe("waiting: the agent's own concurrency limit is full — limit 1 (memory)");
  });

  it("myrmidon(1.6.7 RUN-LIMITS): without a limit number the hold names the running count", () => {
    expect(describeRunQueuePosition(
      {
        runId: "r", position: null, queueLength: null,
        waitReason: "agent_concurrency", queuedAt: null,
        waitDetail: { limit: null, limitSource: null, running: 3 },
      },
      t,
    )).toBe("waiting: the agent's own concurrency limit is full — 3 running");
  });

  it("myrmidon(1.6.7 RUN-LIMITS): other reasons and missing detail keep the plain line", () => {
    expect(describeRunQueuePosition(
      {
        runId: "r", position: null, queueLength: null,
        waitReason: "agent_concurrency", queuedAt: null, waitDetail: null,
      },
      t,
    )).toBe("waiting: the agent's own concurrency limit is full");
    expect(describeRunQueuePosition(
      {
        runId: "r", position: null, queueLength: null,
        waitReason: "priority", queuedAt: null,
        waitDetail: { limit: 5, limitSource: "board", running: 5 },
      },
      t,
    )).toBe("waiting: higher-priority runs are ahead");
  });
});

describe("mergeRunQueuePosition", () => {
  it("metadata wins per field; the endpoint fills the gaps", () => {
    const merged = mergeRunQueuePosition(
      { runId: "r", position: null, queueLength: null, waitReason: "host_cpu", queuedAt: null, waitDetail: null },
      { runId: "r", position: 5, queueLength: 10, waitReason: "priority", queuedAt: "2026-10-06T00:00:00Z", waitDetail: null },
    );
    expect(merged).toMatchObject({ position: 5, queueLength: 10, waitReason: "host_cpu" });
  });

  it("either source alone passes through; none answers null", () => {
    const one = { runId: "r", position: 2, queueLength: null, waitReason: null, queuedAt: null, waitDetail: null };
    expect(mergeRunQueuePosition(one, null)).toBe(one);
    expect(mergeRunQueuePosition(null, one)).toBe(one);
    expect(mergeRunQueuePosition(null, null)).toBeNull();
  });
});
