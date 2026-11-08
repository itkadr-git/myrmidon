// server/src/myrmidon/litellm-sync/lock.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): the process-local guard that serializes
// gateway mutations per company.
//
// Model registration and deregistration are read-modify-write against the
// gateway's whole registry (`/model/info` then /model/new or /model/delete).
// Two concurrent passes over one company could compute the same diff and
// write it twice, or one could remove what the other just added. Registry
// changes are rare board operations, so a per-company in-process queue is
// enough and cheap; the registry is shared per process, matching the single
// process the server runs reconciliation and route syncs in.

const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every previously requested sync of the same company has
 * settled. The queue never breaks: a failed sync only settles its own slot,
 * the next caller still runs. The caller's result or rejection passes through
 * unchanged.
 */
export function withCompanySyncGuard<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(companyId) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  // The tail must never reject, or a later caller would inherit an old
  // failure. Catch it into a settled void, and only clean the map entry when
  // this call's slot is the last one in the chain.
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  tails.set(companyId, tail);
  void tail.then(() => {
    if (tails.get(companyId) === tail) tails.delete(companyId);
  });
  return current;
}
