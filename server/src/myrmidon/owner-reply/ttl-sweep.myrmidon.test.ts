// myrmidon(1.6.5-F21-B): the pure decisions of the owner-card TTL sweep —
// the silence-means-recommended classification, the guarded decision classes,
// the TTL/audience gate, and the delivery-metadata payload pack.

import { describe, expect, it } from "vitest";
import {
  buildOwnerCardPayloadWithDelivery,
  classifyOwnerCardPayload,
  isExpiredOwnerCardRow,
  ownerCardResolvesBySilence,
  OWNER_CARD_GUARDED_DECISION_CLASSES,
  type OwnerCardDeliveryMeta,
} from "./ttl-sweep.js";
import { readOwnerCardTtlSettings, DEFAULT_OWNER_CARD_TTL_MS } from "./settings.js";

const OWNER = "dddddddd-0000-4000-8000-000000000001";
const OTHER_USER = "dddddddd-0000-4000-8000-000000000002";
const AGENT = "aaaaaaaa-0000-4000-8000-000000000001";

const NOW = new Date("2026-01-05T00:00:00.000Z");
const TTL_MS = 72 * 60 * 60 * 1000;
const CUTOFF = new Date(NOW.getTime() - TTL_MS);

function row(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    createdAt: new Date("2025-12-31T00:00:00.000Z"), // well past the cutoff
    effectiveResolverPolicy: "any",
    addresseeAgentId: null,
    addresseeUserId: OWNER,
    ownerUserId: OWNER,
    ...overrides,
  };
}

describe("classifyOwnerCardPayload", () => {
  it("defaults to silence-means-expired with no decision class and accept", () => {
    expect(classifyOwnerCardPayload({})).toEqual({
      silenceMeansRecommended: false,
      decisionClass: null,
      recommendedOption: "accept",
    });
  });

  it("treats a non-object payload as an empty one", () => {
    expect(classifyOwnerCardPayload(null)).toEqual({
      silenceMeansRecommended: false,
      decisionClass: null,
      recommendedOption: "accept",
    });
    expect(classifyOwnerCardPayload("nope").silenceMeansRecommended).toBe(false);
  });

  it("honours the strict boolean flag only", () => {
    expect(classifyOwnerCardPayload({ silenceMeansRecommended: true }).silenceMeansRecommended).toBe(true);
    expect(classifyOwnerCardPayload({ silenceMeansRecommended: "true" }).silenceMeansRecommended).toBe(false);
    expect(classifyOwnerCardPayload({ silenceMeansRecommended: 1 }).silenceMeansRecommended).toBe(false);
  });

  it("reads the decision class and the recommended option", () => {
    expect(
      classifyOwnerCardPayload({ decisionClass: "money", recommendedOption: "reject" }),
    ).toEqual({ silenceMeansRecommended: false, decisionClass: "money", recommendedOption: "reject" });
    expect(
      classifyOwnerCardPayload({ decisionClass: "  " }).decisionClass,
    ).toBeNull();
    expect(
      classifyOwnerCardPayload({ recommendedOption: "no" }).recommendedOption,
    ).toBe("accept");
  });
});

describe("ownerCardResolvesBySilence", () => {
  it("is false without the flag, whatever the class", () => {
    expect(ownerCardResolvesBySilence({})).toBe(false);
    expect(ownerCardResolvesBySilence({ decisionClass: "docs" })).toBe(false);
  });

  it("is true with the flag and no decision class", () => {
    expect(ownerCardResolvesBySilence({ silenceMeansRecommended: true })).toBe(true);
  });

  it("is true with the flag and an unguarded class", () => {
    expect(
      ownerCardResolvesBySilence({ silenceMeansRecommended: true, decisionClass: "docs" }),
    ).toBe(true);
  });

  it.each(OWNER_CARD_GUARDED_DECISION_CLASSES)(
    "is false with the flag on the guarded class %s",
    (decisionClass) => {
      expect(
        ownerCardResolvesBySilence({ silenceMeansRecommended: true, decisionClass }),
      ).toBe(false);
    },
  );
});

describe("isExpiredOwnerCardRow", () => {
  it("is true for a pending card past the cutoff addressed to the owner", () => {
    expect(isExpiredOwnerCardRow(row(), CUTOFF)).toBe(true);
  });

  it("is true for a human_only card past the cutoff (board card)", () => {
    expect(
      isExpiredOwnerCardRow(
        row({ effectiveResolverPolicy: "human_only", addresseeUserId: OTHER_USER }),
        CUTOFF,
      ),
    ).toBe(true);
  });

  it("is false for a card newer than the cutoff", () => {
    expect(
      isExpiredOwnerCardRow(row({ createdAt: new Date(NOW.getTime() - 1000) }), CUTOFF),
    ).toBe(false);
  });

  it("is false for a card that is not pending", () => {
    expect(isExpiredOwnerCardRow(row({ status: "accepted" }), CUTOFF)).toBe(false);
    expect(isExpiredOwnerCardRow(row({ status: "expired" }), CUTOFF)).toBe(false);
  });

  it("is false for a card addressed to an agent", () => {
    expect(
      isExpiredOwnerCardRow(row({ addresseeAgentId: AGENT, addresseeUserId: null }), CUTOFF),
    ).toBe(false);
  });

  it("is false for a card addressed to a non-owner user under the default policy", () => {
    expect(isExpiredOwnerCardRow(row({ addresseeUserId: OTHER_USER }), CUTOFF)).toBe(false);
  });
});

describe("buildOwnerCardPayloadWithDelivery", () => {
  const delivery: OwnerCardDeliveryMeta = {
    sentTo: OWNER,
    sentAt: "2025-12-31T00:00:00.000Z",
    ownerMessagedAt: "2025-12-31T01:00:00.000Z",
    answeredAt: null,
  };

  it("folds the delivery metadata into the payload and keeps the rest", () => {
    const payload = buildOwnerCardPayloadWithDelivery(
      { version: 1, target: { type: "none" }, decisionClass: "docs" },
      delivery,
    );
    expect(payload).toEqual({
      version: 1,
      target: { type: "none" },
      decisionClass: "docs",
      delivery: {
        sentTo: OWNER,
        sentAt: "2025-12-31T00:00:00.000Z",
        ownerMessagedAt: "2025-12-31T01:00:00.000Z",
        answeredAt: null,
      },
    });
  });

  it("starts from an empty object for a non-object payload", () => {
    expect(buildOwnerCardPayloadWithDelivery(null, delivery).delivery).toBeDefined();
  });
});

describe("readOwnerCardTtlSettings", () => {
  it("defaults to 72 h, 5 min interval and the budget", () => {
    const settings = readOwnerCardTtlSettings({});
    expect(settings.ttlMs).toBe(DEFAULT_OWNER_CARD_TTL_MS);
    expect(settings.ttlMs).toBe(72 * 60 * 60 * 1000);
    expect(settings.intervalMs).toBe(300_000);
    expect(settings.pageSize).toBe(50);
    expect(settings.wakeBudget).toBe(20);
  });

  it("reads the env values", () => {
    const settings = readOwnerCardTtlSettings({
      MYRMIDON_OWNER_CARD_TTL_MS: "60000",
      MYRMIDON_OWNER_CARD_SWEEP_INTERVAL_SEC: "30",
      MYRMIDON_OWNER_CARD_SWEEP_WAKE_BUDGET: "3",
    } as NodeJS.ProcessEnv);
    expect(settings.ttlMs).toBe(60_000);
    expect(settings.intervalMs).toBe(30_000);
    expect(settings.wakeBudget).toBe(3);
  });

  it("ignores garbage and out-of-range values", () => {
    const settings = readOwnerCardTtlSettings({
      MYRMIDON_OWNER_CARD_TTL_MS: "banana",
      MYRMIDON_OWNER_CARD_SWEEP_INTERVAL_SEC: "1",
      MYRMIDON_OWNER_CARD_SWEEP_WAKE_BUDGET: "0",
    } as NodeJS.ProcessEnv);
    expect(settings.ttlMs).toBe(DEFAULT_OWNER_CARD_TTL_MS);
    expect(settings.intervalMs).toBe(300_000);
    expect(settings.wakeBudget).toBe(20);
  });
});
