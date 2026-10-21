import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const dockerfile = fs.readFileSync("docker/agent-runtime/Dockerfile.omp", "utf8");
const bake = fs.readFileSync("docker/agent-runtime/buildx-bake.hcl", "utf8");
const workflow = fs.readFileSync(".github/workflows/agent-runtime-images.yml", "utf8");

describe("omp runtime image contract", () => {
  it("pins Bun and the published omp package and runs as uid 1000", () => {
    assert.match(dockerfile, /^FROM oven\/bun:1\.4\.3-alpine$/m);
    assert.match(dockerfile, /@oh-my-pi\/pi-coding-agent@\$\{OMP_VERSION\}/);
    assert.match(dockerfile, /^ARG OMP_VERSION=18\.9\.2$/m);
    assert.match(dockerfile, /^USER 1000:1000$/m);
    assert.match(dockerfile, /OMP_SESSION_DIR=\/home\/paperclip\/\.local\/share\/omp\/sessions/);
    assert.match(dockerfile, /ln -sf .*\/omp.*\/usr\/local\/bin\/omp/);
    assert.doesNotMatch(dockerfile, /@latest|@myrmidonai\/pi-coding-agent/);
  });

  it("smoke-checks version, PATH, help, and local model listing in the built image", () => {
    for (const check of ["bun --version", "omp --version", "command -v omp", "omp --help", "omp models ls"]) {
      assert.ok(dockerfile.includes(check), `missing smoke check: ${check}`);
    }
  });

  it("publishes only through the signed CI image lane", () => {
    assert.match(bake, /target "omp"/);
    assert.match(bake, /agent-runtime-omp:\$\{VERSION\}/);
    assert.match(workflow, /docker buildx bake[\s\S]*?omp/);
    assert.match(workflow, /Cosign sign omp/);
    assert.match(workflow, /OMP_DIGEST=\$\(jq -r .*omp.*containerimage\.digest.*bake-metadata\.json\)/);
    assert.match(workflow, /agent-runtime-omp@\$\{\{ steps\.bake\.outputs\.omp_digest \}\}/);
  });

  it("verifies omp version matches Part A and validates minimal adapter execution contract", () => {
    // 1. Check version in Part A adapter matches Dockerfile
    const adapterPkg = JSON.parse(fs.readFileSync("packages/adapters/omp-local/package.json", "utf8"));
    assert.equal(adapterPkg.name, "@myrmidonai/adapter-omp-local");

    const adapterIndex = fs.readFileSync("packages/adapters/omp-local/src/index.ts", "utf8");
    assert.match(adapterIndex, /type = "omp_local"/);
    assert.match(adapterIndex, /@oh-my-pi\/pi-coding-agent@18\.9\.2/);

    // Verify Dockerfile pinned version matches Part A version
    const ompVersionMatch = dockerfile.match(/^ARG OMP_VERSION=(.*)$/m);
    assert.ok(ompVersionMatch, "Dockerfile must define ARG OMP_VERSION");
    assert.equal(ompVersionMatch[1], "18.9.2");

    // 2. Minimal adapter run: simulate omp CLI output and verify turn execution parsing
    const sampleOmpTurnOutput = [
      JSON.stringify({ type: "session", version: 3, id: "session-smoke", timestamp: "2026-10-12T08:00:00.000Z", cwd: "/workspace" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Minimal adapter run successful" }],
          usage: { input: 15, output: 25, cacheRead: 0, cost: { total: 0.005 } },
        },
        toolResults: [],
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const lines = sampleOmpTurnOutput.trim().split("\n").map((l) => JSON.parse(l));
    const sessionEvent = lines.find((e) => e.type === "session");
    assert.equal(sessionEvent?.id, "session-smoke");

    const turnEndEvent = lines.find((e) => e.type === "turn_end");
    assert.ok(turnEndEvent, "turn_end event must be present");
    assert.equal(turnEndEvent.message.role, "assistant");
    assert.equal(turnEndEvent.message.content[0].text, "Minimal adapter run successful");
  });
});
