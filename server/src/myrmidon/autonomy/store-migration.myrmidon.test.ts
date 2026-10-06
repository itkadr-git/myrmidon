// server/src/myrmidon/autonomy/store-migration.myrmidon.test.ts
//
// Verifies the deploy-default migration: a stored document that still has
// deploy: allowed (the pre-1.6.2 factory default) is lifted to
// approval_required on read, unless an explicit rule already covers deploy.

import { describe, expect, it } from "vitest";
import { parseAutonomyDocument, emptyAutonomyDocument } from "./store.js";
import { AUTONOMY_SAFE_DEFAULTS } from "@paperclipai/shared";

describe("autonomy store migration (deploy default)", () => {
  it("lifts stored deploy:allowed to approval_required when no rule overrides it", () => {
    const stored = {
      version: 1,
      matrix: {
        version: 1,
        rules: [],
        defaults: {
          merge: "allowed",
          deploy: "allowed", // legacy factory default
          spend_above_threshold: "allowed",
          external_message: "allowed",
          delete: "allowed",
          pause_wake_agents: "allowed",
          change_instructions: "allowed",
          other: "allowed",
        },
      },
      regulations: [],
    };
    const doc = parseAutonomyDocument(stored);
    expect(doc.matrix.defaults.deploy).toBe("approval_required");
  });

  it("keeps deploy:allowed when an explicit rule exists for deploy", () => {
    const stored = {
      version: 1,
      matrix: {
        version: 2,
        rules: [
          {
            id: "rule-1",
            actionClass: "deploy",
            subjectKind: "role",
            subject: "engineer",
            verdict: "allowed",
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        defaults: {
          merge: "allowed",
          deploy: "allowed",
          spend_above_threshold: "allowed",
          external_message: "allowed",
          delete: "allowed",
          pause_wake_agents: "allowed",
          change_instructions: "allowed",
          other: "allowed",
        },
      },
      regulations: [],
    };
    const doc = parseAutonomyDocument(stored);
    expect(doc.matrix.defaults.deploy).toBe("allowed");
  });

  it("does not change a stored deploy:forbidden", () => {
    const stored = {
      version: 1,
      matrix: {
        version: 1,
        rules: [],
        defaults: {
          merge: "allowed",
          deploy: "forbidden",
          spend_above_threshold: "allowed",
          external_message: "allowed",
          delete: "allowed",
          pause_wake_agents: "allowed",
          change_instructions: "allowed",
          other: "allowed",
        },
      },
      regulations: [],
    };
    const doc = parseAutonomyDocument(stored);
    expect(doc.matrix.defaults.deploy).toBe("forbidden");
  });

  it("does not change a stored deploy:approval_required", () => {
    const stored = {
      version: 1,
      matrix: {
        version: 1,
        rules: [],
        defaults: {
          merge: "allowed",
          deploy: "approval_required",
          spend_above_threshold: "allowed",
          external_message: "allowed",
          delete: "allowed",
          pause_wake_agents: "allowed",
          change_instructions: "allowed",
          other: "allowed",
        },
      },
      regulations: [],
    };
    const doc = parseAutonomyDocument(stored);
    expect(doc.matrix.defaults.deploy).toBe("approval_required");
  });

  it("empty document gets the new factory default", () => {
    const doc = parseAutonomyDocument(undefined);
    expect(doc.matrix.defaults.deploy).toBe("approval_required");
    expect(doc.matrix.defaults.deploy).toBe(AUTONOMY_SAFE_DEFAULTS.deploy);
  });

  it("emptyAutonomyDocument returns the new factory default", () => {
    const doc = emptyAutonomyDocument();
    expect(doc.matrix.defaults.deploy).toBe("approval_required");
  });
});
