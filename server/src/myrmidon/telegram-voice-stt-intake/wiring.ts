// server/src/myrmidon/telegram-voice-stt-intake/wiring.ts
//
// myrmidon(1.6.5 VOICE-STT A): the production wiring of the intake seam.
//
// Part B landed the intake hook as an injectable seam
// (`telegramVoiceTranscriber` on `chatChannelService`) and deliberately left
// the real core unconnected until part A1 merged: with the flag on but no
// transcriber injected, every voice turn recorded a `stt_unconfigured` skip.
// A1 merged later (`server/src/myrmidon/stt/`), so this module closes the
// gap — one call in `server/src/app.ts` binds the shared STT core to the
// seam and the feature works end to end.
//
// Two things are wired here:
//
//   - `transcriber` — the core's `transcribeAudio` behind the seam's
//     `TelegramVoiceTranscriber` contract. The core resolves the contour per
//     call (environment defaults, the company's stored overrides, the key
//     read by name from the company's secrets), so a backend change, a key
//     rotation or a settings PATCH takes effect on the next voice message —
//     no restart. A failure is a `SttError` with a stable code, which the
//     intake classifies into a skip code: the delivery is never affected.
//   - `companyEnabled` — the per-company switch. Part B gated the intake on
//     the environment variable alone, which needs a restart to flip; the
//     board's settings screen (part C) writes the per-company document
//     instead. The gate reads the environment master switch first and falls
//     back to the company's stored setting, so both ways work and the
//     default stays off.
//
// Nothing here logs or returns a key value: the core is the only place that
// touches the secret, and its errors carry codes, not values.

import type { Db } from "@paperclipai/db";
import { createSttRuntime, type SttRuntime } from "../stt/index.js";
import type { TelegramVoiceTranscriber } from "./index.js";
import { readTelegramVoiceSttSwitch } from "./settings.js";

/**
 * Resolves the per-company switch of the intake. `null` means "no answer"
 * (the stored setting could not be read): the caller then keeps the
 * environment master switch as the only gate.
 */
export type TelegramVoiceSttCompanyGate = (
  companyId: string,
) => Promise<boolean | null>;

export interface TelegramVoiceSttWiring {
  transcriber: TelegramVoiceTranscriber;
  companyEnabled: TelegramVoiceSttCompanyGate;
}

export interface TelegramVoiceSttWiringDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/** Production entry point: the shared STT core over the instance database. */
export function createTelegramVoiceSttWiring(
  deps: TelegramVoiceSttWiringDeps,
): TelegramVoiceSttWiring {
  const env = deps.env ?? process.env;
  const runtime = createSttRuntime({
    db: deps.db,
    env,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return createTelegramVoiceSttWiringFromRuntime(runtime, { env });
}

/**
 * The same wiring over an already-built runtime. Kept separate so a test can
 * drive it with the real core (or a stub) without a database.
 */
export function createTelegramVoiceSttWiringFromRuntime(
  runtime: SttRuntime,
  options: { env?: NodeJS.ProcessEnv } = {},
): TelegramVoiceSttWiring {
  const env = options.env ?? process.env;
  return {
    transcriber: {
      async transcribeAudio(input) {
        const result = await runtime.transcribe(input.companyId, {
          bytes: input.bytes,
          mimeType: input.mimeType,
          ...(input.durationSec === undefined
            ? {}
            : { durationSec: input.durationSec }),
        });
        // myrmidon(1.6.5 VOICE-STT A): `SttResult` and the seam's
        // `VoiceTranscript` are the same shape (text, segments, language,
        // durationMs, truncated, backend) — the seam reuses the core's
        // contract, so no field is invented or dropped here.
        return {
          text: result.text,
          segments: result.segments,
          language: result.language,
          durationMs: result.durationMs,
          truncated: result.truncated,
          backend: result.backend,
          // myrmidon(1.6.5 VOICE-STT B): the core's diarization report travels
          // with the transcript, so the comment body can carry the explicit
          // marker instead of presenting an unlabeled transcript as one voice.
          diarization: result.diarization,
        };
      },
    },
    companyEnabled: async (companyId) => {
      // The environment master switch wins in both directions: an explicit
      // value is the operator's kill switch and must not be overridden by a
      // stored company setting.
      const master = readTelegramVoiceSttSwitch(env);
      if (master !== null) return master;
      try {
        const settings = await runtime.settings(companyId);
        return settings.enabled;
      } catch {
        // A settings read is not worth failing a delivery over: the caller
        // falls back to the environment value (off unless it says otherwise).
        return null;
      }
    },
  };
}