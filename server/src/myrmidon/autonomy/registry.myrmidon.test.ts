// myrmidon(1.6-AUTONOMY): the registry test guards the seams that enforce the matrix.
//
// Two acceptance criteria meet here:
//   1. every action class the matrix can hold is either enforced at a real seam
//      or listed in PENDING_ENFORCEMENT — a class cannot silently lose its point;
//   2. the registry reads each seam back out of the source, so removing the gate
//      call from a connected route turns this test red.
//
// The registry holds only points that exist on this tree; the source of a point
// is read from disk, repo-relative to this test file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTONOMY_ACTION_CLASSES, type AutonomyActionClass } from "@paperclipai/shared";
import {
  ACTION_EXECUTION_REGISTRY,
  PENDING_ENFORCEMENT,
  REGISTRY_EXEMPT_CLASSES,
  getAllActionClassesWithExecutionPoints,
  getExecutionPointsForAction,
  type ActionExecutionPoint,
} from "./registry.js";

/** This file lives in server/src/myrmidon/autonomy/, so four levels up is the repo root. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function readSeam(point: ActionExecutionPoint): string {
  return readFileSync(join(REPO_ROOT, point.source), "utf8");
}

function gateCallPattern(point: ActionExecutionPoint): RegExp {
  return new RegExp(`\\b${point.call}\\(\\s*req\\s*,\\s*"${point.actionClass}"\\s*\\)`);
}

const knownClasses = AUTONOMY_ACTION_CLASSES as readonly AutonomyActionClass[];
const pendingClasses = Object.keys(PENDING_ENFORCEMENT) as AutonomyActionClass[];

describe("autonomy matrix execution point registry", () => {
  it("covers every class: enforced at a seam, or pending with a reason", () => {
    const seen = new Set<AutonomyActionClass>([
      ...getAllActionClassesWithExecutionPoints(),
      ...pendingClasses,
    ]);
    const uncovered = knownClasses.filter(
      (actionClass) => !REGISTRY_EXEMPT_CLASSES.includes(actionClass) && !seen.has(actionClass),
    );
    expect(uncovered).toEqual([]);
  });

  it("enforces every class the registry names", () => {
    for (const actionClass of getAllActionClassesWithExecutionPoints()) {
      expect(getExecutionPointsForAction(actionClass).length).toBeGreaterThan(0);
    }
  });

  it("keeps the registry and the pending list disjoint", () => {
    const registered = new Set(getAllActionClassesWithExecutionPoints());
    expect(pendingClasses.filter((actionClass) => registered.has(actionClass))).toEqual([]);
  });

  it("names no class outside the matrix contract", () => {
    const known = new Set<AutonomyActionClass>(knownClasses);
    const unknown = [
      ...getAllActionClassesWithExecutionPoints(),
      ...pendingClasses,
    ].filter((actionClass) => !known.has(actionClass));
    expect(unknown).toEqual([]);
  });

  it("reads a real gate call out of the source of every execution point", () => {
    // This is the guard: delete gate <call>(req, "<class>") from a connected
    // route and the registry stops matching its seam, so the test fails.
    for (const point of ACTION_EXECUTION_REGISTRY) {
      const source = readSeam(point);
      expect(source.length, `${point.source} is empty`).toBeGreaterThan(0);
      expect(
        gateCallPattern(point).test(source),
        `${point.source} must call ${point.call}(req, "${point.actionClass}")`,
      ).toBe(true);
    }
  });

  it("gives every pending class a reason", () => {
    for (const actionClass of pendingClasses) {
      expect(PENDING_ENFORCEMENT[actionClass], actionClass).toBeTruthy();
    }
  });
});