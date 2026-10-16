import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import {
  createCentralHistoryClient,
  isTruthyFlag,
  readCentralHistorySettings,
  renderRestoredHistory,
  sortTurnsOldestFirst,
  type CentralHistorySettings,
  type StoredSessionTurn,
  CENTRAL_HISTORY_ENABLED_ENV,
} from "./central-history.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return { config } as unknown as AdapterExecutionContext;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("isTruthyFlag", () => {
  it("accepts the repo's standard enable values", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isTruthyFlag(value)).toBe(true);
    }
  });

  it("treats everything else (and unset) as off", () => {
    for (const value of [undefined, null, "", "0", "false", "no", "off", "enable"]) {
      expect(isTruthyFlag(value)).toBe(false);
    }
  });
});

describe("readCentralHistorySettings", () => {
  it("is off when the enable flag is absent", () => {
    const settings = readCentralHistorySettings(makeCtx({}));
    expect(settings.enabled).toBe(false);
  });

  it("is off (not enabled) while the flag is on but the address or bank is unknown", () => {
    const settings = readCentralHistorySettings(
      makeCtx({ centralHistory: "1" }),
    );
    expect(settings.enabled).toBe(false);
  });

  it("reads the flag, address, bank and key from the card config", () => {
    const settings = readCentralHistorySettings(
      makeCtx({
        centralHistory: "1",
        centralHistoryUrl: "http://hindsight.internal:8080",
        hindsight: { bankId: "bank-agent-1" },
        centralHistoryApiKey: "***",
      }),
    );
    expect(settings.enabled).toBe(true);
    expect(settings.baseUrl).toBe("http://hindsight.internal:8080");
    expect(settings.bankId).toBe("bank-agent-1");
    expect(settings.apiKey).toBe("***");
  });

  it("reads the flag from the injected run env map", () => {
    const settings = readCentralHistorySettings(
      makeCtx({
        env: {
          [CENTRAL_HISTORY_ENABLED_ENV]: "on",
          MYRMIDON_BOT_HINDSIGHT_API_URL: "http://hindsight:8080",
          MYRMIDON_BOT_HINDSIGHT_BANK: "bank-env",
        },
      }),
    );
    expect(settings.enabled).toBe(true);
    expect(settings.bankId).toBe("bank-env");
  });

  it("rejects a non-http address instead of enabling", () => {
    const settings = readCentralHistorySettings(
      makeCtx({
        centralHistory: "1",
        centralHistoryUrl: "ftp://nope",
        hindsight: { bankId: "bank-1" },
      }),
    );
    expect(settings.enabled).toBe(false);
  });

  it("clamps maxTurns to a sane range", () => {
    const settings = readCentralHistorySettings(
      makeCtx({
        centralHistory: "1",
        centralHistoryUrl: "http://hindsight:8080",
        hindsight: { bankId: "bank-1" },
        centralHistoryMaxTurns: 5000,
      }),
    );
    expect(settings.maxTurns).toBeLessThanOrEqual(50);
    expect(settings.maxTurns).toBeGreaterThan(0);
  });
});

describe("sortTurnsOldestFirst", () => {
  it("orders by savedAt ascending", () => {
    const turns: StoredSessionTurn[] = [
      { runId: "r2", savedAt: "2026-10-05T02:00:00.000Z", output: "second" },
      { runId: "r1", savedAt: "2026-10-05T01:00:00.000Z", output: "first" },
    ];
    expect(sortTurnsOldestFirst(turns).map((turn) => turn.runId)).toEqual(["r1", "r2"]);
  });

  it("keeps rows without a timestamp before timestamped ones", () => {
    const turns: StoredSessionTurn[] = [
      { runId: "r1", savedAt: "2026-10-05T01:00:00.000Z", output: "first" },
      { runId: "r0", savedAt: "", output: "undated" },
    ];
    expect(sortTurnsOldestFirst(turns).map((turn) => turn.runId)).toEqual(["r0", "r1"]);
  });
});

describe("renderRestoredHistory", () => {
  it("returns an empty string for no turns", () => {
    expect(renderRestoredHistory([])).toBe("");
  });

  it("renders the freshest turns oldest-first under the restore heading", () => {
    const turns: StoredSessionTurn[] = [
      { runId: "r1", savedAt: "2026-10-05T01:00:00.000Z", output: "first answer" },
      { runId: "r2", savedAt: "2026-10-05T02:00:00.000Z", output: "second answer" },
    ];
    const block = renderRestoredHistory(turns, 10);
    expect(block).toContain("Restored session history");
    expect(block.indexOf("first answer")).toBeLessThan(block.indexOf("second answer"));
  });

  it("drops the oldest turns beyond maxTurns", () => {
    const turns: StoredSessionTurn[] = Array.from({ length: 5 }, (_, index) => ({
      runId: `r${index}`,
      savedAt: `2026-10-05T0${index}:00:00.000Z`,
      output: `output ${index}`,
    }));
    const block = renderRestoredHistory(turns, 2);
    expect(block).not.toContain("output 0");
    expect(block).not.toContain("output 1");
    expect(block).not.toContain("output 2");
    expect(block).toContain("output 3");
    expect(block).toContain("output 4");
  });
});

describe("createCentralHistoryClient", () => {
  it("returns null while the setting is off or unconfigured", () => {
    expect(createCentralHistoryClient({ enabled: false, baseUrl: "http://h:8", bankId: "b", apiKey: null, maxTurns: 10 })).toBeNull();
    expect(createCentralHistoryClient({ enabled: true, baseUrl: null, bankId: "b", apiKey: null, maxTurns: 10 })).toBeNull();
    expect(createCentralHistoryClient({ enabled: true, baseUrl: "http://h:8", bankId: null, apiKey: null, maxTurns: 10 })).toBeNull();
  });

  it("saves one turn keyed by the session document with the history tag", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const settings: CentralHistorySettings = {
      enabled: true,
      baseUrl: "http://hindsight:8080/",
      bankId: "bank-1",
      apiKey: "svc-key",
      maxTurns: 10,
    };
    const client = createCentralHistoryClient(settings, {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ ok: true });
      },
    });
    expect(client).not.toBeNull();
    await client!.saveTurn({ sessionKey: "paperclip:company:c:agent:a:issue:i", runId: "run-1", output: "final answer", model: "m" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://hindsight:8080/v1/default/banks/bank-1/memories");
    const body = JSON.parse(String(calls[0].init?.body));
    const item = body.items[0];
    expect(item.document_id).toBe("paperclip:company:c:agent:a:issue:i");
    expect(item.metadata).toEqual({ tags: ["myrmidon-session-history"], kind: "session-turn" });
    const record = JSON.parse(item.content);
    expect(record.schema).toBe("myrmidon-session-turn-v1");
    expect(record.runId).toBe("run-1");
    expect(record.output).toBe("final answer");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${settings.apiKey}`);
  });

  it("reads back only this session's turns, oldest first, capped to maxTurns", async () => {
    const sessionKey = "paperclip:company:c:agent:a:issue:i";
    const makeRow = (docId: string | null, runId: string, savedAt: string, output: string) => ({
      id: `mem-${runId}`,
      text: JSON.stringify({ schema: "myrmidon-session-turn-v1", runId, savedAt, output }),
      document_id: docId,
    });
    const client = createCentralHistoryClient(
      { enabled: true, baseUrl: "http://hindsight:8080", bankId: "bank-1", apiKey: null, maxTurns: 10 },
      {
        fetchImpl: async () =>
          jsonResponse({
            items: [
              makeRow(sessionKey, "r1", "2026-10-05T01:00:00.000Z", "first"),
              makeRow("other-session", "rx", "2026-10-05T01:30:00.000Z", "intruder"),
              makeRow(sessionKey, "r2", "2026-10-05T02:00:00.000Z", "second"),
              makeRow(sessionKey, "r3", "2026-10-05T03:00:00.000Z", "third"),
            ],
            total: 4,
          }),
      },
    );
    const turns = await client!.loadTurns({ sessionKey, maxTurns: 2 });
    expect(turns.map((turn) => turn.runId)).toEqual(["r2", "r3"]);
    // rows from another session never reach the renderer
    expect(renderRestoredHistory(turns)).not.toContain("intruder");
  });
});

// The ticket's acceptance model: a container volume recreated (the gateway's
// own per-session state gone) must not lose history — the next run reads the
// turns back from the central store. Simulated here as save-then-reload with
// a fresh client (no volume involved).
describe("volume-recreation round trip (modeled)", () => {
  it("history saved through one container survives and is reloaded after a rebuild", async () => {
    const store: unknown[] = [];
    const sessionKey = "paperclip:company:c:agent:a:issue:i";
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      if (target.endsWith("/memories") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        store.push(...body.items.map((item: Record<string, unknown>) => ({
          id: `mem-${store.length}`,
          text: item.content,
          document_id: item.document_id,
        })));
        return jsonResponse({ ok: true });
      }
      if (target.includes("/memories/list")) {
        return jsonResponse({ items: store, total: store.length });
      }
      throw new Error(`unexpected fetch ${target}`);
    };

    const settings = { enabled: true, baseUrl: "http://hindsight:8080", bankId: "bank-1", apiKey: null, maxTurns: 10 };

    // First container: two runs save their turns.
    const firstContainer = createCentralHistoryClient(settings, { fetchImpl });
    await firstContainer!.saveTurn({ sessionKey, runId: "run-1", output: "did the research" });
    await firstContainer!.saveTurn({ sessionKey, runId: "run-2", output: "wrote the report" });

    // Volume is recreated between containers: nothing in this process remembers
    // the turns; the rebuilt container reads through a brand-new client.
    const rebuiltContainer = createCentralHistoryClient(settings, { fetchImpl });
    const turns = await rebuiltContainer!.loadTurns({ sessionKey });

    expect(turns.map((turn) => turn.output)).toEqual(["did the research", "wrote the report"]);
    const block = renderRestoredHistory(turns, 10);
    expect(block).toContain("did the research");
    expect(block).toContain("wrote the report");
    expect(block).toContain("Restored session history");
  });
});