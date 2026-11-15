// myrmidon(OPE-12801): run cancellation for the SSH workspace exchange.
//
// The upload and the download of a run workspace are local `tar` and `ssh`
// child processes that no run registry knows about, so a cancelled run kept
// transferring its workspace and then started the agent CLI on the runner.
// The helpers here carry the run's AbortSignal into that exchange.

export const SSH_OPERATION_ABORTED_CODE = "ssh_operation_aborted";

/** Delay between SIGTERM and SIGKILL for the local transfer processes. */
export const SSH_TRANSFER_ABORT_KILL_DELAY_MS = 5_000;

export class SshOperationAbortedError extends Error {
  readonly code = SSH_OPERATION_ABORTED_CODE;

  constructor(what: string) {
    super(`${what} was stopped because the run was cancelled`);
    this.name = "SshOperationAbortedError";
  }
}

export function isSshOperationAbortedError(error: unknown): error is SshOperationAbortedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SSH_OPERATION_ABORTED_CODE
  );
}

export function throwIfSshAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) throw new SshOperationAbortedError(what);
}

/**
 * Settles with `work`, or rejects as soon as the signal aborts. For steps that
 * have no child process to kill (hashing the local tree): the step itself runs
 * to its end in the background, the caller stops waiting for it.
 */
export async function raceSshAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return await work;
  if (signal.aborted) {
    work.catch(() => undefined);
    throw new SshOperationAbortedError(what);
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SshOperationAbortedError(what));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    work.catch(() => undefined);
  }
}
