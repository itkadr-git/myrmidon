// myrmidon(OPE-9107): a shutdown routine that runs once. The first call starts
// `run`; every later call (a second SIGTERM, or an entry point that also
// calls `shutdown()`) joins the same promise instead of closing resources
// again. `exitProcess` is honoured per call: a signal that joins a
// programmatic run still ends the process once that run is done.

export function createIdempotentShutdown<S>(
  run: (signal: S, exitProcess: boolean) => Promise<void>,
  exit: (exitProcess: boolean) => void,
): (signal: S, exitProcess: boolean) => Promise<void> {
  let started: Promise<void> | null = null;
  return (signal, exitProcess) => {
    if (!started) {
      started = run(signal, false);
    }
    return started.then(() => exit(exitProcess));
  };
}
