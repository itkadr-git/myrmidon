import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUE_WITHOUT_RUN_THRESHOLD_SEC,
  QUEUE_WITHOUT_RUN_REPEAT_WINDOW_SEC,
} from "./myrmidon-queue-without-run.js";

describe("queue without run defaults", () => {
  it("uses the default queue age and repeat window", () => {
    expect(DEFAULT_QUEUE_WITHOUT_RUN_THRESHOLD_SEC).toBe(20 * 60);
    expect(QUEUE_WITHOUT_RUN_REPEAT_WINDOW_SEC).toBe(60 * 60);
  });
});