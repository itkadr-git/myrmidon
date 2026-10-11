// myrmidon(1.6.6 CH-CONNECTOR-D): the bridge seam — the adapter flag, the theme
// selection (legacy module / connector / partially served connector) and the
// ratchet that keeps the first batch of converted call sites on the seam.
//
// The seam is what makes the first third of the call map (design section 3.3,
// the most isolated clusters: @<alias> addressing, forum topics, DM identity and
// the core voice intake points) leave the bridge modules: the core imports the
// theme from `channel-connectors/bridge/*`, and the connector decides what the
// theme is made of once the operator turns the flag on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as identityLegacy from "../../agent-chat-bridge/identity.js";
import * as topicInboundLegacy from "../../telegram-notify/topic-inbound.js";
import {
  CHANNEL_BRIDGE_ADAPTER_ENV,
  channelBridgeAdapterEnabled,
} from "./flag.js";
import {
  parseTelegramConversationUserId,
  telegramConversationUserId,
} from "./identity.js";
import * as topicInboundSeam from "./topic-inbound.js";
import {
  channelBridgeTheme,
  resetChannelBridgeThemes,
  serveChannelBridgeTheme,
} from "./themes.js";

const ENV = CHANNEL_BRIDGE_ADAPTER_ENV;

afterEach(() => {
  resetChannelBridgeThemes();
  delete process.env[ENV];
});

describe("bridge seam: the flag", () => {
  it("is off when unset, blank or not a known truthy value", () => {
    expect(channelBridgeAdapterEnabled({})).toBe(false);
    expect(channelBridgeAdapterEnabled({ [ENV]: "   " })).toBe(false);
    expect(channelBridgeAdapterEnabled({ [ENV]: "adapter" })).toBe(false);
  });

  it("accepts the truthy spellings the other myrmidon settings accept", () => {
    for (const raw of ["1", "true", "yes", "on", "ON", " on "]) {
      expect(channelBridgeAdapterEnabled({ [ENV]: raw })).toBe(true);
    }
  });
});

describe("bridge seam: theme selection", () => {
  it("hands the legacy module itself over while the flag is off", () => {
    expect(
      channelBridgeTheme("agent-chat-bridge/identity", identityLegacy),
    ).toBe(identityLegacy);
    expect(parseTelegramConversationUserId("telegram:user-a")).toBe("user-a");
    expect(telegramConversationUserId("user-a")).toBe("telegram:user-a");
  });

  it("serves the connector symbols and keeps the legacy ones for the rest", () => {
    process.env[ENV] = "on";
    serveChannelBridgeTheme("agent-chat-bridge/identity", {
      telegramConversationUserId: (boardUserId: string) => `connector:${boardUserId}`,
    });
    expect(telegramConversationUserId("user-a")).toBe("connector:user-a");
    // a symbol the connector does not serve stays on the legacy module
    expect(parseTelegramConversationUserId("telegram:user-a")).toBe("user-a");
  });

  it("falls back to the legacy module when no connector serves the theme", () => {
    process.env[ENV] = "on";
    expect(
      channelBridgeTheme("telegram-notify/topic-inbound", topicInboundLegacy),
    ).toBe(topicInboundLegacy);
    const title = topicInboundSeam.topicTaskTitle("  standup at ten  ", "bot-a");
    expect(title).toBe(topicInboundLegacy.topicTaskTitle("  standup at ten  ", "bot-a"));
  });

  it("forgets the served symbols on reset", () => {
    process.env[ENV] = "on";
    serveChannelBridgeTheme("agent-chat-bridge/identity", {
      telegramConversationUserId: () => "connector:gone",
    });
    expect(telegramConversationUserId("user-a")).toBe("connector:gone");
    resetChannelBridgeThemes();
    expect(telegramConversationUserId("user-a")).toBe("telegram:user-a");
  });
});

// The converted call sites: every symbol of the first batch is imported from the
// seam, and none of them is left on the bridge module directly. The list is the
// call map of the task: points 1-8 (addressing aliases), 41-45 (forum topics),
// 46-49 (voice intake) and 55-63 (conversation identity) — 26 points in seven
// files; the next batches extend it.
const CONVERTED: {
  file: string;
  legacy: string;
  seam: string;
  symbols: string[];
}[] = [
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/agent-chat-bridge/addressing.js",
    seam: "channel-connectors/bridge/addressing.js",
    symbols: ["stripLeadingMentionToken", "TelegramAddressee"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/agent-chat-bridge/bridge.js",
    seam: "channel-connectors/bridge/agent-bridge.js",
    symbols: [
      "resolveBridgedAddressee",
      "afterTelegramDmMessage",
      "decideTelegramDmBinding",
      "ensureTelegramDmBinding",
      "handleTelegramDmCommand",
      "refuseUnlinkedTelegramDm",
      "TelegramDmBridgeDeps",
    ],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/agent-chat-bridge/settings.js",
    seam: "channel-connectors/bridge/dm-conversations.js",
    symbols: ["telegramDmConversationsConfigured", "telegramDmConversationsEnabled"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/telegram-notify/topic-inbound-settings.js",
    seam: "channel-connectors/bridge/topic-inbound-settings.js",
    symbols: ["readTelegramNotifyInbound", "TelegramNotifyInboundSettings"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/telegram-notify/topic-inbound.js",
    seam: "channel-connectors/bridge/topic-inbound.js",
    symbols: ["topicInboundAdmitted", "topicTaskBody", "topicTaskTitle"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/telegram-voice-stt-intake/index.js",
    seam: "channel-connectors/bridge/voice-stt.js",
    symbols: [
      "transcribeTelegramVoiceIntake",
      "TelegramVoiceSttCompanyGate",
      "TelegramVoiceTranscriber",
    ],
  },
  {
    file: "services/heartbeat.ts",
    legacy: "myrmidon/agent-chat-bridge/cross-channel.js",
    seam: "channel-connectors/bridge/cross-channel.js",
    symbols: [
      "appendCrossChannelDelta",
      "buildCrossChannelContext",
      "buildMentionedChatContext",
    ],
  },
  {
    file: "services/issues.ts",
    legacy: "myrmidon/agent-chat-bridge/links.js",
    seam: "channel-connectors/bridge/links.js",
    symbols: [
      "absolutizedTextByTelegramEndpoint",
      "addressedReplyPrefixByTelegramEndpoint",
    ],
  },
  {
    file: "services/chat-run-publications.ts",
    legacy: "myrmidon/agent-chat-bridge/identity.js",
    seam: "channel-connectors/bridge/identity.js",
    symbols: ["parseTelegramConversationUserId"],
  },
  {
    file: "myrmidon/owner-delivery/telegram-owner-bindings.ts",
    legacy: "myrmidon/agent-chat-bridge/identity.js",
    seam: "channel-connectors/bridge/identity.js",
    symbols: ["telegramConversationUserId"],
  },
  {
    file: "myrmidon/ui2-language/routes.ts",
    legacy: "myrmidon/agent-chat-bridge/locales/index.js",
    seam: "channel-connectors/bridge/locales.js",
    symbols: ["forcedBridgeLocale"],
  },
  {
    file: "app.ts",
    legacy: "myrmidon/telegram-voice-stt-intake/wiring.js",
    seam: "channel-connectors/bridge/voice-stt.js",
    symbols: ["createTelegramVoiceSttWiring"],
  },
];

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** The named bindings of every `import { … } from "…"` statement of a source. */
function importPairs(source: string): { names: string[]; specifier: string }[] {
  const pairs: { names: string[]; specifier: string }[] = [];
  const pattern = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const names = match[1]
      .split(",")
      .map((part) => part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    pairs.push({ names, specifier: match[2] });
  }
  return pairs;
}

describe("bridge seam: the converted call sites", () => {
  it("import every batch symbol from the seam", () => {
    for (const entry of CONVERTED) {
      const pairs = importPairs(readFileSync(join(SRC_DIR, entry.file), "utf8"));
      const seamNames = pairs
        .filter((pair) => pair.specifier.endsWith(entry.seam))
        .flatMap((pair) => pair.names);
      for (const symbol of entry.symbols) {
        expect({ file: entry.file, symbol, seamNames }).toMatchObject({
          seamNames: expect.arrayContaining([symbol]),
        });
      }
    }
  });

  it("leave no batch symbol on the bridge module directly", () => {
    for (const entry of CONVERTED) {
      const pairs = importPairs(readFileSync(join(SRC_DIR, entry.file), "utf8"));
      const legacyNames = pairs
        .filter((pair) => pair.specifier.endsWith(entry.legacy))
        .flatMap((pair) => pair.names);
      for (const symbol of entry.symbols) {
        expect({ file: entry.file, symbol, legacyNames }).not.toEqual(
          expect.objectContaining({ legacyNames: expect.arrayContaining([symbol]) }),
        );
      }
    }
  });
});