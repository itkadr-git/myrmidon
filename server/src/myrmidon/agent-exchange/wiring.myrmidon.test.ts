// server/src/myrmidon/agent-exchange/wiring.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE, OPE-12623): unit tests for modelCallSignal
// and createAgentExchangeModelPort().call signal forwarding.
//
// Acceptance criteria of OPE-12623:
//  1. Pure modelCallSignal:
//     - timeout only (fake timers)
//     - timeout only (real timer)
//     - external signal only (aborts immediately when signal aborts, reason preserved)
//     - both signal and timeout: first to fire wins, reason preserved
//     - already aborted signal aborts immediately
//  2. createAgentExchangeModelPort().call:
//     - in-flight fetch is aborted immediately when input.signal fires
//     - already aborted input.signal rejects immediately without network or db call
//     - call without input.signal aborts on timeoutMs with TimeoutError
//     - stop-valve error is preserved directly (never converted to provider_http_*)
//     - successful call returns parsed content and token counts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { AgentExchangeError } from "@myrmidon/shared";
import { createAgentExchangeModelPort, modelCallSignal } from "./wiring.js";
import type { AgentExchangeModelCallInput } from "./engine.js";

const { secretServiceMock } = vi.hoisted(() => ({
  secretServiceMock: {
    getByName: vi.fn(),
    resolveSecretValue: vi.fn(),
  },
}));

vi.mock("../../services/index.js", () => ({
  secretService: vi.fn(() => secretServiceMock),
  documentService: vi.fn(),
}));

describe("modelCallSignal (OPE-12623)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("aborts when timeout expires (fake timers)", () => {
    vi.useFakeTimers();
    const timeoutController = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      setTimeout(
        () => timeoutController.abort(new DOMException("The operation timed out.", "TimeoutError")),
        ms,
      );
      return timeoutController.signal;
    });

    const signal = modelCallSignal(5_000);
    expect(spy).toHaveBeenCalledWith(5_000);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(4_999);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error)?.name).toBe("TimeoutError");
  });

  it("aborts when timeout expires (real timer)", async () => {
    const signal = modelCallSignal(20);
    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error)?.name).toBe("TimeoutError");
  });

  it("aborts when external signal fires before timeout", () => {
    const controller = new AbortController();
    const signal = modelCallSignal(60_000, controller.signal);
    expect(signal.aborted).toBe(false);

    const stopReason = new AgentExchangeError("room_closed", "room closed by user");
    controller.abort(stopReason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(stopReason);
  });

  it("both: external signal aborts before timeout and reason is preserved", () => {
    vi.useFakeTimers();
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      setTimeout(
        () => timeoutController.abort(new DOMException("The operation timed out.", "TimeoutError")),
        ms,
      );
      return timeoutController.signal;
    });

    const controller = new AbortController();
    const signal = modelCallSignal(10_000, controller.signal);

    vi.advanceTimersByTime(2_000);
    expect(signal.aborted).toBe(false);

    const stopReason = new Error("stop_valve_engaged");
    controller.abort(stopReason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(stopReason);

    // Advancing past the original timeout does not change the already recorded reason
    vi.advanceTimersByTime(10_000);
    expect(signal.reason).toBe(stopReason);
  });

  it("both: timeout wins when external signal does not fire in time", () => {
    vi.useFakeTimers();
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      setTimeout(
        () => timeoutController.abort(new DOMException("The operation timed out.", "TimeoutError")),
        ms,
      );
      return timeoutController.signal;
    });

    const controller = new AbortController();
    const signal = modelCallSignal(3_000, controller.signal);

    vi.advanceTimersByTime(3_000);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error)?.name).toBe("TimeoutError");

    // Later abortion does not override the timeout reason
    controller.abort(new Error("late_stop"));
    expect((signal.reason as Error)?.name).toBe("TimeoutError");
  });

  it("aborts immediately if external signal is already aborted", () => {
    const controller = new AbortController();
    const stopReason = new AgentExchangeError("room_closed", "already closed");
    controller.abort(stopReason);

    const signal = modelCallSignal(60_000, controller.signal);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(stopReason);
  });
});

describe("createAgentExchangeModelPort().call (OPE-12623)", () => {
  const companyId = "cmp-1";
  const defaultProvider = {
    id: "prov-1",
    type: "openai",
    baseUrl: "https://api.openai.com",
    credentialSecretName: "test-secret-key",
  };

  function createMockDb(providerRow: unknown = defaultProvider): Db {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(providerRow ? [providerRow] : [])),
        })),
      })),
    } as unknown as Db;
  }

  const sampleInput: AgentExchangeModelCallInput = {
    providerId: "prov-1",
    model: "gpt-4o",
    messages: [{ role: "user", content: "Tell me a joke" }],
    timeoutMs: 90_000,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    secretServiceMock.getByName.mockResolvedValue({ id: "sec-1", name: "test-secret-key" });
    secretServiceMock.resolveSecretValue.mockResolvedValue("sk-valid-token");
  });

  it("aborts in-flight fetch when input.signal is aborted", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) return;
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const db = createMockDb();
    const port = createAgentExchangeModelPort(db, companyId);
    const controller = new AbortController();
    const stopReason = new AgentExchangeError("room_closed", "the room was closed while the round was running");

    const callPromise = port.call({
      ...sampleInput,
      signal: controller.signal,
    });

    // Wait until fetch receives the request
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    // Stop valve triggers mid-flight
    controller.abort(stopReason);

    await expect(callPromise).rejects.toBe(stopReason);
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe(stopReason);
  });

  it("rejects immediately without hitting DB or fetch if input.signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const db = createMockDb();
    const port = createAgentExchangeModelPort(db, companyId);
    const controller = new AbortController();
    const stopReason = new AgentExchangeError("room_closed", "already aborted before call");
    controller.abort(stopReason);

    await expect(
      port.call({
        ...sampleInput,
        signal: controller.signal,
      }),
    ).rejects.toBe(stopReason);

    expect(db.select).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects without calling fetch if input.signal aborts during db/secret resolution", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const stopReason = new AgentExchangeError("room_closed", "aborted during secret resolve");

    secretServiceMock.resolveSecretValue.mockImplementation(async () => {
      // Stop valve pulls while secret is being looked up
      controller.abort(stopReason);
      return "sk-valid-token";
    });

    const db = createMockDb();
    const port = createAgentExchangeModelPort(db, companyId);

    await expect(
      port.call({
        ...sampleInput,
        signal: controller.signal,
      }),
    ).rejects.toBe(stopReason);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts on timeout when no input.signal is supplied", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) return;
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("The operation timed out.", "TimeoutError")),
            { once: true },
          );
        });
      }),
    );

    const db = createMockDb();
    const port = createAgentExchangeModelPort(db, companyId);

    const callPromise = port.call({
      ...sampleInput,
      timeoutMs: 25,
      signal: undefined,
    });

    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    const err = await callPromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    expect(capturedSignal?.aborted).toBe(true);
    expect((capturedSignal?.reason as Error)?.name).toBe("TimeoutError");
  });

  it("returns parsed completion and token counts when call succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Here is your response" } }],
          usage: { prompt_tokens: 15, completion_tokens: 8 },
        }),
      })),
    );

    const db = createMockDb();
    const port = createAgentExchangeModelPort(db, companyId);

    const result = await port.call({
      ...sampleInput,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      content: "Here is your response",
      promptTokens: 15,
      completionTokens: 8,
    });
  });
});
