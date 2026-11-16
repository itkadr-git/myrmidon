import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchAgentDecommissionState } from "./host-clone-cache-gc.mjs";

const id = "e0d04e36-1111-4222-8333-444455556666";
const lookup = (body) => fetchAgentDecommissionState(id, {
  baseUrl: "http://board.invalid",
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
});

describe("decommission response validation", () => {
  for (const body of [
    { status: "", adapterType: "omp_local" },
    { status: "not-a-status", adapterType: "omp_local" },
    { status: "idle", adapterType: "" },
    { status: "terminated", adapterType: "   " },
    { status: "unknown", adapterType: "hermes_gateway" },

  ]) {
    it(`fails closed for ${JSON.stringify(body)}`, async () => {
      assert.deepEqual(await lookup(body), { ok: false, reason: "board-unavailable" });
    });
  }

  for (const status of ["active", "paused", "idle", "running", "error", "pending_approval", "terminated"]) {
    it(`preserves valid status ${status}`, async () => {
      const state = status === "terminated" ? "terminated" : status === "running" ? "running" : "left_hermes_gateway";
      assert.deepEqual(await lookup({ status, adapterType: "omp_local" }), { ok: true, state });
    });
  }
});
