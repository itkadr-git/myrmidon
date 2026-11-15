// myrmidon(OPE-12810): run env for remote SSH commands travels on stdin, never in argv.
//
// ssh passes its remote command as an argument, so any `KEY=value` placed in it is
// readable by every local user through the process list (host and executor side).
// The remote script instead reads a fixed-size env block from the start of stdin
// (dd, exact byte count, no file on disk) and evals it before exec; the child's
// own stdin follows the block unchanged.

export function isValidSshEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteValue(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface SshEnvStdinTransport {
  /** Bytes to write to ssh stdin before any caller stdin. Empty when no env. */
  stdinPrefix: string;
  /** Shell snippet for the remote script; reads the block from stdin. Empty when no env. */
  remoteReadSnippet: string;
}

export function buildSshEnvStdinTransport(env: Record<string, string | undefined>): SshEnvStdinTransport {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [key] of entries) {
    if (!isValidSshEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  if (entries.length === 0) return { stdinPrefix: "", remoteReadSnippet: "" };
  const stdinPrefix = entries.map(([key, value]) => `export ${key}=${quoteValue(value)}\n`).join("");
  const size = Buffer.byteLength(stdinPrefix, "utf8");
  return {
    stdinPrefix,
    remoteReadSnippet: `eval "$(dd bs=1 count=${size} 2>/dev/null)"`,
  };
}

/** Caller stdin with the env block in front; null when there is nothing to send. */
export function withSshEnvStdinPrefix(prefix: string, stdin: string | null | undefined): string | null {
  if (!prefix) return stdin ?? null;
  return prefix + (stdin ?? "");
}
