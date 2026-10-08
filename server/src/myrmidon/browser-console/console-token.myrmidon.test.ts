// myrmidon(BROWSER-CONSOLE): the part-B token contract tests — pure units, no
// database. Covers the auth-JSON shape (username = browserId, VNC parameters,
// expires = now + TTL), that the blob round-trips through the SAME decoder and
// key the fleet console uses, and every stable failure code.
//
// The test-guardian RED/GREEN hinge lives in the expiry test: if the signing
// ever stops binding the token to `now + TTL`, that test fails first.

import { describe, expect, it } from "vitest";
import { decodeGuacamoleAuthJson } from "../fleet-console/token.js";
import {
  BROWSER_CONSOLE_ERROR_CODES,
  buildScreenAuthJson,
  issueScreenToken,
  screenConsoleUrl,
} from "./console-token.js";
import { parseBrowserVncTarget, DEFAULT_BROWSER_VNC_PORT } from "@paperclipai/shared/myrmidon-browser-console";

// The fleet-console test key: 32 hex, AES-128-CBC key + HMAC input material.
const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000_000;
const TTL = 5 * 60_000;

const configured = {
  guacamoleUrl: "https://guac.invalid",
  vncTarget: { hostname: "exec-host.invalid", port: 5900 },
  secretKey: SECRET,
  tokenTtlMs: TTL,
};

describe("issueScreenToken (part B)", () => {
  it("signs a blob that decodeGuacamoleAuthJson reads back with the same key", () => {
    const issued = issueScreenToken({ browserId: "browser-a", nowMs: NOW, ...configured });
    if (!issued.ok) throw new Error(`expected ok, got ${issued.code}`);
    const decoded = decodeGuacamoleAuthJson(issued.token, SECRET, NOW);
    expect(decoded.username).toBe("browser-a");
    expect(Object.keys(decoded.connections)).toEqual(["browser-a"]);
    const connection = decoded.connections["browser-a"]!;
    expect(connection.protocol).toBe("vnc");
    expect(connection.parameters.hostname).toBe("exec-host.invalid");
    expect(connection.parameters.port).toBe("5900");
    // Watchdog hinge: the token must expire exactly now + TTL — disable the
    // binding in console-token.ts and this assertion goes RED.
    expect(decoded.expires).toBe(NOW + TTL);
  });

  it("the console URL carries the blob in the data parameter", () => {
    const issued = issueScreenToken({ browserId: "browser-a", nowMs: NOW, ...configured });
    if (!issued.ok) throw new Error(`expected ok, got ${issued.code}`);
    expect(issued.consoleUrl).toBe(`https://guac.invalid/#/?data=${encodeURIComponent(issued.token)}`);
    expect(issued.expiresAt).toBe(NOW + TTL);
  });

  it("a tampered blob does not decode", () => {
    const issued = issueScreenToken({ browserId: "browser-a", nowMs: NOW, ...configured });
    if (!issued.ok) throw new Error("expected ok");
    const bytes = Buffer.from(issued.token, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decodeGuacamoleAuthJson(bytes.toString("base64"), SECRET, NOW)).toThrow();
  });

  it("missing console URL or VNC target: 503 console_not_configured", () => {
    expect(issueScreenToken({ browserId: "b", nowMs: NOW, ...configured, guacamoleUrl: null })).toMatchObject({
      ok: false,
      status: 503,
      code: BROWSER_CONSOLE_ERROR_CODES.notConfigured,
    });
    expect(issueScreenToken({ browserId: "b", nowMs: NOW, ...configured, vncTarget: null })).toMatchObject({
      ok: false,
      status: 503,
      code: BROWSER_CONSOLE_ERROR_CODES.notConfigured,
    });
  });

  it("missing signing secret: 503 console_secret_missing; bad shape: console_secret_invalid", () => {
    expect(issueScreenToken({ browserId: "b", nowMs: NOW, ...configured, secretKey: null })).toMatchObject({
      ok: false,
      status: 503,
      code: BROWSER_CONSOLE_ERROR_CODES.secretMissing,
    });
    expect(issueScreenToken({ browserId: "b", nowMs: NOW, ...configured, secretKey: "short" })).toMatchObject({
      ok: false,
      status: 503,
      code: BROWSER_CONSOLE_ERROR_CODES.secretInvalid,
    });
  });
});

describe("buildScreenAuthJson / screenConsoleUrl", () => {
  it("binds one browser to one VNC connection", () => {
    const json = buildScreenAuthJson({ browserId: "browser-b", hostname: "h.invalid", port: 5901, expiresAt: NOW + TTL });
    expect(json).toEqual({
      username: "browser-b",
      expires: NOW + TTL,
      connections: { "browser-b": { protocol: "vnc", parameters: { hostname: "h.invalid", port: "5901" } } },
    });
  });

  it("normalizes a trailing slash on the client base URL", () => {
    expect(screenConsoleUrl("https://guac.invalid/", "blob")).toBe("https://guac.invalid/#/?data=blob");
  });
});

describe("parseBrowserVncTarget (MYRMIDON_BROWSER_VNC_TARGET)", () => {
  it("reads a bare host on the default port", () => {
    expect(parseBrowserVncTarget("exec-host.invalid")).toEqual({ hostname: "exec-host.invalid", port: DEFAULT_BROWSER_VNC_PORT });
  });
  it("reads host:port", () => {
    expect(parseBrowserVncTarget("exec-host.invalid:5901")).toEqual({ hostname: "exec-host.invalid", port: 5901 });
  });
  it("reads a bracketed IPv6 host", () => {
    expect(parseBrowserVncTarget("[fe80::1]:5900")).toEqual({ hostname: "[fe80::1]", port: 5900 });
  });
  it("refuses guesses: empty, scheme, path, whitespace, out-of-range port", () => {
    for (const raw of ["", "  ", "http://host.invalid", "host.invalid/path", "host.invalid:0", "host.invalid:70000", "host invalid", undefined, null]) {
      expect(parseBrowserVncTarget(raw)).toBeNull();
    }
  });
});
