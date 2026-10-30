import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { notModifiedOrSetEtag } from "../middleware/version-key-etag.js";

describe("versionKeyEtag", () => {
  it("returns 304 for unchanged version-key and 200/new-etag when version-key changes", async () => {
    let key = "v1";
    const app = express();
    app.get("/test", (req, res) => {
      if (notModifiedOrSetEtag(req, res, `"${key}"`)) return;
      res.json({ ok: true, key });
    });

    const first = await request(app).get("/test");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, must-revalidate");
    expect(first.headers.etag).toBe(`"${key}"`);

    const unchanged = await request(app).get("/test").set("If-None-Match", first.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.text).toBe("");

    key = "v2";
    const changed = await request(app).get("/test").set("If-None-Match", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).toBe(`"${key}"`);
    expect(changed.body.key).toBe("v2");
  });
});
