import { describe, expect, it } from "vitest";
import { projectCodexWorkspaceDiffsFromTrace } from "./provider-trace-workspace-diff-reprojection.js";

function frame(frameId: number, payload: unknown) {
  return {
    kind: "frame",
    direction: "provider_to_client",
    frameId,
    rawBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}

function createdFile(path: string, additions: number) {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${additions} @@`,
    ...Array.from({ length: additions }, (_, index) => `+line ${index + 1}`),
  ].join("\n");
}

describe("provider trace workspace diff reprojection", () => {
  it("replays the minimized DOT-220 final snapshot as one seven-file event", () => {
    const turnId = "01a03964-9fa6-7550-a87e-b6acc72e372a";
    const first = createdFile("README.md", 9);
    const final = [
      createdFile("README.md", 9),
      createdFile("package.json", 1),
      createdFile("public/game.js", 17),
      createdFile("public/index.html", 2),
      createdFile("public/style.css", 1),
      createdFile("server.js", 6),
      createdFile("test/server.test.js", 5),
    ].join("\n");
    const projection = projectCodexWorkspaceDiffsFromTrace([
      frame(1, { method: "turn/diff/updated", params: { turnId, diff: first } }),
      frame(2, { method: "turn/diff/updated", params: { turnId, diff: final } }),
    ]);

    expect(projection.skipReasons).toEqual([]);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.payload).toMatchObject({
      changeSetId: `${turnId}:workspace`,
      revision: 2,
      source: "runner_verified",
      complete: true,
      totals: { files: 7, additions: 41, deletions: 0 },
    });
    expect(projection.turns[0]?.payload.files.map((file) => file.path)).toEqual([
      "README.md",
      "package.json",
      "public/game.js",
      "public/index.html",
      "public/style.css",
      "server.js",
      "test/server.test.js",
    ]);
  });

  it("keeps prior valid turns while reporting malformed snapshots", () => {
    const projection = projectCodexWorkspaceDiffsFromTrace([
      frame(1, {
        method: "turn/diff/updated",
        params: { turnId: "turn-1", diff: createdFile("src/a.ts", 1) },
      }),
      frame(2, {
        method: "turn/diff/updated",
        params: { turnId: "../../unsafe", diff: createdFile("src/b.ts", 1) },
      }),
      frame(3, {
        method: "turn/diff/updated",
        params: { turnId: "turn-2", diff: "not a unified patch" },
      }),
      frame(4, {
        method: "turn/diff/updated",
        params: { turnId: "turn-3", diff: "" },
      }),
    ]);

    expect(projection.turns.map((turn) => turn.turnId)).toEqual(["turn-1", "turn-3"]);
    expect(projection.skipReasons).toEqual([
      expect.objectContaining({ reason: "missing_turn_id", frameId: 2 }),
      expect.objectContaining({ reason: "malformed_diff", turnId: "turn-2", frameId: 3 }),
    ]);
  });

  it("reprojects an empty diff as an authoritative empty runner_verified snapshot", () => {
    const turnId = "01empty-diff-turn";
    const projection = projectCodexWorkspaceDiffsFromTrace([
      frame(1, {
        method: "turn/diff/updated",
        params: { turnId, diff: createdFile("src/first.ts", 1) },
      }),
      frame(2, {
        method: "turn/diff/updated",
        params: { turnId, diff: "" },
      }),
    ]);

    // The empty snapshot is kept, not skipped: an empty diff is the
    // provider's authoritative "nothing changed in this turn" state.
    expect(projection.skipReasons).toEqual([]);
    expect(projection.turns).toHaveLength(1);
    const payload = projection.turns[0]?.payload;
    expect(payload).toMatchObject({
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turnId}:workspace`,
      revision: 2,
      source: "runner_verified",
      complete: true,
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      patchArtifactRef: null,
    });
    expect(payload?.files).toEqual([]);
  });

  it("reprojects an empty-only trace without emitting malformed_diff", () => {
    const projection = projectCodexWorkspaceDiffsFromTrace([
      frame(1, {
        method: "turn/diff/updated",
        params: { turnId: "turn-empty", diff: "   \n\t  " },
      }),
      frame(2, {
        method: "turn/diff/updated",
        params: { turnId: "turn-empty", diff: "" },
      }),
    ]);

    expect(projection.skipReasons).toEqual([]);
    expect(projection.turns.map((turn) => turn.turnId)).toEqual(["turn-empty"]);
    expect(projection.turns[0]?.payload.revision).toBe(2);
    expect(projection.turns[0]?.payload.totals).toEqual({
      files: 0,
      additions: 0,
      deletions: 0,
    });
  });
});
