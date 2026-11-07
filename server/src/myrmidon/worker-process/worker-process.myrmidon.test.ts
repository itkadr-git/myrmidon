// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the standalone
// worker entry. Pins:
//   * the entry statement is the role: with no role env it sets `worker`;
//   * an explicit `worker` is kept (the orchestrator launcher writes it, also
//     through the vendor PAPERCLIP_ alias);
//   * any other role refuses — a worker entry running as `all`/`api` would
//     double the background workload against the api processes;
//   * regression: the default launch (no role env) is still the single
//     process `all` — background work on, no loopback listener, no supervisor
//     role — i.e. the entry changes nothing for `index.ts`.

import { describe, expect, it } from "vitest";
import { processRole } from "../../services/process-role.js";
import { applyWorkerRole } from "./index.js";

describe("applyWorkerRole", () => {
  it("sets the worker role when none is configured", () => {
    const env: NodeJS.ProcessEnv = {};
    applyWorkerRole(env);
    expect(processRole(env).role).toBe("worker");
    const blank: NodeJS.ProcessEnv = { MYRMIDON_PROCESS_ROLE: "  " };
    applyWorkerRole(blank);
    expect(processRole(blank).role).toBe("worker");
  });

  it("keeps an explicit worker role, canonical or vendor alias", () => {
    expect(processRole(applyWorkerRole({ MYRMIDON_PROCESS_ROLE: "worker" })).role).toBe("worker");
    expect(processRole(applyWorkerRole({ PAPERCLIP_PROCESS_ROLE: "worker" })).role).toBe("worker");
  });

  it("refuses every other role", () => {
    for (const value of ["api", "all", "wroker"]) {
      expect(() => applyWorkerRole({ MYRMIDON_PROCESS_ROLE: value })).toThrow(/refusing to start/);
    }
    expect(() => applyWorkerRole({ PAPERCLIP_PROCESS_ROLE: "api" })).toThrow(/refusing to start/);
  });

  it("does not touch the default single-process profile of index.ts", () => {
    const profile = processRole({});
    expect(profile.role).toBe("all");
    expect(profile.source).toBe("default");
    expect(profile.runsBackground).toBe(true);
    expect(profile.executesRuns).toBe(true);
    expect(profile.loopbackListen).toBeNull();
    expect(profile.listen).toEqual({ host: null, port: null, reusePort: false });
  });
});
