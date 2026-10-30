import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { brandHeadersMiddleware } from "../middleware/brand-headers.js";
import { logger } from "../middleware/logger.js";

describe("brandHeadersMiddleware", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("accepts incoming legacy x-paperclip-* headers, logs a deprecation warning, and aliases them to x-myrmidon-*", async () => {
    const app = express();
    app.use(brandHeadersMiddleware());

    let capturedHeaders: Record<string, any> = {};
    let runIdFromNew: string | undefined;
    let runIdFromOld: string | undefined;
    let tabVisibleFromNew: string | undefined;

    app.get("/test", (req, res) => {
      capturedHeaders = { ...req.headers };
      runIdFromNew = req.header("x-myrmidon-run-id");
      runIdFromOld = req.header("x-paperclip-run-id");
      tabVisibleFromNew = req.header("x-myrmidon-tab-visible");
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/test")
      .set("X-Paperclip-Run-Id", "run-123")
      .set("x-paperclip-tab-visible", "hidden");

    expect(res.status).toBe(200);
    expect(capturedHeaders["x-paperclip-run-id"]).toBe("run-123");
    expect(capturedHeaders["x-myrmidon-run-id"]).toBe("run-123");
    expect(capturedHeaders["x-paperclip-tab-visible"]).toBe("hidden");
    expect(capturedHeaders["x-myrmidon-tab-visible"]).toBe("hidden");

    expect(runIdFromNew).toBe("run-123");
    expect(runIdFromOld).toBe("run-123");
    expect(tabVisibleFromNew).toBe("hidden");

    // Deprecation warning logged for each x-paperclip-* header
    expect(warnSpy).toHaveBeenCalledWith(
      { header: "x-paperclip-run-id", replacement: "x-myrmidon-run-id" },
      'Header "x-paperclip-run-id" is deprecated; use "x-myrmidon-run-id" instead',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      { header: "x-paperclip-tab-visible", replacement: "x-myrmidon-tab-visible" },
      'Header "x-paperclip-tab-visible" is deprecated; use "x-myrmidon-tab-visible" instead',
    );
  });

  it("accepts incoming canonical x-myrmidon-* headers without deprecation warnings and aliases backwards for legacy readers", async () => {
    const app = express();
    app.use(brandHeadersMiddleware());

    let capturedHeaders: Record<string, any> = {};
    let runIdFromNew: string | undefined;
    let runIdFromOld: string | undefined;

    app.get("/test", (req, res) => {
      capturedHeaders = { ...req.headers };
      runIdFromNew = req.header("x-myrmidon-run-id");
      runIdFromOld = req.header("x-paperclip-run-id");
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/test")
      .set("X-Myrmidon-Run-Id", "run-456");

    expect(res.status).toBe(200);
    expect(capturedHeaders["x-myrmidon-run-id"]).toBe("run-456");
    expect(capturedHeaders["x-paperclip-run-id"]).toBe("run-456");
    expect(runIdFromNew).toBe("run-456");
    expect(runIdFromOld).toBe("run-456");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits canonical x-myrmidon-* response headers when route sets legacy x-paperclip-* headers", async () => {
    const app = express();
    app.use(brandHeadersMiddleware());

    app.get("/test", (_req, res) => {
      res.setHeader("X-Paperclip-Request-Cache", "miss");
      res.setHeader("X-Paperclip-Custom-Header", "value1");
      res.json({ ok: true });
    });

    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-myrmidon-request-cache"]).toBe("miss");
    expect(res.headers["x-myrmidon-custom-header"]).toBe("value1");
    expect(res.headers["x-paperclip-request-cache"]).toBeUndefined();
    expect(res.headers["x-paperclip-custom-header"]).toBeUndefined();
  });

  it("emits canonical x-myrmidon-* response headers when route sets x-myrmidon-* headers directly", async () => {
    const app = express();
    app.use(brandHeadersMiddleware());

    app.get("/test", (_req, res) => {
      res.setHeader("X-Myrmidon-Request-Cache", "hit");
      res.json({ ok: true });
    });

    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-myrmidon-request-cache"]).toBe("hit");
    expect(res.headers["x-paperclip-request-cache"]).toBeUndefined();
  });

  it("rewrites headers set via writeHead to canonical x-myrmidon-* headers", async () => {
    const app = express();
    app.use(brandHeadersMiddleware());

    app.get("/test", (_req, res) => {
      res.writeHead(200, {
        "X-Paperclip-Bridge-Outcome": "indeterminate",
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ok: true }));
    });

    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-myrmidon-bridge-outcome"]).toBe("indeterminate");
    expect(res.headers["x-paperclip-bridge-outcome"]).toBeUndefined();
  });

  it("prefers explicitly supplied canonical header over deprecated alias if both are provided", async () => {
    const app = express();
    app.use(brandHeadersMiddleware());

    let capturedHeaders: Record<string, any> = {};

    app.get("/test", (req, res) => {
      capturedHeaders = { ...req.headers };
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/test")
      .set("x-myrmidon-run-id", "new-canonical-run")
      .set("x-paperclip-run-id", "old-legacy-run");

    expect(res.status).toBe(200);
    expect(capturedHeaders["x-myrmidon-run-id"]).toBe("new-canonical-run");
  });
});
