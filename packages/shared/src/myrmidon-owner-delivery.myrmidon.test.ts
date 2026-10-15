// myrmidon(1.6.5-OWNER-VIA-BOT): the owner-delivery contract — the three modes,
// the default, the card gate and the owner-message request schemas.
import { describe, expect, it } from "vitest";
import {
  OWNER_DELIVERY_DEFAULT_MODE,
  OWNER_DELIVERY_MODES,
  OWNER_MESSAGE_MAX_CHARS,
  isOwnerDecisionAudience,
  normalizeOwnerDeliverySettings,
  ownerDeliveryAllowsCard,
  ownerDeliverySettingsSchema,
  ownerMessageRequestSchema,
  ownerReplyResolutionSchema,
} from "./myrmidon-owner-delivery.js";

const OWNER = "owner-1";
const UUID = "11111111-1111-4111-8111-111111111111";

describe("owner delivery modes", () => {
  it("defaults to via_bot and understands all three modes", () => {
    expect(OWNER_DELIVERY_DEFAULT_MODE).toBe("via_bot");
    expect([...OWNER_DELIVERY_MODES]).toEqual(["via_bot", "owner_decisions_only", "all"]);
    for (const mode of OWNER_DELIVERY_MODES) {
      expect(ownerDeliverySettingsSchema.parse({ mode })).toEqual({ mode });
      expect(normalizeOwnerDeliverySettings({ mode })).toEqual({ mode });
    }
    expect(normalizeOwnerDeliverySettings(undefined)).toEqual({ mode: "via_bot" });
    expect(normalizeOwnerDeliverySettings({ mode: "nonsense" })).toEqual({ mode: "via_bot" });
  });

  it("never lets a card reach the owner DM in via_bot mode", () => {
    for (const effectiveResolverPolicy of ["human_only", "anyone", "not_creator"]) {
      expect(
        ownerDeliveryAllowsCard({
          mode: "via_bot",
          effectiveResolverPolicy,
          addresseeUserId: OWNER,
          ownerUserId: OWNER,
        }),
      ).toBe(false);
    }
  });

  it("keeps the older modes unchanged", () => {
    const card = (mode: "owner_decisions_only" | "all", policy: string, addressee: string | null) =>
      ownerDeliveryAllowsCard({
        mode,
        effectiveResolverPolicy: policy,
        addresseeUserId: addressee,
        ownerUserId: OWNER,
      });
    expect(card("owner_decisions_only", "human_only", null)).toBe(true);
    expect(card("owner_decisions_only", "not_creator", OWNER)).toBe(true);
    expect(card("owner_decisions_only", "not_creator", "someone-else")).toBe(false);
    expect(card("owner_decisions_only", "anyone", null)).toBe(false);
    expect(card("all", "anyone", null)).toBe(true);
  });
});

describe("owner decision audience", () => {
  const audience = (input: Partial<Parameters<typeof isOwnerDecisionAudience>[0]>) =>
    isOwnerDecisionAudience({
      effectiveResolverPolicy: "anyone",
      addresseeUserId: null,
      ownerUserId: OWNER,
      ...input,
    });

  it("is human_only or addressed to the task owner", () => {
    expect(audience({ effectiveResolverPolicy: "human_only" })).toBe(true);
    expect(audience({ addresseeUserId: OWNER })).toBe(true);
    expect(audience({})).toBe(false);
    expect(audience({ addresseeUserId: "someone-else" })).toBe(false);
    expect(audience({ addresseeUserId: OWNER, ownerUserId: null })).toBe(false);
  });

  it("is never an agent-addressed interaction", () => {
    expect(audience({ effectiveResolverPolicy: "human_only", addresseeAgentId: "agent-1" })).toBe(false);
  });
});

describe("owner message request schemas", () => {
  it("accepts one to twenty interaction ids and a bounded text", () => {
    expect(ownerMessageRequestSchema.safeParse({ interactionIds: [UUID], text: "Hello" }).success).toBe(true);
    expect(ownerMessageRequestSchema.safeParse({ interactionIds: [], text: "Hello" }).success).toBe(false);
    expect(ownerMessageRequestSchema.safeParse({ interactionIds: ["x"], text: "Hello" }).success).toBe(false);
    expect(ownerMessageRequestSchema.safeParse({ interactionIds: [UUID], text: "   " }).success).toBe(false);
    expect(
      ownerMessageRequestSchema.safeParse({
        interactionIds: [UUID],
        text: "x".repeat(OWNER_MESSAGE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(ownerMessageRequestSchema.safeParse({ interactionIds: [UUID], text: "Hi", extra: 1 }).success).toBe(false);
  });

  it("limits the resolve actions to accept, reject and respond", () => {
    const base = { interactionId: UUID, ownerReplyCommentId: UUID };
    for (const action of ["accept", "reject", "respond"]) {
      expect(ownerReplyResolutionSchema.safeParse({ ...base, action }).success).toBe(true);
    }
    expect(ownerReplyResolutionSchema.safeParse({ ...base, action: "cancel" }).success).toBe(false);
    expect(ownerReplyResolutionSchema.safeParse({ ...base, action: "respond", body: { answers: [] } }).success).toBe(true);
    expect(ownerReplyResolutionSchema.safeParse({ ...base, action: "accept", ownerUserId: "x" }).success).toBe(false);
  });
});
