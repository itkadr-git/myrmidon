// myrmidon(1.6.5-OWNER-DM-FILTER): client-tier tests for ownerDeliveryApi.
//
// The transport is mocked, so the assertions are on the request itself: the
// frozen paths and the PATCH body, plus the documented default for a body that
// is missing or malformed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_DELIVERY_DEFAULT_MODE,
  normalizeOwnerDeliverySettings,
  ownerDeliveryApi,
} from "./ownerDeliveryApi";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock("@/api/client", () => ({ api: apiMock }));

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.patch.mockReset();
});

describe("myrmidon(1.6.5-OWNER-DM-FILTER) owner delivery api", () => {
  it("reads the stored mode from the frozen route", async () => {
    apiMock.get.mockResolvedValue({ mode: "all" });
    await expect(ownerDeliveryApi.getSettings()).resolves.toEqual({ mode: "all" });
    expect(apiMock.get).toHaveBeenCalledWith("/myrmidon/owner-delivery");
  });

  it("patches the picked mode as { mode }", async () => {
    apiMock.patch.mockResolvedValue({ mode: "owner_decisions_only" });
    await expect(ownerDeliveryApi.updateSettings({ mode: "owner_decisions_only" })).resolves.toEqual({
      mode: "owner_decisions_only",
    });
    expect(apiMock.patch).toHaveBeenCalledWith("/myrmidon/owner-delivery", {
      mode: "owner_decisions_only",
    });
  });

  it("falls back to the default mode (via_bot) for an empty or malformed body", async () => {
    const expected = { mode: OWNER_DELIVERY_DEFAULT_MODE };
    for (const body of [{}, null, undefined, { mode: "nonsense" }, "all"]) {
      apiMock.get.mockResolvedValue(body);
      await expect(ownerDeliveryApi.getSettings()).resolves.toEqual(expected);
    }
  });

  it("normalizes a stored mode it understands", () => {
    expect(normalizeOwnerDeliverySettings({ mode: "all" })).toEqual({ mode: "all" });
    expect(normalizeOwnerDeliverySettings({ mode: "via_bot" })).toEqual({ mode: "via_bot" });
    expect(normalizeOwnerDeliverySettings({ mode: "owner_decisions_only" })).toEqual({
      mode: "owner_decisions_only",
    });
    expect(OWNER_DELIVERY_DEFAULT_MODE).toBe("via_bot");
  });
});