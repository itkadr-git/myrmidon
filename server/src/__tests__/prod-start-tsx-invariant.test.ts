import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Production start invariant (OPE-12180, BOARD-START-BUNDLE Ч4).
 *
 * Since Ч2 (OPE-12188) the image must boot the compiled bundle with a bare
 * node process: no tsx, no loader.mjs, no `--import` preloads. A regression
 * that reintroduces tsx anywhere in the production start path would silently
 * re-couple the prod image to a TypeScript loader and hide "dist is not
 * self-sufficient" failures behind a dev-only dependency. The prod-boot smoke
 * in prod-boot-bundle.test.ts catches that at runtime; this suite pins the
 * declarative start files as plain-text invariants, so the regression is
 * caught even when dist is not built and without any docker/network.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const migrateScript = readFileSync(path.join(repoRoot, "scripts", "myrmidon-migrate"), "utf8");

/**
 * Extract executable JSON-array instructions (`CMD [...]`, `ENTRYPOINT [...]`)
 * from the Dockerfile, skipping the HEALTHCHECK curl command and shell-form
 * lines. Each instruction is the last-wins Docker directive, so the test reads
 * the same values the image runtime would.
 */
function lastExecFormInstruction(instruction: "CMD" | "ENTRYPOINT"): string | undefined {
  const matches = [...dockerfile.matchAll(new RegExp(`^\\s*${instruction}\\s+(\\[.*\\])\\s*$`, "gm"))];
  return matches.at(-1)?.[1];
}

function parseInstructionArgs(instruction: "CMD" | "ENTRYPOINT"): string[] {
  const raw = lastExecFormInstruction(instruction);
  expect(raw, `Dockerfile must declare an exec-form ${instruction}`).toBeDefined();
  const parsed: unknown = JSON.parse(raw as string);
  expect(Array.isArray(parsed), `exec-form ${instruction} must be a JSON array`).toBe(true);
  return parsed as string[];
}

function assertNoTsxSurface(where: string, tokens: string[]) {
  const forbidden = ["tsx", "loader.mjs", "--import", "--experimental-strip-types", "--loader"];
  for (const token of tokens) {
    for (const needle of forbidden) {
      expect(
        token.toLowerCase().includes(needle),
        `${where} must not route through a TypeScript loader: token '${token}' contains '${needle}'`,
      ).toBe(false);
    }
  }
}

describe("production start is tsx-free", () => {
  it("keeps Dockerfile CMD on a bare node entry of the compiled bundle", () => {
    const cmd = parseInstructionArgs("CMD");
    expect(cmd).toEqual(["node", "server/dist/index.js"]);
    assertNoTsxSurface("Dockerfile CMD", cmd);
  });

  it("keeps Dockerfile ENTRYPOINT on tini + docker-entrypoint.sh", () => {
    const entrypoint = parseInstructionArgs("ENTRYPOINT");
    expect(entrypoint).toEqual(["/usr/bin/tini", "--", "docker-entrypoint.sh"]);
    assertNoTsxSurface("Dockerfile ENTRYPOINT", entrypoint);
  });

  it("does not smuggle a TypeScript loader through Dockerfile env or build args", () => {
    const directiveLines = dockerfile
      .split("\n")
      .filter((line) => /^\s*(ENV|ARG|LABEL)\s/.test(line));
    assertNoTsxSurface("Dockerfile ENV/ARG/LABEL", directiveLines);
  });

  it("runs migrations from the compiled cli bundle, not tsx", () => {
    const lines = migrateScript.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
    const executed = lines.filter((line) => /exec\s|"[^"]*"|'[^']*'/.test(line)).join("\n");
    assertNoTsxSurface("scripts/myrmidon-migrate", lines);
    expect(executed).toContain("node dist/index.js");
    expect(executed).toContain("myrmidon:migrate");
  });
});
