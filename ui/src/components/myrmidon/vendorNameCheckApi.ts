// Vendor-name gate (myrmidon 1.7 REBRAND-F):
// GET/PATCH /api/myrmidon/vendor-name-check.
//
// The setting is the gate's mode (ratchet — the visible count may not grow
// above the baseline — or strict — no visible occurrence outside the policy's
// exceptions) and the baseline the instance reports against. PATCH saves it to
// the instance settings and the next read uses it; nothing needs a restart.
// The read also answers the gate's own question about this build: how many
// times the vendor's name appears in the built interface bundle and in the
// recorded response snapshots.
import type { VendorNameCheckMode, VendorNameCheckPatch, VendorNameCheckSettingSource } from "@myrmidon/shared";
import { api } from "@/api/client";

export interface VendorNameCheckView {
  settings: { mode: VendorNameCheckMode; baseline: number };
  sources: Record<"mode" | "baseline", VendorNameCheckSettingSource>;
  scan: VendorNameScan;
}

/** The gate's answer about the build this server runs from. */
export type VendorNameScan =
  | {
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
  | { available: false; reason: "no_repository" | "script_failed" | "report_unreadable"; detail: string; script: string };

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

export const vendorNameCheckQueryKey = ["myrmidon", "vendor-name-check"] as const;

export const vendorNameCheckApi = {
  get: () => api.get<VendorNameCheckView>("/myrmidon/vendor-name-check"),
  update: (patch: VendorNameCheckPatch) =>
    api.patch<VendorNameCheckView>("/myrmidon/vendor-name-check", patch),
};

export function describeVendorNameCheckSource(source: VendorNameCheckSettingSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Forced by the server environment";
    default:
      return "Default";
  }
}

export function describeVendorNameCheckMode(mode: VendorNameCheckMode): string {
  return mode === "strict" ? "Strict" : "Ratchet";
}