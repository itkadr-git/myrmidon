// myrmidon(TRACING-HEALTH) registry guard: app-plugin exports the tracing
// health routes and app.ts mounts the route under /api.
//
// Guard recipe: source-level checks on app.ts and the registry (no server
// boot). The red side is proven by stashing the app.ts change (the module
// alone compiles without it): `git stash push -- server/src/app.ts` and
// re-running this file — both assertions fail.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// app.ts lives at src/app.ts (two levels up from this module).
const appSource = readFileSync(path.resolve(__dirname, "../../app.ts"), "utf8");
const pluginSource = readFileSync(path.resolve(__dirname, "../app-plugin.ts"), "utf8");

describe("myrmidon(TRACING-HEALTH) app wiring", () => {
  it("the registry exports tracing health and app.ts mounts the registry", () => {
    expect(pluginSource).toContain('export { myrmidonTracingHealthRoutes } from "./tracing-health/index.js";');
    expect(appSource).toContain('} from "./myrmidon/app-plugin.js";');
    expect(appSource).toMatch(/api\.use\(myrmidonTracingHealthRoutes\(db\)\)/);
  });

  it("the wiring is exactly one import and one mount (the shared one-line integration point)", () => {
    expect(appSource.match(/myrmidonTracingHealthRoutes/g)).toHaveLength(1);
  });
});
