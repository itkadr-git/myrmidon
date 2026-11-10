// server/src/myrmidon/cto-chat/report-delivery.myrmidon.test.ts
//
// Unit tests for myrmidon(1.7-ACTIVE-CHANNEL): Commander report routing to the active channel.
// Acceptance criteria:
//   - active web routes report to web notifications
//   - active telegram routes report to Telegram bridge
//   - active null routes report to default fallback behavior

import { describe, expect, it, vi } from "vitest";
import {
  createCommanderReportDeliveryDeps,
  deliverCommanderReport,
  deliverCommanderReportForDb,
  resolveCommanderReportTarget,
  type CommanderReportDeliveryInput,
  type CommanderReportDeliveryDeps,
} from "./report-delivery.js";

describe("myrmidon(1.7-ACTIVE-CHANNEL) Commander report delivery", () => {
  const baseInput: CommanderReportDeliveryInput = {
    companyId: "comp-1",
    ownerUserId: "user-owner-1",
    reportText: "Weekly deployment report completed with 0 errors.",
    title: "Weekly report",
  };

  it("resolves destination channel correctly from active channel state", () => {
    expect(resolveCommanderReportTarget("web")).toBe("web");
    expect(resolveCommanderReportTarget("telegram")).toBe("telegram");
    expect(resolveCommanderReportTarget(null)).toBe("default");
  });

  it("routes report to web notifications when active channel is web", async () => {
    const deliverToWeb = vi.fn().mockResolvedValue({ destination: "web:notification:comp-1" });
    const deliverToTelegram = vi.fn().mockResolvedValue({ destination: "tg:dm:comp-1" });
    const deliverDefault = vi.fn().mockResolvedValue({ destination: "default:comp-1" });

    const deps: CommanderReportDeliveryDeps = {
      resolveActiveChannel: vi.fn().mockResolvedValue("web"),
      deliverToWeb,
      deliverToTelegram,
      deliverDefault,
    };

    const result = await deliverCommanderReport(baseInput, deps);

    expect(deps.resolveActiveChannel).toHaveBeenCalledWith("user-owner-1", "comp-1");
    expect(deliverToWeb).toHaveBeenCalledWith(baseInput);
    expect(deliverToTelegram).not.toHaveBeenCalled();
    expect(deliverDefault).not.toHaveBeenCalled();

    expect(result).toEqual({
      targetChannel: "web",
      delivered: true,
      destination: "web:notification:comp-1",
      channelResolved: "web",
    });
  });

  it("routes report to Telegram bridge when active channel is telegram", async () => {
    const deliverToWeb = vi.fn().mockResolvedValue({ destination: "web:notification:comp-1" });
    const deliverToTelegram = vi.fn().mockResolvedValue({ destination: "tg:bridge:comp-1" });
    const deliverDefault = vi.fn().mockResolvedValue({ destination: "default:comp-1" });

    const deps: CommanderReportDeliveryDeps = {
      resolveActiveChannel: vi.fn().mockResolvedValue("telegram"),
      deliverToWeb,
      deliverToTelegram,
      deliverDefault,
    };

    const result = await deliverCommanderReport(baseInput, deps);

    expect(deps.resolveActiveChannel).toHaveBeenCalledWith("user-owner-1", "comp-1");
    expect(deliverToTelegram).toHaveBeenCalledWith(baseInput);
    expect(deliverToWeb).not.toHaveBeenCalled();
    expect(deliverDefault).not.toHaveBeenCalled();

    expect(result).toEqual({
      targetChannel: "telegram",
      delivered: true,
      destination: "tg:bridge:comp-1",
      channelResolved: "telegram",
    });
  });

  it("routes report to default fallback behavior when active channel is null", async () => {
    const deliverToWeb = vi.fn().mockResolvedValue({ destination: "web:notification:comp-1" });
    const deliverToTelegram = vi.fn().mockResolvedValue({ destination: "tg:bridge:comp-1" });
    const deliverDefault = vi.fn().mockResolvedValue({ destination: "default:fallback:comp-1" });

    const deps: CommanderReportDeliveryDeps = {
      resolveActiveChannel: vi.fn().mockResolvedValue(null),
      deliverToWeb,
      deliverToTelegram,
      deliverDefault,
    };

    const result = await deliverCommanderReport(baseInput, deps);

    expect(deps.resolveActiveChannel).toHaveBeenCalledWith("user-owner-1", "comp-1");
    expect(deliverDefault).toHaveBeenCalledWith(baseInput);
    expect(deliverToWeb).not.toHaveBeenCalled();
    expect(deliverToTelegram).not.toHaveBeenCalled();

    expect(result).toEqual({
      targetChannel: "default",
      delivered: true,
      destination: "default:fallback:comp-1",
      channelResolved: null,
    });
  });

  it("falls back to default destination when resolving active channel throws an error", async () => {
    const deliverToWeb = vi.fn().mockResolvedValue({ destination: "web:notification:comp-1" });
    const deliverToTelegram = vi.fn().mockResolvedValue({ destination: "tg:bridge:comp-1" });
    const deliverDefault = vi.fn().mockResolvedValue({ destination: "default:fallback:comp-1" });

    const deps: CommanderReportDeliveryDeps = {
      resolveActiveChannel: vi.fn().mockRejectedValue(new Error("status store unreachable")),
      deliverToWeb,
      deliverToTelegram,
      deliverDefault,
    };

    const result = await deliverCommanderReport(baseInput, deps);

    expect(deps.resolveActiveChannel).toHaveBeenCalledWith("user-owner-1", "comp-1");
    expect(deliverDefault).toHaveBeenCalledWith(baseInput);
    expect(deliverToWeb).not.toHaveBeenCalled();
    expect(deliverToTelegram).not.toHaveBeenCalled();

    expect(result).toEqual({
      targetChannel: "default",
      delivered: true,
      destination: "default:fallback:comp-1",
      channelResolved: null,
    });
  });
});
