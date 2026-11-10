import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

/**
 * 1.7 PRIVATE-TASKS E2 ratchet: issue loading in `routes/issues.ts` must go
 * through `getAccessibleIssue` (the loader that hides `isPrivate` issues from
 * agent actors), not straight through `getAccessibleResource`.
 *
 * Route handlers may still call `getAccessibleResource` only for non-issue
 * resources (labels, work products, attachments). The allowlist below pins
 * those five calls; everything else loading an issue with `svc.getById(...)` /
 * `getIssueById(...)` is a regression.
 */
describe("issue routes private-loader ratchet (1.7 PRIVATE-TASKS E2)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../routes/issues.ts", import.meta.url)),
    "utf8",
  );

  /** Collapse whitespace so multi-line calls match the same way single-line ones do. */
  const normalized = source.replace(/\s+/g, " ");

  it("never loads an issue via bare getAccessibleResource", () => {
    const offenders = [
      ...normalized.matchAll(
        /getAccessibleResource\( req , res , (svc\.getById\([^()]*\)|getIssueById\( req , [^()]*\)) ,/g,
      ),
    ].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  it("documents every remaining getAccessibleResource call as non-issue", () => {
    const calls = [
      ...normalized.matchAll(/getAccessibleResource\(([^()]*(?:\([^()]*\)[^()]*)?)\)/g),
    ].map((m) => m[1].replace(/\s+/g, " ").trim());
    // The helper itself + the five non-issue loaders (labels, work products x2,
    // attachments x2).
    expect(calls.length).toBe(6);
    for (const args of calls) {
      const fetcher = args.split(",")[2]?.trim() ?? "";
      expect(
        ["issue", "svc.getLabelById(labelId)", "workProductsSvc.getById(id)", "svc.getAttachmentById(attachmentId)"],
        `unexpected getAccessibleResource fetcher: ${fetcher}`,
      ).toContain(fetcher === "issue" ? "issue" : fetcher);
    }
  });

  it("routes issue loads through the private-aware getAccessibleIssue helper", () => {
    const count = [
      ...normalized.matchAll(/await getAccessibleIssue\(\s?req, res,/g),
    ].length;
    // 76 direct issue-loader routes. Pin the floor: a regression that swaps
    // back to bare loads fails the assertions above; this pins the helper's
    // existence so deleting it cannot slip through silently.
    expect(count).toBeGreaterThanOrEqual(76);
  });
});
