// myrmidon(BOT-LSP-DEFAULTS): the language-server mode per role and card.
import { describe, expect, it } from "vitest";
import {
  botLspHermesBlock,
  botLspSettingsSchema,
  effectiveBotLspSettings,
  isBotLspCodingRole,
  patchBotLspSettingsSchema,
  readBotLspCard,
  resolveBotLsp,
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
      excludeRoots: [],
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
      idleTimeout: 120,
      servers: {
        typescript: {
          initialization_options: {
            disableAutomaticTypingAcquisition: true,
            maxTsServerMemory: 1024,
            tsserver: { useSyntaxServer: "never" },
          },
        },
      },
    });
  });

  it("limited takes the instance idle timeout, memory cap and exclusions", () => {
    const block = botLspHermesBlock("limited", { idleTimeoutSeconds: 300, tsserverMemoryMb: 2048, excludeRoots: ["/srv/big"] });
    expect(block).toMatchObject({ idleTimeout: 300, excludeRoots: ["/srv/big"] });
    expect(block?.servers?.typescript?.initialization_options.maxTsServerMemory).toBe(2048);
  });

  it("full writes nothing unless there are exclusions", () => {
    expect(botLspHermesBlock("full", undefined)).toBeNull();
    expect(botLspHermesBlock("full", { excludeRoots: ["/srv/big"] })).toEqual({ enabled: true, excludeRoots: ["/srv/big"] });
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
        tsserverMemoryMb: 1024,
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
