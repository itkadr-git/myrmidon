import { runSshCommand, type SshConnectionConfig } from "./ssh.js";

// myrmidon(OPE-12801): stopping the remote side of an SSH run.
//
// The agent CLI runs on the runner as the remote command of a local `ssh`
// client without a pty. Stop, the run-stall watchdog and the adapter timeout
// all signal that local client only. sshd does not forward a signal to the
// remote command when the client goes away, so the CLI, its daemon and broker
// and every tool process they started kept running on the runner, and the
// next run of the same engineer started next to them.
//
// Every remote run command now carries its run id in the environment
// (MYRMIDON_REMOTE_RUN_TAG). Child processes inherit the environment, so the
// variable also marks processes that left the CLI's session and process group
// (a daemon after setsid). The stop finds the marked processes in /proc, sends
// TERM, waits, sends KILL to what is left, and reports what it found and what
// survived. A process that was started with a cleaned environment is not
// marked and is not found.

export const SSH_REMOTE_RUN_TAG_ENV = "MYRMIDON_REMOTE_RUN_TAG";
export const SSH_REMOTE_RUN_STOP_MARKER = "myrmidon_remote_stop";
export const SSH_REMOTE_RUN_STOP_GRACE_SEC = 10;

export function isValidSshRemoteRunTag(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/**
 * POSIX sh script for the runner. It prints one line:
 * `myrmidon_remote_stop found=<n> survivors=<n> forced=<0|1> pids=<p1,p2>`.
 * The script's own process is never matched: the tag is in its text, not in
 * its environment.
 */
export function buildSshRemoteRunStopScript(input: { runTag: string; graceSec?: number }): string {
  if (!isValidSshRemoteRunTag(input.runTag)) {
    throw new Error("Invalid remote run tag");
  }
  const graceSec = Math.max(1, Math.min(60, Math.floor(input.graceSec ?? SSH_REMOTE_RUN_STOP_GRACE_SEC)));
  return [
    `tag='${SSH_REMOTE_RUN_TAG_ENV}=${input.runTag}'`,
    "scan() {",
    "  for d in /proc/[0-9]*; do",
    '    [ -r "$d/environ" ] || continue',
    `    if tr '\\000' '\\n' < "$d/environ" 2>/dev/null | grep -qxF -e "$tag"; then`,
    `      printf '%s ' "\${d#/proc/}"`,
    "    fi",
    "  done",
    "}",
    "first=$(scan)",
    'if [ -z "$first" ]; then',
    `  echo "${SSH_REMOTE_RUN_STOP_MARKER} found=0 survivors=0 forced=0 pids="`,
    "  exit 0",
    "fi",
    "kill -TERM $first 2>/dev/null",
    "left=$first",
    "waited=0",
    `while [ "$waited" -lt ${graceSec} ]; do`,
    "  sleep 1",
    "  waited=$((waited + 1))",
    "  left=$(scan)",
    '  [ -z "$left" ] && break',
    "done",
    "forced=0",
    'if [ -n "$left" ]; then',
    "  forced=1",
    "  kill -KILL $left 2>/dev/null",
    "  sleep 1",
    "  left=$(scan)",
    // A process forked between the scan and the KILL is caught by one more pass.
    '  if [ -n "$left" ]; then',
    "    kill -KILL $left 2>/dev/null",
    "    sleep 1",
    "    left=$(scan)",
    "  fi",
    "fi",
    "set -- $first",
    "found=$#",
    "set -- $left",
    "survivors=$#",
    `echo "${SSH_REMOTE_RUN_STOP_MARKER} found=$found survivors=$survivors forced=$forced pids=$(echo $left | tr ' ' ',')"`,
  ].join("\n");
}

export interface SshRemoteRunStopReport {
  /** True only when the stop command ran and no marked process is left. */
  ok: boolean;
  found: number;
  survivors: number;
  forced: boolean;
  survivorPids: number[];
  /** Why the result could not be established, when it could not. */
  error: string | null;
}

export function parseSshRemoteRunStopOutput(stdout: string): SshRemoteRunStopReport {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith(`${SSH_REMOTE_RUN_STOP_MARKER} `));
  const match = line?.match(/found=(\d+) survivors=(\d+) forced=([01]) pids=([0-9,]*)$/);
  if (!match) {
    return {
      ok: false,
      found: 0,
      survivors: 0,
      forced: false,
      survivorPids: [],
      error: "the runner did not report the result of the stop",
    };
  }
  const survivors = Number(match[2]);
  return {
    ok: survivors === 0,
    found: Number(match[1]),
    survivors,
    forced: match[3] === "1",
    survivorPids: match[4].split(",").filter(Boolean).map(Number),
    error: null,
  };
}

/**
 * Stops every process of the run on the runner and verifies that none is left.
 * Never throws: a failure is a report with `ok: false` and the reason.
 */
export async function terminateSshRemoteRun(input: {
  spec: SshConnectionConfig;
  runTag: string;
  graceSec?: number;
}): Promise<SshRemoteRunStopReport> {
  const graceSec = input.graceSec ?? SSH_REMOTE_RUN_STOP_GRACE_SEC;
  try {
    const script = buildSshRemoteRunStopScript({ runTag: input.runTag, graceSec });
    const result = await runSshCommand(input.spec, script, {
      // grace + two KILL passes + the /proc scans + the ssh handshake
      timeoutMs: (graceSec + 20) * 1000,
      maxBuffer: 64 * 1024,
    });
    return parseSshRemoteRunStopOutput(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      found: 0,
      survivors: 0,
      forced: false,
      survivorPids: [],
      // The first line only: the full text of a failed ssh call repeats the command.
      error: message.split("\n")[0].slice(0, 200),
    };
  }
}

export function describeSshRemoteRunStop(report: SshRemoteRunStopReport): string {
  if (report.error) {
    return `Could not verify that the run's processes stopped on the SSH environment: ${report.error}`;
  }
  if (report.survivors > 0) {
    return `The run's processes are still alive on the SSH environment after TERM and KILL: ${report.survivors} of ${report.found} (pids ${report.survivorPids.join(", ")})`;
  }
  if (report.found === 0) {
    return "No process of the run was left on the SSH environment";
  }
  return `Stopped ${report.found} process(es) of the run on the SSH environment${report.forced ? " (KILL was needed)" : ""}`;
}
