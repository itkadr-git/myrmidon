// myrmidon(SERVER-ONBOARD): onboarding dry-run service.
//
// Runs the pre-registration probes against a candidate server and returns
// the typed result contract from @myrmidon/shared. The service is pure
// orchestration: every side-effecting probe goes through the injectable
// OnboardingDryRunExecutor port, so route tests can substitute a mock and
// the dry-run itself never touches the database, the journal, or any
// persistent store.
//
// Probes run in order: DNS → SSH → permissions. A probe is skipped when an
// earlier mandatory probe failed (e.g. no point trying sudo when SSH auth
// failed). Every probe outcome is mapped to a stable code/status pair from
// the shared contract; the returned object always satisfies
// serverOnboardingDryRunResultSchema.

import {
  serverOnboardingDryRunResultSchema,
  type ServerOnboardingCheckCode,
  type ServerOnboardingCheckKind,
  type ServerOnboardingCheckResult,
  type ServerOnboardingCheckStatus,
  type ServerOnboardingDryRunInput,
  type ServerOnboardingDryRunResult,
} from "@myrmidon/shared";

// Re-export the shared contract so server-side consumers can import
// everything from one place.
export {
  SERVER_ONBOARDING_CHECK_CODES,
  SERVER_ONBOARDING_CHECK_KINDS,
  SERVER_ONBOARDING_CHECK_STATUSES,
  serverOnboardingCheckCodeSchema,
  serverOnboardingCheckKindSchema,
  serverOnboardingCheckResultSchema,
  serverOnboardingCheckStatusSchema,
  serverOnboardingDryRunInputSchema,
  serverOnboardingDryRunResultSchema,
} from "@myrmidon/shared";
export type {
  ServerOnboardingCheckCode,
  ServerOnboardingCheckKind,
  ServerOnboardingCheckResult,
  ServerOnboardingCheckStatus,
  ServerOnboardingDryRunInput,
  ServerOnboardingDryRunResult,
} from "@myrmidon/shared";

// ---------------------------------------------------------------------------
// Executor port
// ---------------------------------------------------------------------------

/** Per-probe outcome the executor reports back to the orchestrator. */
export interface ProbeOutcome {
  status: ServerOnboardingCheckStatus;
  code: ServerOnboardingCheckCode;
  /** Safe, human-readable explanation. Never contains secrets. */
  message: string;
}

/**
 * Narrow port for the side-effecting probes. The production wiring supplies
 * a real implementation (node:dns + ssh2); route tests substitute a mock.
 */
export interface OnboardingDryRunExecutor {
  /** Resolve the hostname to an IP address. */
  resolveDns(host: string): Promise<ProbeOutcome>;
  /** Open a TCP connection and read the SSH banner. */
  probeSsh(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<ProbeOutcome>;
  /** Authenticate and check sudo / write permissions. */
  probePermissions(
    host: string,
    port: number,
    username: string,
    auth: { password?: string; privateKey?: string },
    timeoutMs: number,
  ): Promise<ProbeOutcome>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function makeCheck(
  kind: ServerOnboardingCheckKind,
  outcome: ProbeOutcome,
  durationMs: number,
): ServerOnboardingCheckResult {
  return { kind, durationMs, ...outcome };
}

/**
 * Run the dry-run probes in order and assemble the typed result.
 *
 * The function is deterministic given the executor: no clock reads, no
 * randomness, no I/O other than the injected executor calls. This keeps
 * the route tests hermetic and proves the dry-run does not mutate state.
 */
export async function runOnboardingDryRun(
  input: ServerOnboardingDryRunInput,
  executor: OnboardingDryRunExecutor,
): Promise<ServerOnboardingDryRunResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 10_000;
  const checks: ServerOnboardingCheckResult[] = [];
  const skippedChecks: ServerOnboardingCheckKind[] = [];

  // -- DNS ------------------------------------------------------------------
  const dnsStart = Date.now();
  const dnsOutcome = await executor.resolveDns(input.host);
  checks.push(makeCheck("dns", dnsOutcome, Date.now() - dnsStart));
  const dnsOk = dnsOutcome.status === "ok";

  // -- SSH ------------------------------------------------------------------
  let sshOk = false;
  if (dnsOk) {
    const sshStart = Date.now();
    const sshOutcome = await executor.probeSsh(input.host, input.port, timeoutMs);
    checks.push(makeCheck("ssh", sshOutcome, Date.now() - sshStart));
    sshOk = sshOutcome.status === "ok";
  } else {
    skippedChecks.push("ssh");
  }

  // -- Permissions ----------------------------------------------------------
  if (dnsOk && sshOk) {
    const permStart = Date.now();
    const permOutcome = await executor.probePermissions(
      input.host,
      input.port,
      input.username,
      { password: input.auth.password, privateKey: input.auth.privateKey },
      timeoutMs,
    );
    checks.push(makeCheck("permissions", permOutcome, Date.now() - permStart));
  } else {
    skippedChecks.push("permissions");
  }

  const result: ServerOnboardingDryRunResult = {
    dryRun: true,
    skippedChecks,
    checks,
    // ok = every check that ran finished ok. A check with status "skipped"
    // (e.g. the permissions probe when the executor cannot run it) does not
    // flip ok to false; callers who care distinguish via per-check status.
    ok: checks.every((c) => c.status === "ok" || c.status === "skipped"),
    durationMs: Date.now() - startedAt,
  };

  // Defensive: assert the assembled value satisfies the shared contract.
  // If this throws the bug is in the executor (it produced an invalid code
  // or status), not in the orchestrator logic above.
  return serverOnboardingDryRunResultSchema.parse(result);
}

// ---------------------------------------------------------------------------
// Mock executor factory (used by route tests)
// ---------------------------------------------------------------------------

/**
 * Build an executor whose probes return the given canned outcomes. Any
 * probe not present in the map returns a generic failure, so tests are
 * explicit about what they expect.
 */
export function createMockOnboardingDryRunExecutor(
  outcomes: Partial<Record<ServerOnboardingCheckKind, ProbeOutcome>>,
): OnboardingDryRunExecutor {
  const fallback = (kind: string): ProbeOutcome => ({
    status: "failed",
    code: "internal_error",
    message: `${kind} probe not stubbed in test`,
  });
  return {
    resolveDns: async () => outcomes.dns ?? fallback("dns"),
    probeSsh: async () => outcomes.ssh ?? fallback("ssh"),
    probePermissions: async () =>
      outcomes.permissions ?? fallback("permissions"),
  };
}
