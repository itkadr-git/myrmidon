// myrmidon(EXTCASE-B): extension request types of the browser bridge.
//
// Runs without a network: sessions are fakes, and the socket-level test drives
// the bridge's own session class over a fake socket. The type names and
// payloads are neutral on purpose — the registry is generic.

import { describe, expect, it } from "vitest";
import { BROWSER_BRIDGE_ERROR_CODES } from "@paperclipai/shared";
import {
  BRIDGE_EXTENSION_MAX_TIMEOUT_MS,
  createBridgeExtensionRegistry,
  isBridgeExtensionType,
} from "./extensions.js";
import { InMemoryBridgeSessionRegistry, type BridgeSession } from "./sessions.js";
import { BrowserBridgeError } from "./service.js";
import { BridgeSocketSession } from "./wss.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

class FakeSession implements BridgeSession {
  readonly capabilities = [];
  readonly extVersion = "ext-test";
  readonly calls: Array<{ method: string; params: unknown; timeoutMs: number }> = [];
  constructor(
    readonly deviceId: string,
    readonly companyId: string,
    readonly connectedAt: number,
    private readonly answer: (params: unknown) => Promise<unknown> = async () => ({ ok: true }),
  ) {}
  async request(method: string, params: unknown, timeoutMs: number) {
    this.calls.push({ method, params, timeoutMs });
    return this.answer(params);
  }
  close(): void {}
}

function setup() {
  const sessions = new InMemoryBridgeSessionRegistry();
  const registry = createBridgeExtensionRegistry(sessions);
  return { sessions, registry };
}

describe("extension request types", () => {
  it("accepts only ext.<name> types", () => {
    expect(isBridgeExtensionType("ext.echo")).toBe(true);
    expect(isBridgeExtensionType("ext.echo.read")).toBe(true);
    expect(isBridgeExtensionType("browser.open")).toBe(false);
    expect(isBridgeExtensionType("bridge.hello")).toBe(false);
    expect(isBridgeExtensionType("ext.")).toBe(false);
    expect(isBridgeExtensionType("ext.Bad Name")).toBe(false);
    expect(isBridgeExtensionType(42)).toBe(false);
  });

  it("refuses to register a type outside the namespace or twice", () => {
    const { registry } = setup();
    expect(() => registry.register("browser.open")).toThrow(/ext\./);
    registry.register("ext.echo");
    expect(() => registry.register("ext.echo")).toThrow(/already registered/);
    expect(registry.has("ext.echo")).toBe(true);
    expect(registry.has("ext.other")).toBe(false);
  });

  it("sends over the session of the named company and returns the answer", async () => {
    const { sessions, registry } = setup();
    const mine = new FakeSession("dev-a", COMPANY_A, 10, async (params) => ({ echoed: params }));
    const theirs = new FakeSession("dev-b", COMPANY_B, 20);
    sessions.register(mine);
    sessions.register(theirs);
    registry.register("ext.echo", { timeoutMs: 5_000 });

    await expect(registry.send({ companyId: COMPANY_A, type: "ext.echo", params: { n: 1 } })).resolves.toEqual({
      echoed: { n: 1 },
    });
    expect(mine.calls).toEqual([{ method: "ext.echo", params: { n: 1 }, timeoutMs: 5_000 }]);
    expect(theirs.calls).toEqual([]);
  });

  it("prefers the newest session, a named device, and a select filter", async () => {
    const { sessions, registry } = setup();
    const older = new FakeSession("dev-old", COMPANY_A, 1);
    const newer = new FakeSession("dev-new", COMPANY_A, 2);
    sessions.register(older);
    sessions.register(newer);
    registry.register("ext.echo");

    await registry.send({ companyId: COMPANY_A, type: "ext.echo" });
    expect(newer.calls).toHaveLength(1);
    await registry.send({ companyId: COMPANY_A, type: "ext.echo", deviceId: "dev-old" });
    expect(older.calls).toHaveLength(1);
    await registry.send({ companyId: COMPANY_A, type: "ext.echo", select: (s) => s.deviceId === "dev-old" });
    expect(older.calls).toHaveLength(2);
  });

  it("never reaches another company's device, even by device id", async () => {
    const { sessions, registry } = setup();
    const other = new FakeSession("dev-b", COMPANY_B, 1);
    sessions.register(other);
    registry.register("ext.echo");
    await expect(registry.send({ companyId: COMPANY_A, type: "ext.echo", deviceId: "dev-b" })).rejects.toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.deviceOffline,
    });
    expect(other.calls).toEqual([]);
  });

  it("refuses an unregistered type and an offline company", async () => {
    const { registry } = setup();
    await expect(registry.send({ companyId: COMPANY_A, type: "ext.nope" })).rejects.toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.methodNotFound,
    });
    registry.register("ext.echo");
    await expect(registry.send({ companyId: COMPANY_A, type: "ext.echo" })).rejects.toBeInstanceOf(BrowserBridgeError);
    await expect(registry.send({ companyId: COMPANY_A, type: "ext.echo" })).rejects.toMatchObject({
      reasonCode: BROWSER_BRIDGE_ERROR_CODES.deviceOffline,
    });
  });

  it("clamps the timeout", async () => {
    const { sessions, registry } = setup();
    const session = new FakeSession("dev-a", COMPANY_A, 1);
    sessions.register(session);
    registry.register("ext.echo");
    await registry.send({ companyId: COMPANY_A, type: "ext.echo", timeoutMs: 10 * BRIDGE_EXTENSION_MAX_TIMEOUT_MS });
    expect(session.calls[0]?.timeoutMs).toBe(BRIDGE_EXTENSION_MAX_TIMEOUT_MS);
  });

  it("propagates a client refusal to the caller", async () => {
    const { sessions, registry } = setup();
    sessions.register(
      new FakeSession("dev-a", COMPANY_A, 1, async () => {
        throw new BrowserBridgeError(-32001, "client said no");
      }),
    );
    registry.register("ext.echo");
    await expect(registry.send({ companyId: COMPANY_A, type: "ext.echo" })).rejects.toMatchObject({ message: "client said no" });
  });

  it("handle: serves registered handlers with the authenticated caller only", async () => {
    const { registry } = setup();
    const seen: unknown[] = [];
    registry.register("ext.ping", {
      handler: (caller, params) => {
        seen.push({ caller, params });
        return { pong: true };
      },
    });
    registry.register("ext.out-only");
    registry.register("ext.boom", {
      handler: () => {
        throw new Error("secret detail");
      },
    });
    registry.register("ext.deny", {
      handler: () => {
        throw new BrowserBridgeError(-32013, "not allowed");
      },
    });
    const caller = { companyId: COMPANY_A, deviceId: "dev-a" };
    await expect(registry.handle("ext.ping", caller, { a: 1 })).resolves.toEqual({ ok: true, result: { pong: true } });
    expect(seen).toEqual([{ caller, params: { a: 1 } }]);
    expect(registry.handle("ext.out-only", caller, {})).toBeUndefined();
    expect(registry.handle("ext.unknown", caller, {})).toBeUndefined();
    await expect(registry.handle("ext.boom", caller, {})).resolves.toEqual({
      ok: false,
      code: BROWSER_BRIDGE_ERROR_CODES.internalError,
      message: "extension handler failed",
    });
    await expect(registry.handle("ext.deny", caller, {})).resolves.toEqual({ ok: false, code: -32013, message: "not allowed" });
  });
});

describe("extension types on the bridge socket", () => {
  function socketHarness(register: (r: ReturnType<typeof createBridgeExtensionRegistry>) => void) {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (data: string) => sent.push(data),
      close: () => {},
      terminate: () => {},
      on: () => {},
    };
    const registry = createBridgeExtensionRegistry(new InMemoryBridgeSessionRegistry());
    register(registry);
    const session = new BridgeSocketSession(socket, "dev-a", COMPANY_A, 1, () => {}, registry);
    const frames = () => sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    return { session, frames };
  }
  const noHello = () => {};

  it("answers a registered type after hello, with the session's identity", async () => {
    const { session, frames } = socketHarness((r) =>
      r.register("ext.who", { handler: (caller, params) => ({ caller, params }) }),
    );
    session.completeHello("1.0.0", []);
    session.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ext.who", params: { x: 1 } }), noHello);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames()).toEqual([
      { jsonrpc: "2.0", id: 7, result: { caller: { companyId: COMPANY_A, deviceId: "dev-a" }, params: { x: 1 } } },
    ]);
  });

  it("refuses the type before hello, and unknown types after it", async () => {
    const { session, frames } = socketHarness((r) => r.register("ext.who", { handler: () => ({}) }));
    session.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ext.who" }), noHello);
    session.completeHello("1.0.0", []);
    session.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ext.nope" }), noHello);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const out = frames();
    expect(out).toHaveLength(2);
    expect(out.map((f) => (f.error as { code: number }).code)).toEqual([
      BROWSER_BRIDGE_ERROR_CODES.methodNotFound,
      BROWSER_BRIDGE_ERROR_CODES.methodNotFound,
    ]);
  });

  it("carries a board-to-client request and resolves with the client's answer", async () => {
    const { session, frames } = socketHarness(() => {});
    const pending = session.request("ext.echo", { n: 1 }, 1_000);
    const [frame] = frames();
    expect(frame).toMatchObject({ jsonrpc: "2.0", method: "ext.echo", params: { n: 1 } });
    session.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: frame!.id, result: { ok: 1 } }), noHello);
    await expect(pending).resolves.toEqual({ ok: 1 });
  });
});
