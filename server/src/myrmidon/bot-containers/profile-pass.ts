// server/src/myrmidon/bot-containers/profile-pass.ts
//
// myrmidon(PERF-DIET-G): the cache of ONE reconciliation pass.
//
// The sweep reconciles every bot of the instance in one pass (index.ts) and
// compile (profile-compile.ts) runs once per bot, so a company- or
// instance-scoped read was paid once per bot, every minute: the skill lifecycle
// delivery, the runtime skill catalogue and its files, the instance settings.
// A pass carries those values: the first bot of the pass reads them, every
// other bot of the same pass gets the value the first one read.
//
// The cache is bounded by the pass — `end()` empties it — never by a clock, so
// a settings or skill change is still picked up by the next sweep, exactly as
// it was when every read went to the database (the sweep interval is the upper
// bound). A pass that already ended serves nothing: a compile that kept a stale
// pass by mistake reads live values instead of old ones.

export interface BotProfilePass {
  /** True once `end()` ran: the pass holds nothing and answers nothing. */
  readonly ended: boolean;
  /** One value per `key` per pass. Concurrent callers share the in-flight read,
   *  so four bots compiled in parallel pay one query between them. */
  once<T>(key: string, read: () => Promise<T>): Promise<T>;
  /** Drops everything the pass collected. */
  end(): void;
}

/** A fresh, empty pass. The sweep owns it: it hands it to every compile of the
 *  pass and ends it when the last bot is done. */
export function beginBotProfilePass(): BotProfilePass {
  const values = new Map<string, Promise<unknown>>();
  let ended = false;

  return {
    get ended(): boolean {
      return ended;
    },

    once<T>(key: string, read: () => Promise<T>): Promise<T> {
      // An ended pass must not answer from a cache: reading live is always
      // correct, and a stale value is the one thing this must never do.
      if (ended) return read();
      const cached = values.get(key);
      if (cached) return cached as Promise<T>;
      const started = read();
      values.set(key, started);
      // A failed read is dropped at once, so the next bot of the pass retries it
      // instead of inheriting one bot's transient failure for the whole pass.
      started.catch(() => {
        if (values.get(key) === started) values.delete(key);
      });
      return started;
    },

    end(): void {
      ended = true;
      values.clear();
    },
  };
}

/** A read that may be shared through a pass; undefined = read live. */
export type BotProfilePassReader = Pick<BotProfilePass, "once">;