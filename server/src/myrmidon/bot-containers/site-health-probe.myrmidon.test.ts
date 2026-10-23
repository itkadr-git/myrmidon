import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProbeError, classifyProbeResponse, probeSiteHealth } from "./site-health-probe.js";

const HEALTHY = {
  siteId: "myr-vm1",
  epoch: 1,
  status: "healthy",
  capacity: { cpuCores: 8, memoryMb: 32768, diskGb: 500 },
  egressCheck: { ok: true, timestamp: "2026-10-23T08:00:00.000Z" },
};

describe("classifyProbeResponse", () => {
  it("a parsed healthy answer is success", () => {
    expect(classifyProbeResponse(200, JSON.stringify(HEALTHY))).toEqual({ result: "success", resourceDegraded: false });
  });

  it("a degraded site or a failing egress check is success with resourceDegraded", () => {
    expect(classifyProbeResponse(200, JSON.stringify({ ...HEALTHY, status: "degraded" })).resourceDegraded).toBe(true);
    expect(
      classifyProbeResponse(200, JSON.stringify({ ...HEALTHY, egressCheck: { ok: false, timestamp: "t" } })).resourceDegraded,
    ).toBe(true);
  });

  it("a site that reports itself unavailable counts as a miss", () => {
    expect(classifyProbeResponse(200, JSON.stringify({ ...HEALTHY, status: "unavailable" })).result).toBe("timeout");
  });

  it("rejected credentials quarantine, a server error is a miss", () => {
    expect(classifyProbeResponse(401, "").result).toBe("invalid_certificate");
    expect(classifyProbeResponse(403, "").result).toBe("invalid_certificate");
    expect(classifyProbeResponse(502, "").result).toBe("timeout");
  });

  it("something that is not the health contract is an incompatible protocol", () => {
    expect(classifyProbeResponse(200, "<html>").result).toBe("incompatible_protocol");
    expect(classifyProbeResponse(200, JSON.stringify({ status: "healthy" })).result).toBe("incompatible_protocol");
    expect(classifyProbeResponse(404, "").result).toBe("incompatible_protocol");
  });
});

describe("classifyProbeError", () => {
  it("TLS rejections quarantine; everything else is an unavailable site", () => {
    expect(classifyProbeError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe("invalid_certificate");
    expect(classifyProbeError(Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }))).toBe("invalid_certificate");
    expect(classifyProbeError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("timeout");
    expect(classifyProbeError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classifyProbeError(new Error("plain"))).toBe("timeout");
  });
});

describe("probeSiteHealth over HTTP", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); })));
  });

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("sends the bearer token to /v1/health and reads the answer", async () => {
    let seen: { url?: string; auth?: string } = {};
    const baseUrl = await serve((req, res) => {
      seen = { url: req.url, auth: req.headers.authorization };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(HEALTHY));
    });
    const outcome = await probeSiteHealth({ baseUrl, token: "tok" }, 2000);
    expect(outcome.result).toBe("success");
    expect(seen).toEqual({ url: "/v1/health", auth: "Bearer tok" });
  });

  it("a site that does not answer within the timeout is a miss", async () => {
    const baseUrl = await serve(() => {
      /* never answers */
    });
    const started = Date.now();
    const outcome = await probeSiteHealth({ baseUrl }, 150);
    expect(outcome.result).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a refused connection is a miss", async () => {
    const baseUrl = await serve((_req, res) => res.end());
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); })));
    expect((await probeSiteHealth({ baseUrl }, 1000)).result).toBe("timeout");
  });

  it("a 403 quarantines", async () => {
    const baseUrl = await serve((_req, res) => {
      res.statusCode = 403;
      res.end("no");
    });
    expect((await probeSiteHealth({ baseUrl }, 1000)).result).toBe("invalid_certificate");
  });
});
