// myrmidon(1.7-METRICS): wiring guard. The endpoint must be reachable from
// the server entry point: one import behind the 1.7-METRICS marker and one
// origin-root mount of the router. This suite is red when the module is
// missing or the entry point lost its wiring — the "guard test is red
// without the module, green with it" acceptance case: cutting the module
// removes the import, and this file then fails to resolve it.

import { describe, expect, it } from "vitest";
import { myrmidonMetricsApp, METRICS_TOKEN_ENV, METRICS_TOKEN_SECRET_ENV } from "./index.js";
import * as appPlugin from "../../app-plugin.js";

describe("metrics wiring guard", () => {
  it("exports the root metrics app through the app-plugin registry", () => {
    expect(appPlugin.myrmidonMetricsApp).toBe(myrmidonMetricsApp);
    expect(appPlugin.myrmidonMetricsApp).toBeTypeOf("function");
  });

  it("the token settings are documented in SETTINGS.md", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../../docs/myrmidon/SETTINGS.md", import.meta.url)),
      "utf8",
    );
    expect(text).toContain(METRICS_TOKEN_SECRET_ENV);
    expect(text).toContain(METRICS_TOKEN_ENV);
  });

  it("the module is registered in the DIVERGENCE.md divergence registry", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../../../../docs/myrmidon/DIVERGENCE.md", import.meta.url)),
      "utf8",
    );
    expect(text).toContain("1.7-METRICS");
  });

  it("the app builder returns a router", () => {
    // A bare in-memory stand-in: the router is stateless, no db read happens
    // at construction time.
    const router = myrmidonMetricsApp({} as never);
    expect(typeof router).toBe("function");
  });

  it("the router carries the scrape endpoint and the self-check probe", () => {
    const router = myrmidonMetricsApp({} as never) as {
      stack: Array<{ route?: { path: string } }>;
    };
    const paths = router.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route!.path);
    expect(paths).toContain("/metrics");
    // 1.6.6 annex: every link of the chain self-checks — the probe rides the
    // same origin-root router under the canonical /api path.
    expect(paths).toContain("/api/myrmidon/monitoring/selfcheck");
  });
});
