import path from "node:path";

export const LEGACY_BINARY_NAME = "paperclipai";
export const LEGACY_BINARY_WARNING = "paperclipai is deprecated, use myrmidon";

/** Name the CLI was invoked as, without directory or a Windows/script extension. */
export function invokedBinaryName(argv1: string | undefined): string {
  if (!argv1) return "";
  return path.basename(argv1).replace(/\.(cmd|ps1|exe|js|mjs|cjs)$/i, "");
}

export function isLegacyBinaryInvocation(argv1: string | undefined): boolean {
  return invokedBinaryName(argv1) === LEGACY_BINARY_NAME;
}

let warned = false;

/** Print the deprecation warning once per process when started via the old binary name. */
export function warnIfLegacyBinaryName(
  argv1: string | undefined = process.argv[1],
  write: (message: string) => void = (message) => process.stderr.write(message),
): boolean {
  if (warned || !isLegacyBinaryInvocation(argv1)) return false;
  warned = true;
  write(`${LEGACY_BINARY_WARNING}\n`);
  return true;
}

/** Test helper: reset the once-per-process guard. */
export function resetLegacyBinaryWarningForTests(): void {
  warned = false;
}
