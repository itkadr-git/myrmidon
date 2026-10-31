import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, readPasswords, PaperclipApiClient, seedPaperclip } from "./seed-paperclip.mjs";

describe("seed-paperclip CLI and options parsing", () => {
  it("parses default options correctly", () => {
    const opts = parseArgs([]);
    const expectedBaseUrl = process.env.PAPERCLIP_BASE_URL || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
    assert.equal(opts.baseUrl, expectedBaseUrl);
    assert.equal(opts.out, "seed-report.json");
    assert.equal(opts.concurrency, 15);
    assert.equal(opts.verify, true);
  });

  it("parses custom CLI arguments", () => {
    const opts = parseArgs([
      "--base-url", "http://paperclip.internal:8080",
      "--api-key", "test-key-123",
      "--passwords-file", "/tmp/passwords.txt",
      "--out", "/tmp/custom-report.json",
      "--concurrency", "25",
      "--no-verify",
    ]);
    assert.equal(opts.baseUrl, "http://paperclip.internal:8080");
    assert.equal(opts.apiKey, "test-key-123");
    assert.equal(opts.passwordsFile, "/tmp/passwords.txt");
    assert.equal(opts.out, "/tmp/custom-report.json");
    assert.equal(opts.concurrency, 25);
    assert.equal(opts.verify, false);
  });
});

describe("seed-paperclip password reading", () => {
  const tmpDir = path.join(os.tmpdir(), "seed-paperclip-tests-" + Date.now());

  it("reads passwords from plain text file", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const txtPath = path.join(tmpDir, "passwords.txt");
    fs.writeFileSync(txtPath, "# Comment line\nPasswordAlpha!1\n\nPasswordBeta!2\n", "utf8");

    const [p1, p2] = readPasswords(txtPath);
    assert.equal(p1, "PasswordAlpha!1");
    assert.equal(p2, "PasswordBeta!2");
  });

  it("reads passwords from JSON array file", () => {
    const jsonPath = path.join(tmpDir, "passwords-arr.json");
    fs.writeFileSync(jsonPath, JSON.stringify(["SecretJson1!@", "SecretJson2!#"]), "utf8");

    const [p1, p2] = readPasswords(jsonPath);
    assert.equal(p1, "SecretJson1!@");
    assert.equal(p2, "SecretJson2!#");
  });

  it("reads passwords from JSON object file", () => {
    const jsonObjPath = path.join(tmpDir, "passwords-obj.json");
    fs.writeFileSync(jsonPathObj(jsonObjPath), JSON.stringify({ user1: "ObjPass1!%", user2: "ObjPass2!^" }), "utf8");

    function jsonPathObj(p) { return p; }
    const [p1, p2] = readPasswords(jsonObjPath);
    assert.equal(p1, "ObjPass1!%");
    assert.equal(p2, "ObjPass2!^");
  });

  it("throws error when file contains fewer than 2 passwords", () => {
    const singlePath = path.join(tmpDir, "single.txt");
    fs.writeFileSync(singlePath, "SinglePasswordOnly\n", "utf8");

    assert.throws(() => readPasswords(singlePath), /must contain at least 2 non-empty passwords/);
  });

  it("throws error when file does not exist", () => {
    assert.throws(() => readPasswords(path.join(tmpDir, "non-existent.txt")), /Failed to read passwords file/);
  });
});

describe("PaperclipApiClient HTTP client", () => {
  let server;
  let port;
  const recordedRequests = [];

  it("retains Better Auth session cookies for authenticated requests", async () => {
    const seenCookies = [];
    const authServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/sign-up/email") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": ["better-auth.session_token=session123; Path=/; HttpOnly", "better-auth.state=state123; Path=/"],
        });
        res.end(JSON.stringify({ user: { id: "user-1" } }));
        return;
      }
      if (req.url === "/api/auth/sign-in/email") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ user: { id: "user-1" } }));
        return;
      }
      if (req.url === "/api/bootstrap/claim") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ claimed: true, userId: "user-1" }));
        return;
      }
      seenCookies.push(req.headers.cookie || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "company-1" }));
    });

    await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    try {
      const client = new PaperclipApiClient(`http://127.0.0.1:${authServer.address().port}`);
      await client.request("/api/auth/sign-up/email", { method: "POST", body: { email: "seed@example.test" } });
      await client.request("/api/companies", { method: "POST", body: { name: "Seed company" } });
      assert.equal(seenCookies[0], "better-auth.session_token=session123; better-auth.state=state123");
    } finally {
      await new Promise((resolve) => authServer.close(resolve));
    }
  });

  it("handles JSON requests and responses", async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        recordedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        });

        if (req.url === "/api/companies" && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "comp-123", name: "Тестовая компания" }));
        } else if (req.url === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      });
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });

    try {
      const client = new PaperclipApiClient(`http://127.0.0.1:${port}`, "secret-api-key");
      const health = await client.request("/api/health");
      assert.equal(health.data.status, "ok");

      const comp = await client.request("/api/companies", {
        method: "POST",
        body: { name: "Тестовая компания" },
      });
      assert.equal(comp.data.id, "comp-123");
      assert.equal(comp.data.name, "Тестовая компания");

      // Verify Authorization header was passed
      assert.equal(recordedRequests[0].headers.authorization, "Bearer secret-api-key");
      // Verify browser-origin headers are sent so the board mutation guard accepts session mutations
      assert.equal(recordedRequests[0].headers.origin, `http://127.0.0.1:${port}`);
      assert.equal(recordedRequests[0].headers.referer, `http://127.0.0.1:${port}/`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("seedPaperclip mock flow execution", () => {
  let server;
  let port;
  let companyCounter = 0;
  let projectCounter = 0;
  let agentCounter = 0;
  let secretCounter = 0;
  let issueCounter = 0;
  let commentCounter = 0;
  let docCounter = 0;
  let attachmentCounter = 0;

  const capturedAgents = [];
  const capturedIssues = [];

  it("seeds all required entities with correct counts and payloads", async () => {
    server = http.createServer((req, res) => {
      let bodyData = [];
      req.on("data", (chunk) => bodyData.push(chunk));
      req.on("end", () => {
        const rawBody = Buffer.concat(bodyData);
        let parsed = null;
        try {
          parsed = JSON.parse(rawBody.toString("utf8"));
        } catch {
          // multipart or non-json
        }

        res.writeHead(200, { "Content-Type": "application/json" });

        if (req.url.startsWith("/api/auth/sign-up/email")) {
          res.end(JSON.stringify({ user: { id: `usr-${parsed.email}`, email: parsed.email } }));
        } else if (req.url === "/api/auth/sign-in/email") {
          res.end(JSON.stringify({ user: { id: "usr-signin", email: parsed.email } }));
        } else if (req.url === "/api/bootstrap/claim") {
          res.end(JSON.stringify({ claimed: true, userId: "usr-signin" }));
        } else if (req.url === "/api/companies" && req.method === "POST") {
          companyCounter++;
          res.end(JSON.stringify({ id: `comp-${companyCounter}`, name: parsed.name, issuePrefix: parsed.issuePrefix }));
        } else if (req.url.includes("/projects") && req.method === "POST") {
          projectCounter++;
          res.end(JSON.stringify({ id: `proj-${projectCounter}`, name: parsed.name }));
        } else if (req.url.includes("/agents") && req.method === "POST") {
          agentCounter++;
          capturedAgents.push(parsed);
          res.end(JSON.stringify({ id: `agent-${agentCounter}`, name: parsed.name, appearance: parsed.appearance }));
        } else if (req.url.startsWith("/api/agents/") && req.method === "PATCH") {
          res.end(JSON.stringify({ status: "ok" }));
        } else if (req.url.includes("/secrets") && req.method === "POST") {
          secretCounter++;
          res.end(JSON.stringify({ id: `sec-${secretCounter}`, name: parsed.name }));
        } else if (req.url.includes("/attachments") && req.method === "POST") {
          attachmentCounter++;
          res.end(JSON.stringify({ id: `att-${attachmentCounter}`, byteSize: rawBody.length }));
        } else if (req.url.includes("/comments") && req.method === "POST") {
          commentCounter++;
          res.end(JSON.stringify({ id: `comm-${commentCounter}`, body: parsed?.body || "" }));
        } else if (req.url.includes("/documents/") && req.method === "PUT") {
          docCounter++;
          res.end(JSON.stringify({ id: `doc-${docCounter}`, version: 1 }));
        } else if (req.url.startsWith("/api/issues/") && req.method === "PATCH") {
          res.end(JSON.stringify({ status: "ok" }));
        } else if (req.url.includes("/issues") && req.method === "POST") {
          issueCounter++;
          if (parsed) capturedIssues.push(parsed);
          res.end(JSON.stringify({ id: `iss-${issueCounter}`, identifier: `NORD-${issueCounter}`, title: parsed?.title || `Issue ${issueCounter}` }));
        } else {
          res.end(JSON.stringify({ status: "ok" }));
        }
      });
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });

    try {
      const report = await seedPaperclip({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "",
        passwords: ["MockPassUser1!", "MockPassUser2!"],
        concurrency: 50,
      });

      assert.equal(report.counts.companies, 2, "Should seed at least 2 companies");
      assert.ok(report.counts.projects >= 3, "Should seed at least 3 projects");
      assert.ok(report.counts.issues >= 200, "Should seed at least 200 issues");
      assert.ok(report.counts.comments >= 1000, "Should seed at least 1000 comments");
      assert.ok(report.counts.agents >= 6, "Should seed at least 6 agents");
      assert.ok(report.counts.agentsWithAppearance >= 6, "Should seed >= 6 agents with appearance");
      assert.ok(report.counts.issuesWithTitleNeedsGeneration >= 3, "Should seed >= 3 issues with title_needs_generation");
      assert.ok(report.counts.secrets >= 5, "Should seed at least 5 secrets");
      assert.equal(report.counts.users, 2, "Should seed 2 users");
      assert.ok(report.counts.documents >= 1, "Should seed documents");
      assert.ok(report.counts.documentRevisions >= 2, "Should seed document revisions");
      assert.ok(report.counts.attachments >= 1, "Should seed attachments");
      assert.ok(report.counts.largeAttachments >= 1, "Should seed large attachment > 2MB");

      // Verify issue payload format
      assert.equal(capturedIssues.length, 205);
      assert.ok(capturedIssues.every((issue) => issue.allowDuplicate === true));
      assert.ok(capturedIssues.every((issue) => !("titleNeedsGeneration" in issue)));



      // Verify agent appearance payload format
      assert.equal(capturedAgents.length, 6);
      assert.equal(capturedAgents[0].role, "engineer");
      assert.equal(capturedAgents[4].role, "designer");
      for (const ag of capturedAgents) {
        assert.equal(ag.adapterType, "process");
        assert.ok(ag.adapterConfig?.command);
        assert.ok(ag.appearance, "Agent must have appearance");
        assert.equal(ag.appearance.characterVersion, "cap-v1");
        assert.ok(ag.appearance.paletteId, "Agent must have paletteId");
      }

      // The vendor create schema rejects title-generation flags; do not send them.
      assert.ok(capturedIssues.every((iss) => !("titleNeedsGeneration" in iss)));
      assert.ok(capturedIssues.every((iss) => !("title_needs_generation" in iss)));

    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
