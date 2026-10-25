// myrmidon(TRACING-HEALTH) registry guard: the public route must remain
// exported from the app-plugin facade used by the server entry point.

import { describe, expect, it } from "vitest";
import * as appPlugin from "../app-plugin.js";

describe("myrmidon(TRACING-HEALTH) app wiring", () => {
  it("exports the tracing health route through the app-plugin registry", () => {
    expect(appPlugin.myrmidonTracingHealthRoutes).toBeTypeOf("function");
  });
});
