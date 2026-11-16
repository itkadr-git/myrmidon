// myrmidon(WEBHOOK-LOCK-POOL): where a GitHub delivery waits for its turn.
//
// A delivery of a pull request used to wait for the other deliveries of the
// same pull request inside Postgres: its transaction took a pooled connection
// and then slept in `pg_advisory_xact_lock`. A burst of `check_run` events of
// one pull request (tens in seconds) held every connection of the pool this
// way, and the rest of the board (the GitHub credential broker, the task API,
// the MCP gateways) waited for a connection (16.11: waits up to 268 s).
//
// Now the wait is in the process, before a connection is taken:
//   - `createKeyedQueue` runs the jobs of one key one after another, in the
//     order they were queued, and forgets a key when its last job is done;
//   - `createSemaphore` limits how many delivery transactions of the process
//     are open at once.
// The advisory lock stays in the transaction: it still keeps the two api
// processes apart. At most one delivery of a pull request per process waits
// for it in the database.

export type KeyedQueue = {
  run<T>(key: string, job: () => Promise<T>): Promise<T>;
  /** Number of keys that have a job running or waiting. */
  size(): number;
};

export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, job: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      // A failed earlier job must not stop the next one.
      const result = previous.then(job, job);
      const tail = result.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    size: () => tails.size,
  };
}

export type Semaphore = {
  run<T>(job: () => Promise<T>): Promise<T>;
  /** The largest number of jobs that ran at once since the last `resetPeak`. */
  peak(): number;
  resetPeak(): void;
  active(): number;
};

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("semaphore limit must be a positive integer");
  let active = 0;
  let peak = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    // A slot handed over by `release` keeps `active` as it is.
    peak = Math.max(peak, active);
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await job();
      } finally {
        release();
      }
    },
    peak: () => peak,
    resetPeak: () => { peak = active; },
    active: () => active,
  };
}

/**
 * Open delivery transactions per process. The board pool is the driver default
 * of 10 connections (`DATABASE_POOL_MAX`); the receipt insert of a delivery and
 * every other route use it too. A delivery transaction uses one connection
 * (its writes run in it), so 3 leave 7 for everything else, and a deployment
 * that lowers the pool to 5 still keeps 2 free. Deliveries of different pull
 * requests are short, so 3 at once is enough for the real rate.
 */
export const GITHUB_DELIVERY_MAX_CONCURRENT_TRANSACTIONS = 3;

export const githubPullRequestDeliveryQueue = createKeyedQueue();
export const githubDeliveryTransactionGate = createSemaphore(GITHUB_DELIVERY_MAX_CONCURRENT_TRANSACTIONS);
