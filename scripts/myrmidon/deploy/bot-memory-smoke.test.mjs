import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "bot-memory-smoke.sh");

function makeSandbox() {
  const tmpRoot = process.env.TMPDIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(tmpRoot, "myrmidon-bot-memory-smoke-test-"));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function runScript(args, options = {}) {
  return spawnSync(SCRIPT_PATH, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env
    },
    input: options.input
  });
}

function runScriptAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SCRIPT_PATH, args, {
      env: {
        ...process.env,
        ...options.env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, stdout, stderr });
    });
  });
}

describe("bot-memory-smoke.sh (OPE-8425)", () => {
  it("prints help message with -h", () => {
    const res = runScript(["-h"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Reproducible, read-only smoke verification/);
    assert.match(res.stdout, /State\.OOMKilled/);
    assert.match(res.stdout, /HostConfig\.Memory/);
  });

  it("supports dry-run mode without inspecting anything", () => {
    const res = runScript(["--dry-run", "--default-mem-mb", "1024"]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /DRY RUN PLAN/);
    assert.match(res.stderr, /Default Memory:\s+1024 MiB/);
    assert.match(res.stderr, /Guaranteed Read-Only: YES/);
  });

  it("passes when all bot containers have OOMKilled=false and matching memory limits", () => {
    const sb = makeSandbox();
    try {
      const manifest = [
        { id: "bot-1", name: "eng-1", targetMemoryMb: 1024, isContainer: true },
        { id: "bot-2", name: "eng-2", targetMemoryMb: 1536, isContainer: true }
      ];
      const manifestPath = path.join(sb.dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const inspectDump = [
        {
          Id: "c1",
          Name: "/myrmidon-bot-bot-1",
          State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
          HostConfig: { Memory: 1024 * 1024 * 1024 },
          Config: { Labels: { "com.paperclip.bot-key": "bot-1", "com.paperclip.agent-name": "eng-1" } }
        },
        {
          Id: "c2",
          Name: "/myrmidon-bot-bot-2",
          State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
          HostConfig: { Memory: 1536 * 1024 * 1024 },
          Config: { Labels: { "com.paperclip.bot-key": "bot-2", "com.paperclip.agent-name": "eng-2" } }
        }
      ];
      const inspectPath = path.join(sb.dir, "inspect.json");
      fs.writeFileSync(inspectPath, JSON.stringify(inspectDump));

      const jsonOutPath = path.join(sb.dir, "out.json");
      const tableOutPath = path.join(sb.dir, "out.md");

      const res = runScript([
        "--input", inspectPath,
        "--manifest", manifestPath,
        "--json-out", jsonOutPath,
        "--table-out", tableOutPath
      ]);

      assert.equal(res.status, 0, `Script failed unexpectedly: ${res.stderr}\n${res.stdout}`);
      assert.match(res.stdout, /Overall Smoke Verdict:\s+PASSED \[OK\]/);
      assert.match(res.stdout, /State\.OOMKilled Check:\s+PASSED/);
      assert.match(res.stdout, /HostConfig\.Memory Check:\s+PASSED/);

      // Verify JSON report
      const jsonReport = JSON.parse(fs.readFileSync(jsonOutPath, "utf8"));
      assert.equal(jsonReport.verdict, "PASS");
      assert.equal(jsonReport.readOnly, true);
      assert.equal(jsonReport.summary.oomKilledCount, 0);
      assert.equal(jsonReport.summary.memoryMismatchCount, 0);
      assert.equal(jsonReport.summary.missingCount, 0);
      assert.equal(jsonReport.summary.containerBotsChecked, 2);

      // Verify Table report exists and contains headers
      const tableContent = fs.readFileSync(tableOutPath, "utf8");
      assert.match(tableContent, /MYRMIDON BOT MEMORY & OOMKILLED SMOKE REPORT/);
      assert.match(tableContent, /eng-1/);
      assert.match(tableContent, /eng-2/);
    } finally {
      sb.cleanup();
    }
  });

  it("fails when a bot container has State.OOMKilled = true", () => {
    const sb = makeSandbox();
    try {
      const manifest = [
        { id: "bot-1", name: "eng-1", targetMemoryMb: 1024, isContainer: true }
      ];
      const manifestPath = path.join(sb.dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const inspectDump = [
        {
          Id: "c1",
          Name: "/myrmidon-bot-bot-1",
          State: { Status: "exited", Running: false, OOMKilled: true, ExitCode: 137 },
          HostConfig: { Memory: 1024 * 1024 * 1024 },
          Config: { Labels: { "com.paperclip.bot-key": "bot-1", "com.paperclip.agent-name": "eng-1" } }
        }
      ];
      const inspectPath = path.join(sb.dir, "inspect.json");
      fs.writeFileSync(inspectPath, JSON.stringify(inspectDump));

      const res = runScript([
        "--input", inspectPath,
        "--manifest", manifestPath
      ]);

      assert.equal(res.status, 1, "Script must exit 1 when OOMKilled is true");
      assert.match(res.stdout, /FAIL_OOMKILLED/);
      assert.match(res.stdout, /State\.OOMKilled Check:\s+FAILED/);
      assert.match(res.stdout, /Total OOMKilled:\s+1/);
    } finally {
      sb.cleanup();
    }
  });

  it("fails when a bot container has a memory limit mismatch (e.g. still 4GiB instead of 1GiB)", () => {
    const sb = makeSandbox();
    try {
      const manifest = [
        { id: "bot-1", name: "eng-1", targetMemoryMb: 1024, isContainer: true }
      ];
      const manifestPath = path.join(sb.dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const inspectDump = [
        {
          Id: "c1",
          Name: "/myrmidon-bot-bot-1",
          State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
          HostConfig: { Memory: 4096 * 1024 * 1024 }, // 4096 MiB instead of 1024 MiB
          Config: { Labels: { "com.paperclip.bot-key": "bot-1", "com.paperclip.agent-name": "eng-1" } }
        }
      ];
      const inspectPath = path.join(sb.dir, "inspect.json");
      fs.writeFileSync(inspectPath, JSON.stringify(inspectDump));

      const res = runScript([
        "--input", inspectPath,
        "--manifest", manifestPath
      ]);

      assert.equal(res.status, 1, "Script must exit 1 when memory mismatch is detected");
      assert.match(res.stdout, /FAIL_MEMORY_MISMATCH/);
      assert.match(res.stdout, /Memory Fact\s+\|\s+Expected/);
      assert.match(res.stdout, /4096 MiB\s+\|\s+1024 MiB/);
      assert.match(res.stdout, /HostConfig\.Memory Check:\s+FAILED/);
    } finally {
      sb.cleanup();
    }
  });

  it("fails when an expected bot container is missing on host", () => {
    const sb = makeSandbox();
    try {
      const manifest = [
        { id: "bot-1", name: "eng-1", targetMemoryMb: 1024, isContainer: true },
        { id: "bot-missing", name: "missing-bot", targetMemoryMb: 1024, isContainer: true }
      ];
      const manifestPath = path.join(sb.dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const inspectDump = [
        {
          Id: "c1",
          Name: "/myrmidon-bot-bot-1",
          State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
          HostConfig: { Memory: 1024 * 1024 * 1024 },
          Config: { Labels: { "com.paperclip.bot-key": "bot-1", "com.paperclip.agent-name": "eng-1" } }
        }
      ];
      const inspectPath = path.join(sb.dir, "inspect.json");
      fs.writeFileSync(inspectPath, JSON.stringify(inspectDump));

      const res = runScript([
        "--input", inspectPath,
        "--manifest", manifestPath
      ]);

      assert.equal(res.status, 1, "Script must exit 1 when a bot container is missing");
      assert.match(res.stdout, /FAIL_MISSING/);
      assert.match(res.stdout, /Missing Containers:\s+1/);
    } finally {
      sb.cleanup();
    }
  });

  it("correctly identifies and skips non-container bots with SKIPPED verdict", () => {
    const sb = makeSandbox();
    try {
      const manifest = [
        { id: "bot-1", name: "eng-1", targetMemoryMb: 1024, isContainer: true },
        { id: "local-agent", name: "adm-local", adapterType: "antigravity_local", isContainer: false }
      ];
      const manifestPath = path.join(sb.dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const inspectDump = [
        {
          Id: "c1",
          Name: "/myrmidon-bot-bot-1",
          State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
          HostConfig: { Memory: 1024 * 1024 * 1024 },
          Config: { Labels: { "com.paperclip.bot-key": "bot-1", "com.paperclip.agent-name": "eng-1" } }
        }
      ];
      const inspectPath = path.join(sb.dir, "inspect.json");
      fs.writeFileSync(inspectPath, JSON.stringify(inspectDump));

      const res = runScript([
        "--input", inspectPath,
        "--manifest", manifestPath
      ]);

      assert.equal(res.status, 0, "Non-container agents must not fail the smoke check");
      assert.match(res.stdout, /SKIPPED/);
      assert.match(res.stdout, /Non-Container Skipped:\s+1/);
    } finally {
      sb.cleanup();
    }
  });

  it("reads inspect JSON from stdin using --input -", () => {
    const inspectDump = [
      {
        Id: "c1",
        Name: "/myrmidon-bot-adm-dev-eng-8",
        State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
        HostConfig: { Memory: 1536 * 1024 * 1024 },
        Config: { Labels: { "com.paperclip.bot-key": "adm-dev-eng-8", "com.paperclip.agent-name": "adm-dev-eng-8" } }
      }
    ];

    const res = runScript(["--input", "-"], {
      input: JSON.stringify(inspectDump)
    });

    assert.equal(res.status, 0);
    assert.match(res.stdout, /adm-dev-eng-8/);
    assert.match(res.stdout, /1536 MiB/);
    assert.match(res.stdout, /PASSED \[OK\]/);
  });

  it("works with a fake docker binary in PATH", () => {
    const sb = makeSandbox();
    try {
      const binDir = path.join(sb.dir, "bin");
      fs.mkdirSync(binDir, { recursive: true });

      const fakeDocker = `#!/usr/bin/env bash
if [[ "$1" == "ps" ]]; then
  echo "myrmidon-bot-bot-1"
elif [[ "$1" == "inspect" ]]; then
  cat <<'EOF'
[
  {
    "Id": "c1",
    "Name": "/myrmidon-bot-bot-1",
    "State": { "Status": "running", "Running": true, "OOMKilled": false, "ExitCode": 0 },
    "HostConfig": { "Memory": 1073741824 },
    "Config": { "Labels": { "com.paperclip.bot-key": "bot-1", "com.paperclip.agent-name": "bot-1" } }
  }
]
EOF
fi
`;
      const fakeDockerPath = path.join(binDir, "docker");
      fs.writeFileSync(fakeDockerPath, fakeDocker, { mode: 0o755 });

      const res = runScript(["--docker-bin", fakeDockerPath], {
        env: {
          BASH_ENV: ""
        }
      });

      assert.equal(res.status, 0);
      assert.match(res.stdout, /PASSED \[OK\]/);
      assert.match(res.stdout, /1024 MiB/);
    } finally {
      sb.cleanup();
    }
  });

  it("resolves auth header from --token-file and queries board API without leaking token", async () => {
    const sb = makeSandbox();
    let server;
    try {
      const mockToken = "mock-smoke-board-token-ok";
      const tokenFile = path.join(sb.dir, "board.token");
      fs.writeFileSync(tokenFile, `  ${mockToken}  \r\n`);

      let receivedAuthHeader = "";
      server = http.createServer((req, res) => {
        receivedAuthHeader = req.headers["authorization"] || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([
          { id: "adm-dev-eng-8", name: "adm-dev-eng-8", adapterType: "hermes_gateway" }
        ]));
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();

      const inspectDump = [
        {
          Id: "c1",
          Name: "/myrmidon-bot-adm-dev-eng-8",
          State: { Status: "running", Running: true, OOMKilled: false, ExitCode: 0 },
          HostConfig: { Memory: 1536 * 1024 * 1024 },
          Config: { Labels: { "com.paperclip.bot-key": "adm-dev-eng-8", "com.paperclip.agent-name": "adm-dev-eng-8" } }
        }
      ];
      const inspectPath = path.join(sb.dir, "inspect.json");
      fs.writeFileSync(inspectPath, JSON.stringify(inspectDump));

      const res = await runScriptAsync([
        "--board-url", `http://127.0.0.1:${port}`,
        "--company", "company-test",
        "--token-file", tokenFile,
        "--input", inspectPath
      ]);

      assert.equal(res.status, 0, `Script failed unexpectedly: ${res.stderr}\n${res.stdout}`);
      assert.equal(receivedAuthHeader, `Bearer ${mockToken}`);
      assert.equal(res.stdout.includes(mockToken), false, "stdout must not disclose token");
      assert.equal(res.stderr.includes(mockToken), false, "stderr must not disclose token");
      assert.match(res.stdout, /adm-dev-eng-8/);
      assert.match(res.stdout, /PASSED \[OK\]/);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      sb.cleanup();
    }
  });

  it("fails with exit code 2 when --token-file does not exist", () => {
    const sb = makeSandbox();
    try {
      const nonExistent = path.join(sb.dir, "missing.token");
      const res = runScript(["--token-file", nonExistent]);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Token file not readable/);
    } finally {
      sb.cleanup();
    }
  });

  it("fails with exit code 2 when --token-file is empty", () => {
    const sb = makeSandbox();
    try {
      const emptyFile = path.join(sb.dir, "empty.token");
      fs.writeFileSync(emptyFile, "   \n\r\n  ");
      const res = runScript(["--token-file", emptyFile]);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Token file is empty/);
    } finally {
      sb.cleanup();
    }
  });
});
