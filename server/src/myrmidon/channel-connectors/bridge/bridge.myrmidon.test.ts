// myrmidon(1.6.6 CH-CONNECTOR-D): the bridge seam — the adapter flag, the theme
// selection (legacy module / connector / partially served connector) and the
// ratchet that keeps the converted call sites of the first and third batches on
// the seam.
//
// The seam is what makes the first third of the call map (design section 3.3,
// the most isolated clusters: @<alias> addressing, forum topics, DM identity and
// the core voice intake points) leave the bridge modules: the core imports the
// theme from `channel-connectors/bridge/*`, and the connector decides what the
// theme is made of once the operator turns the flag on.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as identityLegacy from "../../agent-chat-bridge/identity.js";
// myrmidon(1.6.6 CH-CONNECTOR-D) batch 3 (OPE-6976): the contract data the
// batch-3 seams keep bound to the legacy module (stored notice text, canonical
// command list), imported from the legacy modules for the comparison below.
import { TELEGRAM_DM_COMMANDS as legacyDmCommands } from "../../agent-chat-bridge/commands/index.js";
import { TELEGRAM_PRIVATE_ACTION_UNAVAILABLE as legacyEphemeralNoticeText } from "../../../services/chat-telegram-ephemeral.js";
import * as notifySeam from "./notify.js";
import * as commandsSeam from "./commands.js";
import * as ephemeralSeam from "./telegram-ephemeral.js";
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

  // myrmidon(1.6.6 CH-CONNECTOR-D) batch 3 (OPE-6976): a notify-track theme
  // behaves like the batch-1 ones: the seam forwards while the flag is off, a
  // served symbol is replaced when it is on, and the contract data (the stored
  // notice text, the canonical command list) never leaves the legacy value.
  it("serves a batch-3 theme and keeps its contract data", () => {
    expect(notifySeam.startTelegramNotifyJobs).toBeTypeOf("function");
    process.env[ENV] = "on";
    let served = false;
    serveChannelBridgeTheme("telegram-notify/index", {
      startTelegramNotifyJobs: () => {
        served = true;
      },
    });
    (notifySeam.startTelegramNotifyJobs as unknown as () => void)();
    expect(served).toBe(true);
    resetChannelBridgeThemes();
    // the contract data stays on the legacy value even with a connector ready
    expect(ephemeralSeam.TELEGRAM_PRIVATE_ACTION_UNAVAILABLE).toBe(
      legacyEphemeralNoticeText,
    );
    expect(commandsSeam.TELEGRAM_DM_COMMANDS).toBe(legacyDmCommands);
  });
});

// The converted call sites: every symbol of the batches is imported from the
// seam, and none of them is left on the bridge module directly. The list is the
// call map of the task: batch 1 covers points 1-8 (addressing aliases), 41-45
// (forum topics), 46-49 (voice intake) and 55-63 (conversation identity); batch
// 3 (OPE-6976) adds points 53-54 (media intake and the rich tree's own binding
// call), 64-69 (the notify track), 71-72 (DM command menus) and 73-77 (the
// Telegram helper modules). The shared re-export of point 70 stays in
// `packages/shared` on purpose: it is the data contract (types and validators
// the board UI reads too), not a bridge call the connector can serve.
const BATCH_SEAM = "myrmidon/channel-connectors/bridge/";
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
  // myrmidon(1.6.6 CH-CONNECTOR-D) batch 3 (OPE-6976), the map points 53-77.
  {
    file: "services/chat-channels.ts",
    legacy: "chat-telegram-photo.js",
    seam: "channel-connectors/bridge/telegram-photo.js",
    symbols: ["telegramAttachmentForUpload"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "chat-telegram-ephemeral.js",
    seam: "channel-connectors/bridge/telegram-ephemeral.js",
    symbols: [
      "parseTelegramCallbackReceipt",
      "readTelegramCallbackProvenance",
      "telegramCallbackThreadId",
      "TELEGRAM_PRIVATE_ACTION_UNAVAILABLE",
      "isStoredTelegramPrivateActionUnavailableText",
      "TelegramCallbackReceipt",
    ],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "chat-telegram-media-intake.js",
    seam: "channel-connectors/bridge/telegram-media.js",
    symbols: [
      "hasTelegramMediaProvenance",
      "identifyTelegramMedia",
      "telegramMediaNeedsIdentification",
    ],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "chat-telegram-rich-intake.js",
    seam: "channel-connectors/bridge/telegram-rich.js",
    symbols: ["normalizeTelegramRichMessage"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/agent-chat-bridge/commands/index.js",
    seam: "channel-connectors/bridge/commands.js",
    symbols: ["TELEGRAM_DM_COMMANDS", "telegramDmCommandsForLocale"],
  },
  {
    file: "services/chat-channels.ts",
    legacy: "myrmidon/agent-chat-bridge/locales/index.js",
    seam: "channel-connectors/bridge/locales.js",
    symbols: ["telegramDmMenuLocale"],
  },
  {
    file: "services/chat-sdk-runtime.ts",
    legacy: "chat-telegram-ephemeral.js",
    seam: "channel-connectors/bridge/telegram-ephemeral.js",
    symbols: [
      "captureTelegramCallbackProvenance",
      "hasTelegramEphemeralInput",
      "sendTelegramCallbackNotice",
      "TelegramCallbackProvenance",
      "TelegramCallbackReceipt",
    ],
  },
  {
    file: "services/chat-sdk-runtime.ts",
    legacy: "chat-telegram-rich-intake.js",
    seam: "channel-connectors/bridge/telegram-rich.js",
    symbols: ["normalizeTelegramRichMessage"],
  },
  {
    // The rich tree's own call into the media module (map point 54): the rich
    // intake reaches `bindTelegramRichAttachment` through the media seam, so a
    // connector that serves the media theme also serves the binding.
    file: "services/chat-telegram-rich-intake.ts",
    legacy: "chat-telegram-media-intake.js",
    seam: "channel-connectors/bridge/telegram-media.js",
    symbols: ["bindTelegramRichAttachment"],
  },
  {
    file: "app.ts",
    legacy: "myrmidon/telegram-notify/index.js",
    seam: "channel-connectors/bridge/notify.js",
    symbols: ["myrmidonTelegramNotifyRoutes"],
  },
  {
    file: "app.ts",
    legacy: "myrmidon/telegram-notify/sweep.js",
    seam: "channel-connectors/bridge/notify-sweep.js",
    symbols: ["sweepTelegramNotifyProactivity"],
  },
  {
    file: "index.ts",
    legacy: "myrmidon/telegram-notify/index.js",
    seam: "channel-connectors/bridge/notify.js",
    symbols: [
      "startTelegramNotifyJobs",
      "startTgNotifySweep",
      "dbErrorChannelSettingsSource",
    ],
  },
  {
    file: "services/instance-settings.ts",
    legacy: "myrmidon/telegram-notify/proactivity-policy.js",
    seam: "channel-connectors/bridge/notify-policy.js",
    symbols: ["preserveTelegramNotifyGeneralKey"],
  },
  {
    file: "services/instance-settings.ts",
    legacy: "myrmidon/telegram-notify/settings-store.js",
    seam: "channel-connectors/bridge/notify-settings-store.js",
    symbols: ["preserveTelegramNotifySettingsGeneralKey"],
  },
];

// The batch-3 seam modules themselves must exist beside the registry: the
// ratchet above reads import specifiers from text, so a typo'd file name would
// pass it silently until the first real import breaks at build time.
const BATCH3_SEAM_MODULES = [
  "notify.ts",
  "notify-sweep.ts",
  "notify-policy.ts",
  "notify-settings-store.ts",
  "commands.ts",
  "telegram-media.ts",
  "telegram-photo.ts",
  "telegram-ephemeral.ts",
  "telegram-rich.ts",
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
  it("ship every batch-3 seam module beside the registry", () => {
    for (const name of BATCH3_SEAM_MODULES) {
      expect(existsSync(join(SRC_DIR, BATCH_SEAM, name))).toBe(true);
    }
  });

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