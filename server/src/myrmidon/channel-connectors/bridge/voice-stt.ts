// myrmidon(1.6.6 CH-CONNECTOR-D): the voice intake theme of the bridge.
//
// The core imports the theme from here instead of
// `telegram-voice-stt-intake/index.js` (the transcription of an inbound voice
// message) and `telegram-voice-stt-intake/wiring.js` (the production wiring
// `server/src/app.ts` builds); without a connector serving the theme the legacy
// modules answer (fail-open).
import * as intake from "../../telegram-voice-stt-intake/index.js";
import * as wiring from "../../telegram-voice-stt-intake/wiring.js";
import type {
  TelegramVoiceSttCompanyGate,
  TelegramVoiceTranscriber,
} from "../../telegram-voice-stt-intake/index.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramVoiceSttCompanyGate, TelegramVoiceTranscriber };

const intakeTheme = () =>
  channelBridgeTheme("telegram-voice-stt-intake/index", intake);

const wiringTheme = () =>
  channelBridgeTheme("telegram-voice-stt-intake/wiring", wiring);

export const transcribeTelegramVoiceIntake: typeof intake.transcribeTelegramVoiceIntake =
  (...args) => intakeTheme().transcribeTelegramVoiceIntake(...args);

export const createTelegramVoiceSttWiring: typeof wiring.createTelegramVoiceSttWiring =
  (...args) => wiringTheme().createTelegramVoiceSttWiring(...args);