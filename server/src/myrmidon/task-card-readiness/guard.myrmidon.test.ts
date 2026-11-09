import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateTaskCardReadiness,
  TASK_CARD_SECTION_CODES,
  TASK_CARD_VIOLATION_CODES,
} from "@myrmidon/shared";
import {
  assertTaskCardReady,
  getTaskCardGateMode,
  TASK_CARD_NOT_READY,
} from "./guard.js";

const MODE_ENV = "MYRMIDON_TASK_CARD_GATE_MODE";
const START_ENV = "MYRMIDON_TASK_CARD_GATE_START_DATE";

/** A card that passes every rule of the slice-1 checker. */
const READY_CARD = {
  title: "1.6.7 Заголовок задачи",
  description: [
    "МЕСТО ПРАВКИ: server/src/myrmidon/task-card-readiness/guard.ts (новый файл).",
    "НАМЕРЕНИЕ: гейт полноты карточки перед передачей инженеру.",
    "ГРАНИЦА ОБЪЁМА: без врезки в updateIssue, без UI.",
    "КРИТЕРИИ ПРИЁМКИ: Ложно, если переход разрешён или код другой.",
    "ТЕСТ: pnpm test server/src/myrmidon/task-card-readiness.",
  ].join("\n"),
};

const NOT_READY_CARD = {
  title: "Сделать фичу",
  description: "Что-то уточнить у постановщика — не уточнено.",
};

function forceEnforce() {
  return { forceEnforce: true as const };
}

function violationsOf(card: { title: string; description: string }) {
  return evaluateTaskCardReadiness(card).violations;
}

describe("getTaskCardGateMode", () => {
  beforeEach(() => {
    delete process.env[MODE_ENV];
    delete process.env[START_ENV];
  });

  afterEach(() => {
    delete process.env[MODE_ENV];
    delete process.env[START_ENV];
  });

  it("returns warning during the 3-day grace period", () => {
    expect(getTaskCardGateMode(new Date("2026-11-08T00:00:00Z"))).toBe("warning");
    expect(getTaskCardGateMode(new Date("2026-11-09T23:59:59Z"))).toBe("warning");
  });

  it("returns enforce after the grace period", () => {
    expect(getTaskCardGateMode(new Date("2026-11-10T00:00:00Z"))).toBe("enforce");
    expect(getTaskCardGateMode(new Date("2027-01-01T00:00:00Z"))).toBe("enforce");
  });

  it("respects env overrides", () => {
    process.env[MODE_ENV] = "warning";
    expect(getTaskCardGateMode(new Date("2027-01-01T00:00:00Z"))).toBe("warning");
    process.env[MODE_ENV] = "enforce";
    expect(getTaskCardGateMode(new Date("2026-11-01T00:00:00Z"))).toBe("enforce");
  });

  it("honours an env start date", () => {
    process.env[START_ENV] = "2027-01-01T00:00:00Z";
    expect(getTaskCardGateMode(new Date("2027-01-02T00:00:00Z"))).toBe("warning");
    expect(getTaskCardGateMode(new Date("2027-01-05T00:00:00Z"))).toBe("enforce");
  });

  it("honours explicit options", () => {
    expect(
      getTaskCardGateMode(new Date("2026-11-10T00:00:00Z"), {
        startDate: new Date("2026-11-09T00:00:00Z"),
        gracePeriodMs: 2 * 24 * 60 * 60 * 1000,
      }),
    ).toBe("warning");
  });
});

describe("assertTaskCardReady", () => {
  beforeEach(() => {
    delete process.env[MODE_ENV];
    delete process.env[START_ENV];
  });

  afterEach(() => {
    delete process.env[MODE_ENV];
    delete process.env[START_ENV];
  });

  it("throws 422 TASK_CARD_NOT_READY on a card with an unresolved marker in enforce mode", () => {
    let caught: unknown;
    try {
      assertTaskCardReady(NOT_READY_CARD, forceEnforce());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422 });
    const details = (caught as { details?: { code?: string; violations?: unknown } }).details;
    expect(details?.code).toBe(TASK_CARD_NOT_READY);
    expect(details?.code).not.toBe("knowledge_note_required");
    expect(details?.violations).toEqual(violationsOf(NOT_READY_CARD));
  });

  it("lists missing sections and the unresolved-marker violation code", () => {
    let caught: unknown;
    try {
      assertTaskCardReady(NOT_READY_CARD, forceEnforce());
    } catch (err) {
      caught = err;
    }
    const details = (caught as { details?: { violations?: Array<{ code?: string }> } }).details;
    const codes = details?.violations?.map((v) => v.code);
    expect(codes).toContain(TASK_CARD_VIOLATION_CODES.UNRESOLVED_MARKER);
    expect(codes).toContain(TASK_CARD_SECTION_CODES["МЕСТО ПРАВКИ"]);
    expect(codes).toContain(TASK_CARD_VIOLATION_CODES.NO_CHECKABLE_CLAIM);
  });

  it("tags violations on a deterministic checker with an empty description", () => {
    let caught: unknown;
    try {
      assertTaskCardReady({ title: "Пустая", description: "" }, forceEnforce());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422 });
    const details = (caught as { details?: { violations?: Array<{ code?: string }> } }).details;
    expect(details?.violations).toEqual([{ code: TASK_CARD_VIOLATION_CODES.EMPTY_CARD, message: expect.any(String) }]);
  });

  it("lets a fully ready card pass without error in enforce mode", () => {
    expect(evaluateTaskCardReadiness(READY_CARD).ready).toBe(true);
    expect(() => assertTaskCardReady(READY_CARD, forceEnforce())).not.toThrow();
  });

  it("lets a fully ready card pass in warning mode too", () => {
    process.env[MODE_ENV] = "warning";
    expect(() => assertTaskCardReady(READY_CARD)).not.toThrow();
  });

  it("never throws in warning mode, even for a not-ready card", () => {
    process.env[MODE_ENV] = "warning";
    expect(() => assertTaskCardReady(NOT_READY_CARD)).not.toThrow();
  });

  it("throws by default once the grace period has passed (no env)", () => {
    let caught: unknown;
    try {
      assertTaskCardReady(NOT_READY_CARD, { now: new Date("2027-01-01T00:00:00Z") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422, details: { code: TASK_CARD_NOT_READY } });
  });

  it("does not throw by default inside the grace period (no env)", () => {
    expect(() =>
      assertTaskCardReady(NOT_READY_CARD, { now: new Date("2026-11-08T00:00:00Z") }),
    ).not.toThrow();
  });

  it("honours the env override on both sides", () => {
    process.env[MODE_ENV] = "enforce";
    let caught: unknown;
    try {
      assertTaskCardReady(NOT_READY_CARD, { now: new Date("2026-11-08T00:00:00Z") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422, details: { code: TASK_CARD_NOT_READY } });
    process.env[MODE_ENV] = "warning";
    expect(() =>
      assertTaskCardReady(NOT_READY_CARD, { now: new Date("2027-01-01T00:00:00Z") }),
    ).not.toThrow();
  });

  it("only checks: it does not decide when the gate applies (no status/transition input)", () => {
    // Scope boundary (acceptance criterion 4): the gate function takes only the
    // card and pure options — no status, transition, or caller context — so it
    // cannot gate on anything but card readiness. Call sites (slice 3) invoke
    // it explicitly; deciding "when" lives there.
    expect(assertTaskCardReady.length).toBe(2);
    expect(Object.keys(NOT_READY_CARD).sort()).toEqual(["description", "title"]);
  });
});
