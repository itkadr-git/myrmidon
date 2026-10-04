// server/src/myrmidon/vendor-name/scan.ts
//
// myrmidon(1.7-REBRAND-F): what the instance sees when it asks the vendor-name
// gate about its own build.
//
// The rule (the token, the exception list, the baselines) lives in ONE place:
// `scripts/myrmidon/vendor-name/check-vendor-name.mjs` plus its policy file in
// the repository, the same pair CI runs. This module does not re-implement it —
// a second copy in TypeScript would drift from the gate that actually fails a
// build. It runs the script and reads its JSON report.
//
// When the running server has no repository next to it (a published image
// carries `server/ui-dist`, not `scripts/`), the scan reports `available: false`
// with the reason: the settings still work, the count simply is not this
// deployment's business to compute.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VendorNameCheckMode, VendorNameCheckSettingSource } from "@paperclipai/shared";

/** Repository-relative paths of the gate and its policy. */
export const VENDOR_NAME_CHECK_SCRIPT = "scripts/myrmidon/vendor-name/check-vendor-name.mjs";
export const VENDOR_NAME_CHECK_POLICY = "scripts/myrmidon/vendor-name/vendor-name-policy.json";

/** One scanned target, as the report carries it. */
export interface VendorNameScanTarget {
  name: string;
  dir: string;
  status: "ok" | "violation" | "missing";
  visible: number;
  identifier: number;
  baseline: number;
  mode: VendorNameCheckMode;
  modeSource: VendorNameCheckSettingSource | "policy" | "flag";
  files: number;
  detail: Array<{ file: string; visible: number; identifier: number; line: number }>;
}

export interface VendorNameScanAvailable {
  available: true;
  root: string;
  script: string;
  policyPath: string;
  mode: VendorNameCheckMode;
  modeSource: VendorNameCheckSettingSource | "policy" | "flag";
  exitCode: number;
  status: "ok" | "violation";
  targets: VendorNameScanTarget[];
  totals: { visible: number; identifier: number };
}

export interface VendorNameScanUnavailable {
  available: false;
  reason: "no_repository" | "script_failed" | "report_unreadable";
  detail: string;
  script: string;
}

export type VendorNameScanResult = VendorNameScanAvailable | VendorNameScanUnavailable;

/** Where the gate's own files may sit, in order of preference. */
function repoRootCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Monorepo layout: server/src/myrmidon/vendor-name → repository root.
    path.resolve(here, "../../../.."),
    // A server started from the repository root (dev-runner, pnpm scripts).
    process.cwd(),
  ];
}

/** The first candidate that carries the policy file, or null. */
export function resolveVendorNameCheckRoot(
  candidates: string[] = repoRootCandidates(),
  exists: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
): string | null {
  for (const candidate of candidates) {
    if (exists(path.join(candidate, VENDOR_NAME_CHECK_POLICY))) return candidate;
  }
  return null;
}

interface GateReport {
  mode?: unknown;
  modeSource?: unknown;
  exitCode?: unknown;
  totals?: unknown;
  targets?: unknown;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Runs the gate and returns its report; never throws. */
export async function scanVendorName(
  options: { root?: string | null; timeoutMs?: number } = {},
): Promise<VendorNameScanResult> {
  const root = options.root === undefined ? resolveVendorNameCheckRoot() : options.root;
  if (!root) {
    return {
      available: false,
      reason: "no_repository",
      detail: "the running server has no repository with the vendor-name policy next to it",
      script: VENDOR_NAME_CHECK_SCRIPT,
    };
  }
  const script = path.join(root, VENDOR_NAME_CHECK_SCRIPT);
  const reportPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-vendor-name-")),
    "report.json",
  );
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    ({ stdout, stderr, exitCode } = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve, reject) => {
      execFile(
        process.execPath,
        [script, "--json", reportPath],
        { cwd: root, timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
        (error, out, err) => {
          const code =
            typeof (error as { code?: unknown } | null)?.code === "number"
              ? ((error as { code: number }).code as number)
              : 0;
          if (error && code === 0) {
            reject(error);
            return;
          }
          resolve({ stdout: out ?? "", stderr: err ?? "", exitCode: code });
        },
      );
    }));
  } catch (error) {
    return {
      available: false,
      reason: "script_failed",
      detail: error instanceof Error ? error.message : String(error),
      script: VENDOR_NAME_CHECK_SCRIPT,
    };
  }

  let report: GateReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as GateReport;
  } catch (error) {
    return {
      available: false,
      reason: "report_unreadable",
      detail: [stderr.trim(), stdout.trim(), error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 500),
      script: VENDOR_NAME_CHECK_SCRIPT,
    };
  } finally {
    fs.rmSync(path.dirname(reportPath), { recursive: true, force: true });
  }

  const targets = (Array.isArray(report.targets) ? report.targets : []).map((entry) => {
    const target = (entry ?? {}) as Record<string, unknown>;
    return {
      name: String(target.name ?? ""),
      dir: String(target.dir ?? ""),
      status: (target.status === "violation" || target.status === "missing" ? target.status : "ok") as
        | "ok"
        | "violation"
        | "missing",
      visible: asNumber(target.visible),
      identifier: asNumber(target.identifier),
      baseline: asNumber(target.baseline),
      mode: (target.mode === "strict" ? "strict" : "ratchet") as VendorNameCheckMode,
      modeSource: (target.modeSource ?? "policy") as VendorNameScanTarget["modeSource"],
      files: asNumber(target.files),
      detail: Array.isArray(target.detail)
        ? target.detail.slice(0, 20).map((row) => {
            const item = (row ?? {}) as Record<string, unknown>;
            return {
              file: String(item.file ?? ""),
              visible: asNumber(item.visible),
              identifier: asNumber(item.identifier),
              line: asNumber(item.line),
            };
          })
        : [],
    };
  });
  const totals = (report.totals ?? {}) as Record<string, unknown>;

  return {
    available: true,
    root,
    script: VENDOR_NAME_CHECK_SCRIPT,
    policyPath: VENDOR_NAME_CHECK_POLICY,
    mode: (report.mode === "strict" ? "strict" : "ratchet") as VendorNameCheckMode,
    modeSource: (report.modeSource ?? "policy") as VendorNameScanAvailable["modeSource"],
    exitCode: asNumber(report.exitCode),
    status: targets.some((target) => target.status === "violation") ? "violation" : "ok",
    targets,
    totals: { visible: asNumber(totals.visible), identifier: asNumber(totals.identifier) },
  };
}