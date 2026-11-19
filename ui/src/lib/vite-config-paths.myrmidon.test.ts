import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("ui/vite.config.ts paths and aliases", () => {
  it("resolves @ and lexical aliases to absolute paths matching ui root", async () => {
    const configModulePath = "../../vite.config.ts";
    const viteConfigModule = (await import(/* @vite-ignore */ configModulePath)) as {
      default: (env: { command: "build" | "serve"; mode: string }) => {
        resolve?: {
          alias?: Record<string, string>;
        };
      };
    };

    const config = viteConfigModule.default({ command: "build", mode: "production" });
    const aliases = config.resolve?.alias ?? {};

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const expectedSrc = path.resolve(testDir, "../../src");
    const expectedLexical = path.resolve(
      testDir,
      "../../node_modules/lexical/dist/Lexical.mjs",
    );

    expect(aliases["@"]).toBe(expectedSrc);
    expect(aliases.lexical).toBe(expectedLexical);
  });
});
