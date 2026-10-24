// myrmidon(LICENSING): the client side of module licensing — where the
// license lives, what each closed module will decide about it, and how the
// board saves a pasted license.
//
// Source of the license: the exact resolution the modules use (MYR_LICENSE
// text, else the file at MYR_LICENSE_PATH, default
// /etc/myrmidon-license/license.key). On a single host the modules are host
// processes (they read the host file), containers that bind-mount the host
// file, and the antigravity adapter inside the board container itself. So the
// one place a pasted license reaches all of them is the host file, and the
// board writes it through a bind mount of the host directory.
//
// Saving rewrites the file IN PLACE (same inode): module containers mount the
// single file, and a bind-mounted file keeps pointing at the old inode after
// a rename, so an atomic rename would leave them on the old license. The
// write never leaves the file momentarily empty or truncated: the new text is
// padded with spaces to the old length first (the modules strip whitespace)
// and only then truncated.
//
// Nothing here ever returns or logs the license text.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { DenyListReader } from "./denylist.js";
import { KNOWN_MODULES, verifyLicense, type TrustedIssuerKey, type VerifyReason } from "./license.js";

export const LICENSE_ENV = "MYR_LICENSE";
export const LICENSE_PATH_ENV = "MYR_LICENSE_PATH";
export const DEFAULT_LICENSE_PATH = "/etc/myrmidon-license/license.key";
export const MAX_LICENSE_CHARS = 8192;
/** A valid license this close to its end is reported as "expiring". */
export const EXPIRING_WITHIN_DAYS = 14;

/** Plugin keys and adapter types under which the closed modules install into the board. */
export const MODULE_PLUGIN_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "myrmidon.google-ai": "google-ai",
  "myrmidon.chatgpt-pool": "chatgpt-pool",
  "myrmidon.antigravity": "antigravity",
});
export const MODULE_ADAPTER_TYPES: Readonly<Record<string, string>> = Object.freeze({
  antigravity_local: "antigravity",
});

export type LicenseSource = "env" | "file" | "none" | "file-error";

export function licenseFilePath(env: NodeJS.ProcessEnv): string {
  return (env[LICENSE_PATH_ENV] ?? "").trim() || DEFAULT_LICENSE_PATH;
}

/** Mirror of the module-side `candidate_license`. */
export function readCandidateLicense(env: NodeJS.ProcessEnv): { text: string | null; source: LicenseSource } {
  const fromEnv = (env[LICENSE_ENV] ?? "").trim();
  if (fromEnv) return { text: fromEnv, source: "env" };
  let raw: string;
  try {
    raw = readFileSync(licenseFilePath(env), "utf8");
  } catch (err) {
    return { text: null, source: (err as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "file-error" };
  }
  const text = raw.trim();
  if (!text) return { text: null, source: "none" };
  if (text.length > MAX_LICENSE_CHARS) return { text: null, source: "file-error" };
  return { text, source: "file" };
}

export type ModuleLicenseState =
  | "valid"
  | "expiring"
  | "expired"
  | "wrong_instance"
  | "missing"
  | "not_granted"
  | "bad_signature"
  | "invalid";

export interface ModuleLicenseStatus {
  module: string;
  /** The module is installed into this board (plugin or adapter). */
  installed: boolean;
  state: ModuleLicenseState;
  /** The module-side reason code, for support. */
  reason: VerifyReason;
  /** Unix seconds; null = no expiry or no valid license. */
  expires: number | null;
  /** `wrong_instance` only: the installation id the license was issued for. */
  licenseInstanceId?: string;
  /** `wrong_instance` only: the id of this board. */
  boardInstanceId?: string;
  /** `wrong_instance` only: the same fact as text, both ids included. */
  message?: string;
}

/** The text for a license issued for another installation: both ids. */
export function instanceMismatchMessage(licenseInstanceId: string, boardInstanceId: string): string {
  return `This license was issued for installation ${licenseInstanceId}; the installation id of this board is ${boardInstanceId}.`;
}

export function stateForReason(reason: VerifyReason, expires: number | null, nowSeconds: number): ModuleLicenseState {
  switch (reason) {
    case "ok":
      return expires !== null && expires - nowSeconds <= EXPIRING_WITHIN_DAYS * 86400 ? "expiring" : "valid";
    case "expired":
      return "expired";
    case "instance_mismatch":
      return "wrong_instance";
    case "no_license":
      return "missing";
    case "module_not_granted":
    case "feature_not_granted":
      return "not_granted";
    case "bad_signature":
      return "bad_signature";
    default:
      return "invalid";
  }
}

/** What each known closed module decides about the current license (core feature, as at module start). */
export function moduleStatuses(input: {
  license: { text: string | null; source: LicenseSource };
  installId: string;
  nowSeconds: number;
  trustedKeys: readonly TrustedIssuerKey[];
  installed: readonly string[];
  /** signed deny-list reader (OPE-8964); absent -> nobody is revoked */
  denyList?: DenyListReader;
}): ModuleLicenseStatus[] {
  return KNOWN_MODULES.map((module) => {
    const installed = input.installed.includes(module);
    if (input.license.source === "file-error") {
      return { module, installed, state: "invalid" as const, reason: "unreadable" as const, expires: null };
    }
    const result = verifyLicense(input.license.text, input.installId, input.nowSeconds, input.trustedKeys, {
      requiredModule: module,
    });
    if (
      result.valid &&
      input.denyList?.revoked({ licenseId: result.payload?.id, instanceId: input.installId, kid: result.kid })
    ) {
      // Shown as "invalid" with the support code `revoked` (no new UI state).
      return { module, installed, state: "invalid" as const, reason: "revoked" as const, expires: null };
    }
    const expires = result.valid ? (result.payload?.expires ?? null) : null;
    const status: ModuleLicenseStatus = {
      module,
      installed,
      state: stateForReason(result.reason, expires, input.nowSeconds),
      reason: result.reason,
      expires,
    };
    if (result.reason === "instance_mismatch" && result.licenseInstanceId) {
      status.licenseInstanceId = result.licenseInstanceId;
      status.boardInstanceId = input.installId;
      status.message = instanceMismatchMessage(result.licenseInstanceId, input.installId);
    }
    return status;
  });
}

export function needsAttention(statuses: readonly ModuleLicenseStatus[]): boolean {
  return statuses.some((s) => s.installed && s.state !== "valid" && s.state !== "expiring");
}

/**
 * Rewrites `file` in place. Creates it (0644) when absent; never creates the
 * directory — a missing directory means the host directory is not mounted,
 * and a file written into the container layer would reach no module.
 */
export function writeLicenseFile(file: string, licenseText: string): void {
  const content = Buffer.from(licenseText.trim() + "\n", "utf8");
  let fd: number;
  try {
    fd = openSync(file, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    fd = openSync(file, "wx", 0o644);
  }
  try {
    const oldSize = fstatSync(fd).size;
    const padded = Buffer.alloc(Math.max(oldSize, content.length), 0x20);
    content.copy(padded);
    writeSync(fd, padded, 0, padded.length, 0);
    if (padded.length > content.length) ftruncateSync(fd, content.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type HostShare = "host" | "mounted" | "container-only";

export interface HostShareOptions {
  mountInfoPath?: string;
  containerMarkers?: readonly string[];
}

function unescapeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Whether a file at `file` is visible outside the board process's container:
 * "host" — the board does not run in a container; "mounted" — the file or a
 * parent directory is a mount point other than the container root;
 * "container-only" — it would land in the container's own layer.
 */
export function hostShare(file: string, options: HostShareOptions = {}): HostShare {
  const markers = options.containerMarkers ?? ["/.dockerenv", "/run/.containerenv"];
  if (!markers.some((m) => existsSync(m))) return "host";
  let text = "";
  try {
    text = readFileSync(options.mountInfoPath ?? "/proc/self/mountinfo", "utf8");
  } catch {
    return "container-only";
  }
  const target = path.resolve(file);
  for (const line of text.split("\n")) {
    const mountPoint = line.split(" ")[4];
    if (!mountPoint || mountPoint === "/") continue;
    const mp = unescapeMountPath(mountPoint);
    if (target === mp || target.startsWith(mp.endsWith("/") ? mp : mp + "/")) return "mounted";
  }
  return "container-only";
}
