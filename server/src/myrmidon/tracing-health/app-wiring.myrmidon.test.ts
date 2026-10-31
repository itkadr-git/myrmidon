import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as appPlugin from "../app-plugin.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("myrmidon(TRACING-HEALTH) app wiring", () => {
  it("exports tracing health routes through the app-plugin registry", () => {
    expect(appPlugin.myrmidonTracingHealthRoutes).toBeTypeOf("function");
  });

  it("mounts tracing health routes in server/src/app.ts via app-plugin", () => {
    const appSource = readFileSync(
      resolve(__dirname, "../../app.ts"),
      "utf8",
    );
    expect(appSource).toMatch(
      /api\.use\(myrmidonTracingHealthRoutes\(db\)\); \/\/ myrmidon\(TRACING-HEALTH\)/,
    );
    expect(appSource.match(/myrmidonTracingHealthRoutes/g)).toHaveLength(2);
  });
});
