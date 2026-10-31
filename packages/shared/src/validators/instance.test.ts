import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  isValidIanaTimeZone,
} from "./instance.js";

describe("instance experimental settings validators", () => {
  it("defaults chat connectors off independently of Apps and accepts only explicit boolean patches", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enableChatConnectors).toBe(false);
    expect(instanceExperimentalSettingsSchema.parse({ enableApps: true }).enableChatConnectors).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableChatConnectors: true }))
      .toEqual({ enableChatConnectors: true });
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableChatConnectors: false }))
      .toEqual({ enableChatConnectors: false });
    expect(patchInstanceExperimentalSettingsSchema.safeParse({ enableChatConnectors: "true" }).success).toBe(false);
  });
  it("defaults the streamlined UI on and accepts an explicit patch", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enableStreamlinedUi).toBe(true);
    expect(
      patchInstanceExperimentalSettingsSchema.parse({ enableStreamlinedUi: false }),
    ).toEqual({ enableStreamlinedUi: false });
  });

  it("defaults the server info debug view off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableServerInfoDebugView).toBe(false);
  });

  it("defaults Paperclip developer mode off and accepts explicit patches", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enablePaperclipDeveloperMode).toBe(false);
    expect(
      patchInstanceExperimentalSettingsSchema.parse({ enablePaperclipDeveloperMode: true }),
    ).toEqual({ enablePaperclipDeveloperMode: true });
  });

  it("strips retired watchdog and liveness auto-recovery settings", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableTaskWatchdogs: false,
        enableIssueGraphLivenessAutoRecovery: true,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
      }),
    ).toEqual({});
  });

  it("defaults workspace branch repair settings on", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableWorkspaceBranchReconcileForward).toBe(true);
    expect(settings.enableWorkspaceDirtyQuarantineRepair).toBe(true);
  });

  it("defaults the goals sidebar link off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableGoalsSidebarLink).toBe(false);
  });

  it("defaults the sandbox duplex bridge kill switch off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableSandboxDuplexBridge).toBe(false);
  });

  it("accepts an explicit sandbox duplex bridge kill switch value", () => {
    expect(
      instanceExperimentalSettingsSchema.parse({ enableSandboxDuplexBridge: true })
        .enableSandboxDuplexBridge,
    ).toBe(true);
    expect(
      instanceExperimentalSettingsSchema.parse({ enableSandboxDuplexBridge: false })
        .enableSandboxDuplexBridge,
    ).toBe(false);
  });

  it("accepts the sandbox duplex bridge kill switch in a patch", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({ enableSandboxDuplexBridge: true }),
    ).toEqual({ enableSandboxDuplexBridge: true });
  });

  it("defaults worktree run execution off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableWorktreeRunExecution).toBe(false);
    expect(settings.worktreeRunExecutionActivatedAt).toBeNull();
    expect(settings.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("strips server-managed worktree run execution fields from patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      }),
    ).toEqual({
      enableWorktreeRunExecution: true,
    });
  });

  it("defaults built-in agents off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableBuiltInAgents).toBe(false);
  });

  it("defaults beta skills off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableBetaSkills).toBe(false);
  });

  it("defaults the retired Apps compatibility key on", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableApps).toBe(true);
  });

  it("accepts worktree run execution patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorktreeRunExecution: true,
      }),
    ).toEqual({
      enableWorktreeRunExecution: true,
    });
  });

  it("defaults the decisions sidebar link off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableDecisions).toBe(false);
  });

  it("accepts decisions patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableDecisions: true,
      }),
    ).toEqual({
      enableDecisions: true,
    });
  });

  it("accepts server info debug view patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableServerInfoDebugView: true,
      }),
    ).toEqual({
      enableServerInfoDebugView: true,
    });
  });

  it("accepts workspace branch forward reconciliation patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorkspaceBranchReconcileForward: false,
        enableWorkspaceDirtyQuarantineRepair: false,
      }),
    ).toEqual({
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });
  });

  it("accepts goals sidebar link patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableGoalsSidebarLink: true,
      }),
    ).toEqual({
      enableGoalsSidebarLink: true,
    });
  });

  it("accepts built-in agents patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableBuiltInAgents: true,
      }),
    ).toEqual({
      enableBuiltInAgents: true,
    });
  });

  it("accepts apps patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableApps: true,
      }),
    ).toEqual({
      enableApps: true,
    });
  });
});

describe("instance general settings validators (timeZone, numberFormat, dateFormat)", () => {
  it("defaults timeZone to Asia/Irkutsk, numberFormat to en-US, and dateFormat to ymd", () => {
    const general = instanceGeneralSettingsSchema.parse({});
    expect(general.timeZone).toBe("Asia/Irkutsk");
    expect(general.numberFormat).toBe("en-US");
    expect(general.dateFormat).toBe("ymd");
  });

  it("validates timeZone with Intl.DateTimeFormat (valid IANA zones pass, unknown fail)", () => {
    expect(isValidIanaTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidIanaTimeZone("Asia/Irkutsk")).toBe(true);
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("UTC")).toBe(true);

    expect(isValidIanaTimeZone("Mars/Base")).toBe(false);
    expect(isValidIanaTimeZone("")).toBe(false);
    expect(isValidIanaTimeZone("   ")).toBe(false);
    expect(isValidIanaTimeZone("Invalid/Timezone")).toBe(false);

    const validParsed = instanceGeneralSettingsSchema.safeParse({
      timeZone: "Europe/Moscow",
    });
    expect(validParsed.success).toBe(true);
    if (validParsed.success) {
      expect(validParsed.data.timeZone).toBe("Europe/Moscow");
    }

    const invalidParsed = instanceGeneralSettingsSchema.safeParse({
      timeZone: "Mars/Base",
    });
    expect(invalidParsed.success).toBe(false);
  });

  it("validates numberFormat (en-US, ru-RU pass; others fail)", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ numberFormat: "en-US" }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ numberFormat: "ru-RU" }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ numberFormat: "de-DE" }).success).toBe(false);
    expect(instanceGeneralSettingsSchema.safeParse({ numberFormat: "fr-FR" }).success).toBe(false);
  });

  it("validates dateFormat (ymd, dmy, mdy pass; others fail)", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ dateFormat: "ymd" }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ dateFormat: "dmy" }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ dateFormat: "mdy" }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ dateFormat: "ydm" }).success).toBe(false);
    expect(instanceGeneralSettingsSchema.safeParse({ dateFormat: "d-m-y" }).success).toBe(false);
  });

  it("validates PATCH schema: accepts partial updates and rejects invalid values", () => {
    // Valid partials
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "Europe/Moscow" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ numberFormat: "ru-RU" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ dateFormat: "dmy" }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({
      timeZone: "Europe/Moscow",
      numberFormat: "ru-RU",
      dateFormat: "dmy",
    }).success).toBe(true);

    // Invalid partials
    expect(patchInstanceGeneralSettingsSchema.safeParse({ timeZone: "Mars/Base" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ numberFormat: "de-DE" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ dateFormat: "unknown" }).success).toBe(false);

    // Unrelated patch doesn't require these fields
    expect(patchInstanceGeneralSettingsSchema.safeParse({ censorUsernameInLogs: true }).success).toBe(true);
  });
});
