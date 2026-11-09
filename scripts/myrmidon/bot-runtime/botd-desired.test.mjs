import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDesiredClient, parseDesiredState } from "../../../docker/bot-runtime/botd/lib/desired.js";
import { createReporter } from "../../../docker/bot-runtime/botd/lib/report.js";
import { boardKeyValues, redact } from "../../../docker/bot-runtime/botd/lib/board-env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs/myrmidon/bot-disk-contract/desired-state.json"), "utf8"),
);
const KEY = "pcp_SECRETKEY_0123456789";
const OLD_KEY = "pcp_OLD_ALIAS_KEY_9876543210";

let server;
let baseUrl;
let handler;
let seenAuth;

beforeEach(async () => {
  seenAuth = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(FIXTURE));
  };
  server = http.createServer((req, res) => {
    seenAuth.push({ url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

function client(extra = {}) {
  const logs = [];
  const c = createDesiredClient({
    env: { PAPERCLIP_API_URL: `${baseUrl}/api`, PAPERCLIP_API_KEY: KEY },
    log: (l) => logs.push(l),
    now: () => new Date("2026-10-06T14:07:00Z"),
    ...extra,
  });
  return { c, logs };
}

describe("botd desired state client (C3)", () => {
  it("the contract fixture passes the schema", () => {
    assert.equal(parseDesiredState(FIXTURE).ok, true);
  });

  it("parses a valid answer, sends the bot key, caches with fetchedAt", async () => {
    const { c } = client();
    const r = await c.poll();
    assert.equal(r.ok, true);
    assert.deepEqual(r.state, FIXTURE);
    assert.equal(r.fetchedAt, "2026-10-06T14:07:00.000Z");
    assert.equal(c.getLast().fetchedAt, r.fetchedAt);
    assert.deepEqual(seenAuth, [{ url: "/api/myrmidon/bots/me/workspaces", auth: `Bearer ${KEY}` }]);
  });

  for (const status of [503, 500, 401, 403, 404]) {
    it(`HTTP ${status} -> ok:false with a reason, cache kept`, async () => {
      const { c } = client();
      await c.poll();
      handler = (_req, res) => {
        res.writeHead(status);
        res.end("nope");
      };
      const r = await c.poll();
      assert.equal(r.ok, false);
      assert.match(r.reason, new RegExp(String(status)));
      assert.ok(r.last, "last good answer is available for the report only");
      assert.equal("state" in r, false);
    });
  }

  it("a dropped connection -> ok:false", async () => {
    handler = (req) => req.socket.destroy();
    const r = await client().c.poll();
    assert.equal(r.ok, false);
    assert.match(r.reason, /network error|not valid JSON/);
  });

  it("garbage body -> ok:false", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("<html>not json");
    };
    const r = await client().c.poll();
    assert.equal(r.ok, false);
    assert.match(r.reason, /JSON/);
  });

  it("an unknown state rejects the whole answer with a reason", async () => {
    const bad = structuredClone(FIXTURE);
    bad.workspaces[1].state = "archived";
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(bad));
    };
    const r = await client().c.poll();
    assert.equal(r.ok, false);
    assert.match(r.reason, /workspaces\[1\]\.state is unknown/);
  });

  it("schema violations are caught (grace, repo, since, level)", () => {
    const mut = (fn) => {
      const v = structuredClone(FIXTURE);
      fn(v);
      return parseDesiredState(v);
    };
    assert.equal(mut((v) => (v.grace.closingMinutes = 0)).ok, false);
    assert.equal(mut((v) => (v.workspaces[0].repo = "no-slash")).ok, false);
    assert.equal(mut((v) => (v.workspaces[0].since = "yesterday")).ok, false);
    assert.equal(mut((v) => (v.pressure.level = "panic")).ok, false);
    assert.equal(mut((v) => (v.pressure.quotaPercent = null)).ok, true);
    assert.equal(mut((v) => delete v.workspaces[0].repo).ok, true);
    assert.equal(parseDesiredState(null).ok, false);
  });

  it("times out after the configured time", async () => {
    handler = () => {};
    const { c } = client({ timeoutMs: 100 });
    const r = await c.poll();
    assert.equal(r.ok, false);
    assert.match(r.reason, /timeout after 100 ms/);
  });

  it("the default timeout is 10 s and the interval 300 s (BOT-DISK-H LOAD)", async () => {
    const { DESIRED_DEFAULTS } = await import("../../../docker/bot-runtime/botd/lib/desired.js");
    assert.equal(DESIRED_DEFAULTS.timeoutMs, 10_000);
    assert.equal(DESIRED_DEFAULTS.intervalMs, 300_000);
  });

  it("the API key never reaches logs or reasons", async () => {
    const all = [];
    for (const status of [401, 503]) {
      handler = (_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(`echo ${KEY}`);
      };
      const { c, logs } = client();
      const r = await c.poll();
      all.push(r.reason, ...logs);
    }
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(`garbage ${KEY}`);
    };
    const { c, logs } = client({
      fetchImpl: async () => {
        throw new Error(`boom ${KEY}`);
      },
    });
    const r = await c.poll();
    all.push(r.reason, ...logs);
    const { c: c2, logs: logs2 } = client();
    all.push((await c2.poll()).reason, ...logs2);
    assert.ok(all.length >= 4);
    for (const line of all) assert.equal(String(line).includes(KEY), false, line);
  });

  it("without a key or URL: ok:false and no request", async () => {
    const r1 = await createDesiredClient({ env: { PAPERCLIP_API_URL: baseUrl } }).poll();
    const r2 = await createDesiredClient({ env: { PAPERCLIP_API_KEY: KEY } }).poll();
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(seenAuth.length, 0);
  });

  it("polls on start and on SIGUSR1, stop() detaches", async () => {
    const proc = new EventEmitter();
    const results = [];
    const { c } = client({ intervalMs: 3_600_000, onResult: (r) => results.push(r) });
    c.start(proc);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(results.length, 1);
    proc.emit("SIGUSR1");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok));
    c.stop();
    assert.equal(proc.listenerCount("SIGUSR1"), 0);
    proc.emit("SIGUSR1");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(results.length, 2);
  });

  it("repeats on the interval", async () => {
    const results = [];
    const { c } = client({ intervalMs: 80, onResult: (r) => results.push(r) });
    c.start(new EventEmitter());
    await new Promise((r) => setTimeout(r, 400));
    c.stop();
    assert.ok(results.length >= 3, `got ${results.length}`);
  });
});

// myrmidon(REBRAND-ENV, OPE-12052): botd reads the board address and key as
// MYRMIDON_API_URL / MYRMIDON_API_KEY first; PAPERCLIP_* is only the legacy alias.
describe("botd board env names: MYRMIDON_* first, PAPERCLIP_* as the alias (REBRAND-ENV)", () => {
  it("MYRMIDON_API_URL and MYRMIDON_API_KEY alone are enough", async () => {
    const c = createDesiredClient({ env: { MYRMIDON_API_URL: `${baseUrl}/api`, MYRMIDON_API_KEY: KEY } });
    const r = await c.poll();
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(seenAuth, [{ url: "/api/myrmidon/bots/me/workspaces", auth: `Bearer ${KEY}` }]);
  });

  it("MYRMIDON_* wins over PAPERCLIP_* when both are set to different values", async () => {
    const c = createDesiredClient({
      env: {
        MYRMIDON_API_URL: `${baseUrl}/api`,
        MYRMIDON_API_KEY: KEY,
        PAPERCLIP_API_URL: "http://127.0.0.1:1",
        PAPERCLIP_API_KEY: OLD_KEY,
      },
    });
    const r = await c.poll();
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(seenAuth, [{ url: "/api/myrmidon/bots/me/workspaces", auth: `Bearer ${KEY}` }]);
  });

  it("an empty MYRMIDON_* value falls back to the PAPERCLIP_* alias", async () => {
    const c = createDesiredClient({
      env: { MYRMIDON_API_URL: "", MYRMIDON_API_KEY: "", PAPERCLIP_API_URL: baseUrl, PAPERCLIP_API_KEY: KEY },
    });
    const r = await c.poll();
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(seenAuth, [{ url: "/api/myrmidon/bots/me/workspaces", auth: `Bearer ${KEY}` }]);
  });

  it("without a MYRMIDON_* key or URL (and no alias): ok:false, no request, reason names the MYRMIDON_* variable", async () => {
    const r1 = await createDesiredClient({ env: { MYRMIDON_API_URL: baseUrl } }).poll();
    const r2 = await createDesiredClient({ env: { MYRMIDON_API_KEY: KEY } }).poll();
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.match(r1.reason, /MYRMIDON_API_KEY/);
    assert.match(r2.reason, /MYRMIDON_API_URL/);
    assert.equal(seenAuth.length, 0);
  });

  it("the key never reaches a reason or a log under either name", async () => {
    handler = (_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(`echo ${KEY} ${OLD_KEY}`);
    };
    const logs = [];
    const c = createDesiredClient({
      env: { MYRMIDON_API_URL: baseUrl, MYRMIDON_API_KEY: KEY, PAPERCLIP_API_KEY: OLD_KEY },
      log: (l) => logs.push(l),
    });
    const r = await c.poll();
    assert.equal(r.ok, false);
    for (const line of [r.reason, ...logs]) {
      assert.equal(String(line).includes(KEY), false, line);
      assert.equal(String(line).includes(OLD_KEY), false, line);
    }
  });

  it("the disk reporter takes MYRMIDON_* too, MYRMIDON_* first, PAPERCLIP_* as the alias", async () => {
    const report = JSON.parse(
      fs.readFileSync(path.join(ROOT, "docs/myrmidon/bot-disk-contract/disk-report.json"), "utf8"),
    );
    const response = JSON.parse(
      fs.readFileSync(path.join(ROOT, "docs/myrmidon/bot-disk-contract/disk-report-response.json"), "utf8"),
    );
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization });
      return { status: 200, text: async () => JSON.stringify(response) };
    };
    const opts = { fetchImpl, sleep: async () => {}, log: () => {} };

    const canonical = await createReporter({
      ...opts,
      env: { MYRMIDON_API_URL: "http://board.test/api", MYRMIDON_API_KEY: KEY, PAPERCLIP_API_URL: "http://old.test", PAPERCLIP_API_KEY: OLD_KEY },
    }).send(report);
    assert.equal(canonical.ok, true, canonical.reason);
    const alias = await createReporter({
      ...opts,
      env: { PAPERCLIP_API_URL: "http://old.test", PAPERCLIP_API_KEY: OLD_KEY },
    }).send(report);
    assert.equal(alias.ok, true, alias.reason);

    assert.deepEqual(sent.map((s) => [new URL(s.url).host, s.auth]), [
      ["board.test", `Bearer ${KEY}`],
      ["old.test", `Bearer ${OLD_KEY}`],
    ]);
  });
});

describe("boardKeyValues and redact unit tests in botd (REBRAND-ENV-2, OPE-12070)", () => {
  it("boardKeyValues returns every non-empty board key under either name", () => {
    assert.deepEqual(boardKeyValues({}), []);
    assert.deepEqual(boardKeyValues({ MYRMIDON_API_KEY: "myr-key" }), ["myr-key"]);
    assert.deepEqual(boardKeyValues({ PAPERCLIP_API_KEY: "pcp-key" }), ["pcp-key"]);
    assert.deepEqual(
      boardKeyValues({ MYRMIDON_API_KEY: "myr-key", PAPERCLIP_API_KEY: "pcp-key" }),
      ["myr-key", "pcp-key"],
    );
    assert.deepEqual(
      boardKeyValues({ MYRMIDON_API_KEY: "", PAPERCLIP_API_KEY: "pcp-key" }),
      ["pcp-key"],
    );
    assert.deepEqual(
      boardKeyValues({ MYRMIDON_API_KEY: "myr-key", PAPERCLIP_API_KEY: "" }),
      ["myr-key"],
    );
    assert.deepEqual(boardKeyValues({ MYRMIDON_API_KEY: "", PAPERCLIP_API_KEY: "" }), []);
    assert.deepEqual(boardKeyValues(undefined), []);
  });

  it("redact strips the key when set under MYRMIDON_API_KEY", () => {
    const env = { MYRMIDON_API_KEY: "secret-myr-key" };
    const text = "error with secret-myr-key in response";
    assert.equal(redact(text, env), "error with [redacted] in response");
    assert.equal(redact(env, text), "error with [redacted] in response");
  });

  it("redact strips the key when set under PAPERCLIP_API_KEY", () => {
    const env = { PAPERCLIP_API_KEY: "secret-pcp-key" };
    const text = "error with secret-pcp-key in response";
    assert.equal(redact(text, env), "error with [redacted] in response");
    assert.equal(redact(env, text), "error with [redacted] in response");
  });

  it("redact strips both keys when set under both names with distinct values", () => {
    const env = { MYRMIDON_API_KEY: "secret-myr-key", PAPERCLIP_API_KEY: "secret-pcp-key" };
    const text = "headers: secret-myr-key and secret-pcp-key leaked";
    assert.equal(redact(text, env), "headers: [redacted] and [redacted] leaked");
    assert.equal(redact(env, text), "headers: [redacted] and [redacted] leaked");
  });

  it("redact leaves text intact when neither key is present in env", () => {
    assert.equal(redact("safe text", {}), "safe text");
    assert.equal(redact("safe text", { OTHER_VAR: "123" }), "safe text");
    assert.equal(redact("safe text", undefined), "safe text");
  });

  it("reporter redacts board key under both names from error reasons and logs", async () => {
    const report = JSON.parse(
      fs.readFileSync(path.join(ROOT, "docs/myrmidon/bot-disk-contract/disk-report.json"), "utf8"),
    );
    const logs = [];
    const fetchImpl = async () => {
      const err = new Error("connection failed");
      err.code = `LEAK_${KEY}_AND_${OLD_KEY}`;
      throw err;
    };
    const reporter = createReporter({
      fetchImpl,
      sleep: async () => {},
      log: (l) => logs.push(l),
      env: { MYRMIDON_API_URL: "http://board.test", MYRMIDON_API_KEY: KEY, PAPERCLIP_API_KEY: OLD_KEY },
      retryDelaysMs: [],
    });
    const res = await reporter.send(report);
    assert.equal(res.ok, false);
    assert.equal(res.reason.includes(KEY), false);
    assert.equal(res.reason.includes(OLD_KEY), false);
    assert.match(res.reason, /\[redacted\]/);
    assert.equal(logs.some((l) => l.includes("[redacted]")), true);
    assert.equal(logs.some((l) => l.includes(KEY) || l.includes(OLD_KEY)), false);
  });
});
