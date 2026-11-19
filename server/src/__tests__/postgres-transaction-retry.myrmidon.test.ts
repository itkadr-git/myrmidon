// myrmidon(EMPTY-RUNS-3): the reason of a failed query is read from the cause of
// the wrapper, and a transaction Postgres rolled back for a deadlock (40P01) or
// a serialization failure (40001) is run again, a bounded number of times.

import { describe, expect, it, vi } from "vitest";
import {
  isRetryablePostgresError,
  postgresErrorInfo,
  runTransactionWithRetry,
} from "../services/postgres-transaction-retry.js";

/** What the query builder throws: the statement as the text, the driver's error as the cause. */
function failedQuery(code: string, reason: string, extra: Record<string, unknown> = {}) {
  const cause = Object.assign(new Error(reason), { code, severity: "ERROR", ...extra });
  return Object.assign(
    new Error('Failed query: update "issue_work_products" set "metadata" = $1 where "id" = $2\nparams: {"secret":"x"}'),
    { cause },
  );
}

const noSleep = async () => undefined;

describe("postgresErrorInfo", () => {
  it("finds the code and the reason on the cause of a wrapped query error", () => {
    const info = postgresErrorInfo(failedQuery("40P01", "deadlock detected", { table: "issue_work_products", detail: "Process 1 waits for ShareLock on transaction 9" }));
    expect(info).toEqual({ code: "40P01", message: "deadlock detected", severity: "ERROR", table: "issue_work_products" });
  });

  it("does not return the statement, its parameters or the row detail", () => {
    const text = JSON.stringify(postgresErrorInfo(failedQuery("23505", "duplicate key value", { constraint: "k", detail: "Key (id)=(secret) exists" })));
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("secret");
  });

  it("is null for an error that is not from the database", () => {
    expect(postgresErrorInfo(new Error("boom"))).toBeNull();
    expect(postgresErrorInfo(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
    expect(postgresErrorInfo("text")).toBeNull();
    expect(postgresErrorInfo(null)).toBeNull();
  });

  it("marks only 40P01 and 40001 as retryable", () => {
    expect(isRetryablePostgresError(failedQuery("40P01", "deadlock detected"))).toBe(true);
    expect(isRetryablePostgresError(failedQuery("40001", "could not serialize access"))).toBe(true);
    expect(isRetryablePostgresError(failedQuery("23505", "duplicate key"))).toBe(false);
    expect(isRetryablePostgresError(new Error("boom"))).toBe(false);
  });
});

describe("runTransactionWithRetry", () => {
  it("runs again after a deadlock and returns the result of the run that succeeded", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(failedQuery("40P01", "deadlock detected"))
      .mockRejectedValueOnce(failedQuery("40001", "could not serialize access"))
      .mockResolvedValueOnce("done");
    const onRetry = vi.fn();

    await expect(runTransactionWithRetry(run, { sleep: noSleep, onRetry })).resolves.toBe("done");

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(onRetry.mock.calls.map(([info]) => [info.attempt, info.error.code])).toEqual([[1, "40P01"], [2, "40001"]]);
  });

  it("gives up after the bounded number of runs and throws the last error as it is", async () => {
    const last = failedQuery("40P01", "deadlock detected");
    const run = vi.fn().mockRejectedValue(last);

    await expect(runTransactionWithRetry(run, { attempts: 3, sleep: noSleep })).rejects.toBe(last);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not run again after any other error", async () => {
    const other = failedQuery("23505", "duplicate key value");
    const run = vi.fn().mockRejectedValue(other);

    await expect(runTransactionWithRetry(run, { sleep: noSleep })).rejects.toBe(other);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits longer before each repeated run", async () => {
    const sleep = vi.fn(noSleep);
    const run = vi.fn()
      .mockRejectedValueOnce(failedQuery("40P01", "deadlock detected"))
      .mockRejectedValueOnce(failedQuery("40P01", "deadlock detected"))
      .mockResolvedValueOnce(1);

    await runTransactionWithRetry(run, { baseDelayMs: 10, random: () => 0, sleep });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });
});
