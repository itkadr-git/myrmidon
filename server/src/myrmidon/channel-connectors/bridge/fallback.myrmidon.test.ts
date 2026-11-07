// myrmidon(1.6.6 CH-CONNECTOR-G): the fallback chain of the bridge seam.
//
// Design OPE-6985: the seam chooses the implementation (the connector's symbol
// once the flag is on), and the chain chooses what happens when that
// implementation does not answer. The cases this file pins down:
//
//  * the flag is off — the legacy module itself is handed over and the adapter
//    is never called (the default behaviour, byte for byte as before);
//  * the flag is on and the adapter answers — its value is served and the
//    legacy symbol does not run (no double delivery);
//  * the flag is on and the adapter throws, rejects or runs out of time — one
//    warn line, one counter sample (`adapter_fallback_total{reason}`) and the
//    legacy symbol answers exactly once.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_BRIDGE_FALLBACK_REASONS,
  readChannelBridgeFallbackSample,
  resetChannelBridgeFallbackCounters,
  resolveChannelBridgeFallbackSource,
} from "./fallback-counters.js";
import {
  CHANNEL_BRIDGE_FALLBACK_TIMEOUT_ENV,
  DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS,
  channelBridgeFallbackTimeoutMs,
} from "./fallback.js";
import { CHANNEL_BRIDGE_ADAPTER_ENV } from "./flag.js";
import {
  channelBridgeTheme,
  resetChannelBridgeThemes,
  serveChannelBridgeTheme,
} from "./themes.js";

const ENV = CHANNEL_BRIDGE_ADAPTER_ENV;
const TIMEOUT_ENV = CHANNEL_BRIDGE_FALLBACK_TIMEOUT_ENV;
/** One theme key of the seam; every case here serves it with its own symbols. */
const KEY = "agent-chat-bridge/links";

/** The legacy side of a theme: two symbols, one of them served by the connector. */
function legacyTheme() {
  return {
    resolveTurnLink: (id: string) => `direct:${id}`,
    otherSymbol: (id: string) => `direct-only:${id}`,
  };
}

/** The counter family as the exposition would read it. */
function samples() {
  return CHANNEL_BRIDGE_FALLBACK_REASONS.map((reason) => ({ reason, count: 0 }));
}

function samplesWith(reason: string, count: number) {
  return samples().map((row) => (row.reason === reason ? { reason: row.reason, count } : row));
}

afterEach(() => {
  resetChannelBridgeThemes();
  resetChannelBridgeFallbackCounters();
  delete process.env[ENV];
  delete process.env[TIMEOUT_ENV];
  vi.restoreAllMocks();
});

describe("bridge fallback: the flag is off", () => {
  it("hands the legacy module over and never calls the adapter", () => {
    const adapter = vi.fn((id: string) => `adapter:${id}`);
    serveChannelBridgeTheme(KEY, { resolveTurnLink: adapter });
    const legacy = legacyTheme();

    const theme = channelBridgeTheme(KEY, legacy);

    // The same object, not a copy: the default path stays byte for byte as it is.
    expect(theme).toBe(legacy);
    expect(theme.resolveTurnLink("x")).toBe("direct:x");
    expect(theme.otherSymbol("x")).toBe("direct-only:x");
    expect(adapter).not.toHaveBeenCalled();
    expect(readChannelBridgeFallbackSample()).toEqual(samples());
  });
});
describe("bridge fallback: the adapter answers", () => {
  it("serves the adapter value and keeps the direct symbol out of it", () => {
    process.env[ENV] = "on";
    const direct = vi.fn((id: string) => `direct:${id}`);
    const legacy = {
      resolveTurnLink: direct,
      otherSymbol: (id: string) => `direct-only:${id}`,
    };
    serveChannelBridgeTheme(KEY, { resolveTurnLink: (id: string) => `adapter:${id}` });

    const theme = channelBridgeTheme(KEY, legacy);

    expect(theme.resolveTurnLink("x")).toBe("adapter:x");
    expect(direct).not.toHaveBeenCalled();
    // A symbol the connector does not serve is the legacy one, untouched.
    expect(theme.otherSymbol("x")).toBe("direct-only:x");
    expect(readChannelBridgeFallbackSample()).toEqual(samples());
  });

  it("serves the adapter value when the adapter is asynchronous", async () => {
    process.env[ENV] = "on";
    const direct = vi.fn(async (id: string) => `direct:${id}`);
    serveChannelBridgeTheme(KEY, { resolveTurnLink: async (id: string) => `adapter:${id}` });
    const theme = channelBridgeTheme(KEY, { resolveTurnLink: direct });

    await expect(theme.resolveTurnLink("x")).resolves.toBe("adapter:x");
    expect(direct).not.toHaveBeenCalled();
    expect(readChannelBridgeFallbackSample()).toEqual(samples());
  });
});

describe("bridge fallback: the adapter falls", () => {
  it("logs and counts one error, then answers from the direct symbol exactly once", () => {
    process.env[ENV] = "on";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const direct = vi.fn((id: string) => `direct:${id}`);
    serveChannelBridgeTheme(KEY, {
      resolveTurnLink: () => {
        throw new Error("adapter broke");
      },
    });
    const theme = channelBridgeTheme(KEY, { resolveTurnLink: direct });

    expect(theme.resolveTurnLink("x")).toBe("direct:x");

    // Exactly one delivery: the direct symbol answered, and only it ran.
    expect(direct).toHaveBeenCalledTimes(1);
    expect(readChannelBridgeFallbackSample()).toEqual(samplesWith("error", 1));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("theme=agent-chat-bridge/links");
    expect(line).toContain("symbol=resolveTurnLink");
    expect(line).toContain("reason=error");
  });

  it("counts one error and answers the direct value when the adapter rejects", async () => {
    process.env[ENV] = "on";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const direct = vi.fn(async (id: string) => `direct:${id}`);
    serveChannelBridgeTheme(KEY, {
      resolveTurnLink: () => Promise.reject(new Error("adapter rejected")),
    });
    const theme = channelBridgeTheme(KEY, { resolveTurnLink: direct });

    await expect(theme.resolveTurnLink("x")).resolves.toBe("direct:x");

    expect(direct).toHaveBeenCalledTimes(1);
    expect(readChannelBridgeFallbackSample()).toEqual(samplesWith("error", 1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("reason=error");
  });

  it("counts one timeout and answers the direct value when the adapter runs out of time", async () => {
    process.env[ENV] = "on";
    process.env[TIMEOUT_ENV] = "20";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const direct = vi.fn(async (id: string) => `direct:${id}`);
    serveChannelBridgeTheme(KEY, {
      resolveTurnLink: () => new Promise<string>(() => {}),
    });
    const theme = channelBridgeTheme(KEY, { resolveTurnLink: direct });

    await expect(theme.resolveTurnLink("x")).resolves.toBe("direct:x");

    expect(direct).toHaveBeenCalledTimes(1);
    expect(readChannelBridgeFallbackSample()).toEqual(samplesWith("timeout", 1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("reason=timeout");
  });

  it("rethrows and counts nothing when the legacy module has no such symbol", () => {
    process.env[ENV] = "on";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serveChannelBridgeTheme(KEY, {
      addedByConnector: () => {
        throw new Error("nothing to fall back to");
      },
    });
    const theme = channelBridgeTheme(KEY, legacyTheme()) as unknown as Record<string, unknown>;

    expect(() => (theme.addedByConnector as () => unknown)()).toThrow("nothing to fall back to");

    // No sample: nothing returned to the direct path, the failure stayed a failure.
    expect(readChannelBridgeFallbackSample()).toEqual(samples());
    expect(String(warn.mock.calls[0]?.[0])).toContain("direct_symbol=absent");
  });
});

describe("bridge fallback: the counters and the timeout setting", () => {
  it("reads every reason with a zero before the first fallback", () => {
    expect(readChannelBridgeFallbackSample()).toEqual([
      { reason: "error", count: 0 },
      { reason: "timeout", count: 0 },
    ]);
  });

  it("takes the process registry by default and the injected source when given", () => {
    const injected = () => [{ reason: "timeout" as const, count: 4 }];

    expect(resolveChannelBridgeFallbackSource()()).toEqual(readChannelBridgeFallbackSample());
    expect(resolveChannelBridgeFallbackSource(injected)).toBe(injected);
    expect(resolveChannelBridgeFallbackSource({ read: injected })()).toEqual([
      { reason: "timeout", count: 4 },
    ]);
  });

  it("defaults the timeout and keeps the default when the setting is not a positive number", () => {
    expect(channelBridgeFallbackTimeoutMs({})).toBe(DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS);
    expect(channelBridgeFallbackTimeoutMs({ [TIMEOUT_ENV]: "   " })).toBe(
      DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS,
    );
    expect(channelBridgeFallbackTimeoutMs({ [TIMEOUT_ENV]: "soon" })).toBe(
      DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS,
    );
    expect(channelBridgeFallbackTimeoutMs({ [TIMEOUT_ENV]: "0" })).toBe(
      DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS,
    );
    expect(channelBridgeFallbackTimeoutMs({ [TIMEOUT_ENV]: "-5" })).toBe(
      DEFAULT_CHANNEL_BRIDGE_FALLBACK_TIMEOUT_MS,
    );
    expect(channelBridgeFallbackTimeoutMs({ [TIMEOUT_ENV]: "2500" })).toBe(2500);
    expect(channelBridgeFallbackTimeoutMs({ [TIMEOUT_ENV]: "1500.7" })).toBe(1500);
  });
});