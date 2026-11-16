import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@myrmidon/db";
import type { StorageService } from "../storage/types.js";

const createAsset = vi.fn();
const logActivity = vi.fn();

function storageFixture() {
  const putFile = vi.fn<StorageService["putFile"]>(async (input) => ({
    provider: "local_disk",
    objectKey: "assets/companies/logo",
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "sample",
    originalFilename: input.originalFilename,
  }));
  const storage: StorageService = {
    provider: "local_disk", putFile,
    getObject: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn(),
  };
  return { storage, putFile };
}

async function appFor(storage: StorageService) {
  const { assetRoutes } = await import("../routes/assets.js");
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "user-1" };
    next();
  });
  app.use("/api", assetRoutes({} as Db, storage));
  return app;
}

describe("lazy SVG logo uploads", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("../services/index.js", () => ({
      assetService: () => ({ create: createAsset }), logActivity,
    }));
    createAsset.mockResolvedValue({
      id: "asset-1", companyId: "company-1", provider: "local_disk",
      objectKey: "assets/companies/logo", contentType: "image/png", byteSize: 3,
      sha256: "sample", originalFilename: "logo.png", createdByAgentId: null,
      createdByUserId: "user-1", createdAt: new Date(), updatedAt: new Date(),
    });
  });
  afterEach(() => {
    vi.doUnmock("jsdom");
    vi.doUnmock("../services/index.js");
  });

  it("imports the router and stores PNG without loading jsdom", async () => {
    const jsdomLoad = vi.fn(() => { throw new Error("jsdom must not load for PNG"); });
    vi.doMock("jsdom", jsdomLoad);
    const { storage, putFile } = storageFixture();
    const app = await appFor(storage);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const res = await request(app).post("/api/companies/company-1/logo")
      .attach("file", png, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(putFile).toHaveBeenCalledOnce();
    expect(putFile).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1", namespace: "assets/companies", contentType: "image/png", body: png,
    }));
    expect(jsdomLoad).not.toHaveBeenCalled();
  }, 60000);

  it("removes active SVG content and external links while retaining internal references", async () => {
    const { storage, putFile } = storageFixture();
    const app = await appFor(storage);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><defs><circle id="safe" r="4"/></defs><script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject><a href="https://evil.example/"><circle r="2"/></a><a id="internal" href="#safe"><circle r="1"/></a></svg>`;
    const res = await request(app).post("/api/companies/company-1/logo")
      .attach("file", Buffer.from(svg), { filename: "logo.svg", contentType: "image/svg+xml" });
    expect(res.status).toBe(201);
    expect(putFile).toHaveBeenCalledOnce();
    const stored = putFile.mock.calls[0][0];
    expect(stored.contentType).toBe("image/svg+xml");
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(stored.body.toString("utf8"), { contentType: "image/svg+xml" });
    try {
      const doc = dom.window.document;
      expect(doc.documentElement.localName).toBe("svg");
      expect(doc.querySelector("script, foreignObject")).toBeNull();
      expect(doc.documentElement.hasAttribute("onload")).toBe(false);
      expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
      expect(doc.querySelector("#safe")).not.toBeNull();
      expect(doc.querySelector("#internal")?.getAttribute("href")).toBe("#safe");
    } finally { dom.window.close(); }
  });

  it("rejects invalid SVG without storing or creating an asset", async () => {
    const { storage, putFile } = storageFixture();
    const app = await appFor(storage);
    const res = await request(app).post("/api/companies/company-1/logo")
      .attach("file", Buffer.from("not actually svg"), { filename: "logo.svg", contentType: "image/svg+xml" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("SVG could not be sanitized");
    expect(putFile).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
});
