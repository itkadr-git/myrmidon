import { describe, expect, it } from "vitest";
import { configuredPoolChatProviders, selectPoolChatAccount } from "./router.js";

describe("pool-chat account router", () => {
  const accounts = [
    { accountRef: "pool-acc-1", provider: "chatgpt", enabled: true, quotaUnits: 2, usedUnits: 2 },
    { accountRef: "pool-acc-2", provider: "chatgpt", enabled: true, quotaUnits: 5, usedUnits: 1 },
    { accountRef: "google-acc-1", provider: "google", enabled: true, quotaUnits: null, usedUnits: 0 },
    { accountRef: "disabled", provider: "chatgpt", enabled: false, quotaUnits: null, usedUnits: 0 },
  ];

  it("chooses an eligible account without exposing pool identity in capabilities", () => {
    expect(selectPoolChatAccount({ accounts }, "chatgpt", 1)).toEqual({
      accountRef: "pool-acc-2",
      provider: "chatgpt",
    });
    expect(configuredPoolChatProviders({ accounts })).toEqual(["chatgpt", "google"]);
  });

  it("fails closed when all matching accounts are disabled or over quota", () => {
    expect(() => selectPoolChatAccount({ accounts }, "chatgpt", 4)).toThrow("No pool-chat account");
    expect(() => selectPoolChatAccount({ accounts: [{ ...accounts[0], enabled: false }] }, "chatgpt", 1))
      .toThrow("No pool-chat account");
  });

  it("rejects malformed account configuration", () => {
    expect(() => selectPoolChatAccount({ accounts: [{ provider: "chatgpt" }] }, "chatgpt", 1))
      .toThrow("No pool-chat account");
    expect(configuredPoolChatProviders({ accounts: [{ provider: "google", enabled: true }] })).toEqual([]);
  });
});
