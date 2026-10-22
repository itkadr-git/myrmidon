// server/src/myrmidon/telegram-voice-stt-intake/wiring.myrmidon.test.ts
//
// myrmidon(1.6.5 VOICE-STT A): the production wiring of the intake seam.
//
// Pins three things:
//   1. the per-company gate — the environment master switch wins in both
//      directions, otherwise the company's stored setting decides, and an
//      unreadable setting is "no answer" (the env value keeps its meaning);
//   2. the adapter — the core's `SttResult` maps onto the seam's
//      `VoiceTranscript` 1:1 and a core failure keeps its stable code;
//   3. end to end over the REAL core (service + DashScope backend over a fake
//      gateway): a MIME-less Telegram voice note (ogg) is recognized and its
//      text becomes the comment body while the attachment stays untouched; a
//      gateway failure is a skip, never a throw, and never leaks the key.

import { Buffer } from "node:buffer";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_VOICE_OGG } from "../../__tests__/fixtures/telegram-voice.js";
import { createChatSdkEndpointRuntime } from "../../services/chat-sdk-runtime.js";
import {
  resolveSttSettings,
  sttSettings,
  STT_BASE_URL_ENV,
  STT_ENABLED_ENV,
  STT_KEY_SECRET_ENV,
  STT_MODEL_ENV,
  type SttSettings,
} from "../stt/settings.js";
import { transcribeAudioWithMetadata } from "../stt/service.js";
import { SttError } from "../stt/types.js";
import type { SttRuntime } from "../stt/index.js";
import { transcribeTelegramVoiceIntake, telegramVoiceSttEnabled } from "./index.js";
import {
  createTelegramVoiceSttWiring,
  createTelegramVoiceSttWiringFromRuntime,
} from "./wiring.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const KEY_VALUE = "company-secret-value";

type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const runtimeOptions = {
  callbacks: { onMessage() {} },
  companyId: "fixture-company",
  endpointId: "fixture-endpoint",
  logger: "silent" as const,
  persistence: {
    async read() {
      return null;
    },
    async compareAndSet() {
      return true;
    },
    async deleteIfVersion() {
      return true;
    },
  },
  providerConfig: {
    provider: "telegram" as const,
    userName: "fixture_bot",
    credentials: { botToken: "1:synthetic", secretToken: "synthetic" },
  },
};

/** A runtime-parsed voice attachment (MIME-less, as Telegram sends it). */
function voiceAttachment(bytes: Buffer = TELEGRAM_VOICE_OGG) {
  const runtime = createChatSdkEndpointRuntime(runtimeOptions);
  const raw = {
    message_id: 50,
    date: 1_788_700_000,
    chat: { id: -10077, type: "supergroup" },
    from: { id: 77, is_bot: false, first_name: "Fixture" },
    voice: {
      file_id: "exact-file",
      file_unique_id: "exact-unique",
      file_size: bytes.length,
      duration: 1,
    },
  };
  const message = runtime.parseTelegramCommandMessage(raw)!;
  const attachment = message.attachments[0]!;
  const fetchData = vi.fn(async () => bytes);
  attachment.fetchData = fetchData;
  return { attachment, fetchData, runtime };
}

const configuredEnv = (): NodeJS.ProcessEnv => ({
  [STT_BASE_URL_ENV]: "http://gateway.example.com",
  [STT_KEY_SECRET_ENV]: "stt-key",
  [STT_MODEL_ENV]: "stt-model",
});

/** The real service + backend path over an injected fetch and key. */
function coreRuntime(
  settings: SttSettings,
  fetchImpl: FetchImpl,
  key: string | null = KEY_VALUE,
): SttRuntime {
  return {
    settings: async () => settings,
    transcribe: (companyId, input) =>
      transcribeAudioWithMetadata(
        {
          companyId,
          bytes: input.bytes,
          mimeType: input.mimeType,
          durationSec: input.durationSec,
        },
        { settings, fetch: fetchImpl, readCompanyKey: async () => key },
      ).then((outcome) => outcome.result),
  };
}

/** A Db shaped only as far as `readSttOverrides` walks it (select/from/where). */
function storedSettingsDb(companies: Record<string, unknown>): Db {
  const rows = [{ general: { myrmidonSttCompanies: companies } }];
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve(rows)),
  };
  return { select: () => chain } as unknown as Db;
}

const stored = (
  overrides: Partial<{
    enabled: boolean;
    backend: "dashscope" | "deepgram";
    model: string | null;
    language: "auto" | "ru";
    diarization: boolean;
    maxDurationSec: number;
    baseUrl: string | null;
    keySecret: string | null;
    deepgramKeySecret: string | null;
  }>,
) => overrides;
describe("the environment master switch (three states)", () => {
  it("names the value, or nothing at all, and never contradicts the company", () => {
    // An explicit value is the operator's kill switch: it wins over the
    // stored company setting in both directions.
    expect(telegramVoiceSttEnabled({ MYRMIDON_TELEGRAM_VOICE_STT: "1" }, false)).toBe(true);
    expect(telegramVoiceSttEnabled({ MYRMIDON_TELEGRAM_VOICE_STT: "0" }, true)).toBe(false);
    // Unset, empty or unrecognised: the company's stored setting decides, and
    // without one the feature stays off (byte-for-byte vendor path).
    expect(telegramVoiceSttEnabled({}, true)).toBe(true);
    expect(telegramVoiceSttEnabled({}, false)).toBe(false);
    expect(telegramVoiceSttEnabled({}, undefined)).toBe(false);
    expect(telegramVoiceSttEnabled({ MYRMIDON_TELEGRAM_VOICE_STT: "maybe" }, true)).toBe(true);
    expect(telegramVoiceSttEnabled({ MYRMIDON_TELEGRAM_VOICE_STT: "maybe" }, undefined)).toBe(false);
  });
});

describe("the per-company gate", () => {
  it("lets the environment master switch win in both directions, without a read", async () => {
    const settings = vi.fn(async () =>
      sttSettings({ ...configuredEnv(), [STT_ENABLED_ENV]: "1" }),
    );
    const runtime: SttRuntime = { settings, transcribe: vi.fn() };
    const on = createTelegramVoiceSttWiringFromRuntime(runtime, {
      env: { MYRMIDON_TELEGRAM_VOICE_STT: "1" },
    });
    await expect(on.companyEnabled(COMPANY_ID)).resolves.toBe(true);
    expect(settings).not.toHaveBeenCalled();
    const off = createTelegramVoiceSttWiringFromRuntime(runtime, {
      env: { MYRMIDON_TELEGRAM_VOICE_STT: "off" },
    });
    await expect(off.companyEnabled(COMPANY_ID)).resolves.toBe(false);
    expect(settings).not.toHaveBeenCalled();
  });

  it("falls back to the company's stored setting when the environment does not name one", async () => {
    const runtimeFor = (enabled: boolean): SttRuntime => ({
      settings: async () =>
        sttSettings({ ...configuredEnv(), [STT_ENABLED_ENV]: enabled ? "1" : "0" }),
      transcribe: vi.fn(),
    });
    await expect(
      createTelegramVoiceSttWiringFromRuntime(runtimeFor(true), { env: {} }).companyEnabled(
        COMPANY_ID,
      ),
    ).resolves.toBe(true);
    await expect(
      createTelegramVoiceSttWiringFromRuntime(runtimeFor(false), { env: {} }).companyEnabled(
        COMPANY_ID,
      ),
    ).resolves.toBe(false);
  });

  it("an unreadable stored setting is 'no answer', not an error", async () => {
    const runtime: SttRuntime = {
      settings: async () => {
        throw new Error("settings are not readable");
      },
      transcribe: vi.fn(),
    };
    await expect(
      createTelegramVoiceSttWiringFromRuntime(runtime, { env: {} }).companyEnabled(COMPANY_ID),
    ).resolves.toBeNull();
  });
});

describe("the transcriber adapter", () => {
  it("maps the core result onto the seam contract 1:1", async () => {
    const result = {
      text: "привет",
      segments: [{ speaker: "1", startMs: 0, endMs: 500, text: "привет" }],
      language: "ru",
      durationMs: 500,
      truncated: false,
      backend: "dashscope",
    };
    const transcribe = vi.fn(async () => result);
    const wiring = createTelegramVoiceSttWiringFromRuntime(
      { settings: vi.fn(), transcribe },
      { env: {} },
    );
    await expect(
      wiring.transcriber.transcribeAudio({
        companyId: COMPANY_ID,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "audio/ogg",
      }),
    ).resolves.toEqual(result);
    expect(transcribe).toHaveBeenCalledWith(COMPANY_ID, {
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
    });
  });

  it("lets a core failure keep its stable code", async () => {
    const wiring = createTelegramVoiceSttWiringFromRuntime(
      {
        settings: vi.fn(),
        transcribe: vi.fn(async () => {
          throw new SttError("stt_timeout", "STT backend did not answer within 1000 ms");
        }),
      },
      { env: {} },
    );
    await expect(
      wiring.transcriber.transcribeAudio({
        companyId: COMPANY_ID,
        bytes: new Uint8Array([1]),
        mimeType: "audio/ogg",
      }),
    ).rejects.toMatchObject({ code: "stt_timeout" });
  });
});

describe("the real core behind the intake seam", () => {
  const voiceSettings = () =>
    resolveSttSettings(
      sttSettings({
        ...configuredEnv(),
        [STT_ENABLED_ENV]: "1",
        // One chunk, so the recording goes to the gateway in a single call
        // whatever the fixture's own length is.
        MYRMIDON_STT_CHUNK_SEC: "300",
      }),
      null,
    );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns a MIME-less ogg voice note into the comment body, keeping the attachment", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      Response.json({
        text: "привет, это голосовое сообщение",
        segments: [
          {
            start: 0,
            end: 0.4,
            speaker: 1,
            text: "привет, это голосовое сообщение",
          },
        ],
        language: "ru",
      }),
    );
    const wiring = createTelegramVoiceSttWiringFromRuntime(
      coreRuntime(voiceSettings(), fetchImpl),
      { env: {} },
    );
    const item = voiceAttachment();
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: COMPANY_ID,
        senderText: "",
        voiceAttachments: [item.attachment],
        // The environment names no switch: the company's own setting is what
        // turns the feature on here (no restart involved).
        env: {},
        companyEnabled: await wiring.companyEnabled(COMPANY_ID),
        transcriber: wiring.transcriber,
      });
      expect(outcome.skip).toBeNull();
      expect(outcome.body).toContain("привет, это голосовое сообщение");
      expect(outcome.body).toContain("Говорящий 1 [0:00]");
      // The vendor lane still stores the attachment: the prefetch only read it.
      expect(item.fetchData).toHaveBeenCalledOnce();
      expect(item.attachment.type).toBe("audio");
      // The gateway call is the DashScope path with the configured model.
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe("http://gateway.example.com/v1/audio/transcriptions");
      expect((init?.body as FormData).get("model")).toBe("stt-model");
      expect(JSON.stringify(outcome)).not.toContain(KEY_VALUE);
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("keeps the vendor path when the gateway fails: a skip, never a throw", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      async () => new Response(`upstream echoed ${KEY_VALUE}`, { status: 502 }),
    );
    const wiring = createTelegramVoiceSttWiringFromRuntime(
      coreRuntime(voiceSettings(), fetchImpl),
      { env: {} },
    );
    const item = voiceAttachment();
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: COMPANY_ID,
        senderText: "",
        voiceAttachments: [item.attachment],
        env: {},
        companyEnabled: true,
        transcriber: wiring.transcriber,
      });
      expect(outcome.body).toBeNull();
      expect(outcome.skip).toBe("stt_upstream_error");
      // Nothing but the code leaves the failure path — not even the key the
      // upstream echoed back.
      expect(JSON.stringify(outcome)).not.toContain(KEY_VALUE);
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("degrades an unregistered gateway model to stt_unconfigured", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      Response.json({ error: { message: "Invalid model name stt-model" } }, { status: 400 }),
    );
    const wiring = createTelegramVoiceSttWiringFromRuntime(
      coreRuntime(voiceSettings(), fetchImpl),
      { env: {} },
    );
    const item = voiceAttachment();
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: COMPANY_ID,
        senderText: "",
        voiceAttachments: [item.attachment],
        env: {},
        companyEnabled: true,
        transcriber: wiring.transcriber,
      });
      expect(outcome.body).toBeNull();
      expect(outcome.skip).toBe("stt_unconfigured");
    } finally {
      await item.runtime.shutdown();
    }
  });

  it("does not even download the bytes when the company switch is off", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => Response.json({ text: "never" }));
    const wiring = createTelegramVoiceSttWiringFromRuntime(
      coreRuntime(voiceSettings(), fetchImpl),
      { env: {} },
    );
    const item = voiceAttachment();
    try {
      const outcome = await transcribeTelegramVoiceIntake({
        companyId: COMPANY_ID,
        senderText: "",
        voiceAttachments: [item.attachment],
        env: {},
        companyEnabled: false,
        transcriber: wiring.transcriber,
      });
      expect(outcome.skip).toBe("stt_disabled");
      expect(outcome.body).toBeNull();
      expect(item.fetchData).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await item.runtime.shutdown();
    }
  });
});

describe("createTelegramVoiceSttWiring (production factory)", () => {
  it("reads the company switch from the stored settings through the database", async () => {
    const wiring = createTelegramVoiceSttWiring({
      db: storedSettingsDb({
        [COMPANY_ID]: stored({
          enabled: true,
          backend: "dashscope",
          model: "stt-model",
          language: "auto",
          diarization: false,
          maxDurationSec: 1800,
          baseUrl: "http://gateway.example.com",
          keySecret: "stt-key",
          deepgramKeySecret: null,
        }),
      }),
      env: {},
    });
    await expect(wiring.companyEnabled(COMPANY_ID)).resolves.toBe(true);
    // A company without a stored setting keeps the default: off.
    await expect(
      wiring.companyEnabled("22222222-2222-4222-8222-222222222222"),
    ).resolves.toBe(false);
  });

  it("an unreadable database is 'no answer', not a delivery failure", async () => {
    const wiring = createTelegramVoiceSttWiring({
      db: {
        select: () => {
          throw new Error("database is down");
        },
      } as unknown as Db,
      env: {},
    });
    await expect(wiring.companyEnabled(COMPANY_ID)).resolves.toBeNull();
  });

  it("the environment master switch answers before the database is touched", async () => {
    const wiring = createTelegramVoiceSttWiring({
      db: {
        select: () => {
          throw new Error("database is down");
        },
      } as unknown as Db,
      env: { MYRMIDON_TELEGRAM_VOICE_STT: "1" },
    });
    await expect(wiring.companyEnabled(COMPANY_ID)).resolves.toBe(true);
  });
});
