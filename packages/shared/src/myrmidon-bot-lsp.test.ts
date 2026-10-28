// myrmidon(BOT-LSP-DEFAULTS): the language-server mode per role and card.
import { describe, expect, it } from "vitest";
import {
  adaptiveTsServerMemoryMb,
  botLspHermesBlock,
  botLspSettingsSchema,
  DEFAULT_BOT_LSP_TSSERVER_MEMORY_MB,
  effectiveBotLspSettings,
  isBotLspCodingRole,
  maxTsServerMemoryMb,
  patchBotLspSettingsSchema,
  readBotLspCard,
  resolveBotLsp,
  resolveBotLspHeap,
} from "./myrmidon-bot-lsp.js";

describe("myrmidon(BOT-LSP-DEFAULTS) resolveBotLsp", () => {
  it("gives coding roles the limited mode and every other role none, by default", () => {
    for (const role of ["engineer", "qa", "devops", "reviewer", "release"]) {
      expect(resolveBotLsp(role, {}, undefined)).toEqual({ mode: "limited", source: "role", coding: true });
    }
    for (const role of ["general", "cmo", "pm", "researcher", "designer", "custom-writer"]) {
      expect(resolveBotLsp(role, {}, undefined)).toEqual({ mode: "off", source: "role", coding: false });
    }
  });

  it("treats a bot with no role as non-coding", () => {
    expect(resolveBotLsp(undefined, {}, undefined).mode).toBe("off");
    expect(resolveBotLsp("", {}, undefined).mode).toBe("off");
  });

  it("matches role keys case-insensitively", () => {
    expect(isBotLspCodingRole("Engineer", undefined)).toBe(true);
  });

  it("lets the card pin a mode over the role", () => {
    expect(resolveBotLsp("general", { lsp: { mode: "limited" } }, undefined)).toEqual({
      mode: "limited",
      source: "card",
      coding: false,
    });
    expect(resolveBotLsp("engineer", { lsp: { mode: "off" } }, undefined)).toMatchObject({ mode: "off", source: "card" });
  });

  it("ignores an unknown card mode (follows the role)", () => {
    expect(readBotLspCard({ lsp: { mode: "sometimes" } })).toEqual({});
    expect(resolveBotLsp("engineer", { lsp: { mode: "sometimes" } }, undefined).source).toBe("role");
  });

  it("follows the instance policy: custom coding roles and modes", () => {
    const settings = { codingRoles: ["dev-lead"], codingMode: "full" as const, nonCodingMode: "limited" as const };
    expect(resolveBotLsp("dev-lead", {}, settings).mode).toBe("full");
    // "engineer" is not in the custom list any more.
    expect(resolveBotLsp("engineer", {}, settings)).toMatchObject({ mode: "limited", coding: false });
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) effectiveBotLspSettings", () => {
  it("fills defaults and drops malformed stored values", () => {
    expect(
      effectiveBotLspSettings({
        codingRoles: ["engineer", "not a key", "engineer"],
        // @ts-expect-error a hand-edited row
        codingMode: "sometimes",
        idleTimeoutSeconds: 5,
        tsserverMemoryMb: 2048,
      }),
    ).toEqual({
      codingRoles: ["engineer"],
      codingMode: "limited",
      nonCodingMode: "off",
      idleTimeoutSeconds: 120,
      tsserverMemoryMb: 2048,
      excludeRoots: ["**/node_modules/**", "**/dist/**"],
    });
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) botLspHermesBlock", () => {
  it("off disables the whole subsystem", () => {
    expect(botLspHermesBlock("off", undefined)).toEqual({ enabled: false });
  });

  it("limited: one tsserver per worktree, no typings acquisition, heap cap, short idle timeout", () => {
    expect(botLspHermesBlock("limited", undefined)).toEqual({
      enabled: true,
      excludeRoots: ["**/node_modules/**", "**/dist/**"],
      idleTimeout: 120,
      servers: {
        typescript: {
          initialization_options: {
            disableAutomaticTypingAcquisition: true,
            maxTsServerMemory: 409,
            tsserver: { useSyntaxServer: "never" },
          },
        },
      },
    });
  });

  it("limited adapts default heap to container memory", () => {
    const block768 = botLspHermesBlock("limited", undefined, 768);
    expect(block768?.servers?.typescript?.initialization_options.maxTsServerMemory).toBe(307);

    const block1024 = botLspHermesBlock("limited", undefined, 1024);
    expect(block1024?.servers?.typescript?.initialization_options.maxTsServerMemory).toBe(409);

    const block2048 = botLspHermesBlock("limited", undefined, 2048);
    expect(block2048?.servers?.typescript?.initialization_options.maxTsServerMemory).toBe(819);
  });

  it("limited safely disables LSP when container memory is unknown or insufficient", () => {
    expect(botLspHermesBlock("limited", undefined, null)).toEqual({ enabled: false });
    expect(botLspHermesBlock("limited", undefined, undefined)).toBeDefined();
    expect(botLspHermesBlock("limited", undefined, 512)).toEqual({ enabled: false });
  });

  it("limited takes the instance idle timeout, memory cap and exclusions", () => {
    const block = botLspHermesBlock("limited", { idleTimeoutSeconds: 300, tsserverMemoryMb: 2048, excludeRoots: ["/srv/big"] });
    expect(block).toMatchObject({ idleTimeout: 300, excludeRoots: ["/srv/big"] });
    expect(block?.servers?.typescript?.initialization_options.maxTsServerMemory).toBe(2048);
  });

  it("full keeps exclusions when set and applies default exclusions", () => {
    expect(botLspHermesBlock("full", undefined)).toEqual({
      enabled: true,
      excludeRoots: ["**/node_modules/**", "**/dist/**"],
    });
    expect(botLspHermesBlock("full", { excludeRoots: ["/srv/big"] })).toEqual({ enabled: true, excludeRoots: ["/srv/big"] });
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) adaptiveTsServerMemoryMb and resolveBotLspHeap", () => {
  it("computes adaptive heap at 40% cap and reserves 60% for Hermes/botd", () => {
    expect(adaptiveTsServerMemoryMb(1024)).toBe(409);
    expect(adaptiveTsServerMemoryMb(768)).toBe(307);
    expect(adaptiveTsServerMemoryMb(1536)).toBe(614);
    expect(adaptiveTsServerMemoryMb(2048)).toBe(819);
  });

  it("returns null for insufficient or unknown container memory", () => {
    expect(adaptiveTsServerMemoryMb(512)).toBeNull();
    expect(adaptiveTsServerMemoryMb(639)).toBeNull();
    expect(adaptiveTsServerMemoryMb(640)).toBe(256);
    expect(adaptiveTsServerMemoryMb(null)).toBeNull();
    expect(adaptiveTsServerMemoryMb(undefined)).toBeNull();
    expect(adaptiveTsServerMemoryMb(0)).toBeNull();
    expect(adaptiveTsServerMemoryMb(-100)).toBeNull();
  });

  it("resolveBotLspHeap handles unknown memory with safe refusal", () => {
    expect(resolveBotLspHeap(null)).toEqual({ ok: false, reason: "unknown_memory" });
    expect(resolveBotLspHeap(undefined)).toEqual({ ok: false, reason: "unknown_memory" });
    expect(resolveBotLspHeap(0)).toEqual({ ok: false, reason: "unknown_memory" });
  });

  it("resolveBotLspHeap handles insufficient memory with safe refusal", () => {
    expect(resolveBotLspHeap(512)).toEqual({
      ok: false,
      reason: "insufficient_memory",
      cap: 204,
      containerMemoryMb: 512,
    });
  });

  it("resolveBotLspHeap provides adaptive default when heap is unconfigured", () => {
    expect(resolveBotLspHeap(1024)).toEqual({
      ok: true,
      memoryMb: 409,
      clamped: false,
      adaptive: true,
      cap: 409,
      containerMemoryMb: 1024,
    });
    expect(resolveBotLspHeap(768)).toEqual({
      ok: true,
      memoryMb: 307,
      clamped: false,
      adaptive: true,
      cap: 307,
      containerMemoryMb: 768,
    });
  });

  it("resolveBotLspHeap respects configured heap within cap", () => {
    expect(resolveBotLspHeap(1024, 300)).toEqual({
      ok: true,
      memoryMb: 300,
      clamped: false,
      adaptive: false,
      cap: 409,
      containerMemoryMb: 1024,
    });
  });

  it("resolveBotLspHeap clamps configured heap exceeding cap with clamped flag", () => {
    expect(resolveBotLspHeap(768, 409)).toEqual({
      ok: true,
      memoryMb: 307,
      clamped: true,
      adaptive: false,
      configured: 409,
      cap: 307,
      containerMemoryMb: 768,
    });
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) schemas", () => {
  it("accepts a full row and rejects out-of-range values", () => {
    expect(
      botLspSettingsSchema.safeParse({
        codingRoles: ["engineer", "dev-lead"],
        codingMode: "limited",
        nonCodingMode: "off",
        idleTimeoutSeconds: 120,
        tsserverMemoryMb: 384,
        excludeRoots: ["/srv/big"],
      }).success,
    ).toBe(true);
    expect(botLspSettingsSchema.safeParse({ idleTimeoutSeconds: 10 }).success).toBe(false);
    expect(botLspSettingsSchema.safeParse({ codingRoles: ["has space"] }).success).toBe(false);
    expect(botLspSettingsSchema.safeParse({ other: 1 }).success).toBe(false);
  });

  it("lets a patch send null to reset a field", () => {
    expect(patchBotLspSettingsSchema.safeParse({ codingMode: null, codingRoles: null }).success).toBe(true);
  });
});
