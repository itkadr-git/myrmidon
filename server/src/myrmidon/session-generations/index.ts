// server/src/myrmidon/session-generations/index.ts
//
// myrmidon(PERF-DIET-K): the entry point the run dispatch calls.
//
// `resolveHeartbeatSessionGeneration` answers one question per dispatched run:
// which generation of this task's session key is this run? It answers null —
// meaning "touch nothing" — for every run the feature does not own: another
// adapter, another session-key strategy, a wake without a task, or the feature
// switched off. For an issue-scoped container gateway task it returns the
// generation to use, whether the new generation starts with this run, why, and
// the handoff note that carries the task's context into it.
//
// One resolver (and so one cache) per database handle and process, like the
// board's other myrmidon runtimes.

import type { Db } from "@paperclipai/db";

import { decideSessionGeneration, renderSessionGenerationHandoff } from "./generations.js";
import { resolveSessionGenerationSettings, SESSION_GENERATIONS_SETTINGS_KEY, type SessionGenerationSettings } from "./settings.js";
import {
  createDbSessionGenerationStateReader,
  createSessionGenerationCache,
  DEFAULT_SESSION_GENERATION_SCAN_LIMIT,
  type SessionGenerationCache,
} from "./store.js";
import { instanceSettingsService } from "../../services/instance-settings.js";

export * from "./generations.js";
export * from "./settings.js";
export * from "./store.js";

/** The adapter whose issue-scoped sessions this feature bounds. */
export const SESSION_GENERATION_ADAPTER_TYPE = "hermes_gateway";

export interface RunSessionGeneration {
  /** The generation this run's session key carries (>= 1; 1 = no suffix). */
  generation: number;
  /** True when this run starts the generation. */
  rotate: boolean;
  reason: string | null;
  /** Runs recorded in the generation the decision was taken on. */
  messages: number;
  ageDays: number | null;
  /** The session key of the generation being left, when one was recorded. */
  previousSessionKey: string | null;
  /** Handoff note for the run that starts the generation (null when it does not). */
  handoffMarkdown: string | null;
}

export interface SessionGenerationResolveInput {
  companyId: string;
  agentId: string;
  adapterType: string | null | undefined;
  sessionKeyStrategy: string | null | undefined;
  issueId: string | null | undefined;
  continuationSummary?: string | null;
  now?: Date;
}

export interface SessionGenerationResolver {
  resolve(input: SessionGenerationResolveInput): Promise<RunSessionGeneration | null>;
}

/** The issue strategy is the default; only an explicit other strategy opts out. */
function normalizeStrategy(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

export function createSessionGenerationResolver(options: {
  reader: SessionGenerationCache;
  readSettings: () => Promise<SessionGenerationSettings>;
  now?: () => Date;
}): SessionGenerationResolver {
  const now = options.now ?? (() => new Date());
  return {
    async resolve(input) {
      if (input.adapterType !== SESSION_GENERATION_ADAPTER_TYPE) return null;
      if (normalizeStrategy(input.sessionKeyStrategy) !== "issue") return null;
      const issueId = typeof input.issueId === "string" && input.issueId.trim().length > 0
        ? input.issueId.trim()
        : null;
      if (!issueId) return null;
      const settings = await options.readSettings();
      if (!settings.enabled) return null;

      // The scan has to be able to see one more run than the activity
      // threshold, otherwise a task with a raised threshold would be rotated at
      // the scan bound instead. `maxMessages` is what the decision needs; the
      // default bound is kept as a floor.
      const scanLimit = Math.max(
        DEFAULT_SESSION_GENERATION_SCAN_LIMIT,
        Math.floor(settings.maxMessages) + 1,
      );
      const state = await options.reader.read({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId,
        scanLimit,
      });
      const at = input.now ?? now();
      const decision = decideSessionGeneration({
        state,
        thresholds: {
          enabled: settings.enabled,
          maxMessages: settings.maxMessages,
          maxDays: settings.maxDays,
        },
        now: at,
      });
      if (!decision.rotate) {
        return {
          generation: decision.generation,
          rotate: false,
          reason: null,
          messages: decision.messages,
          ageDays: decision.ageDays,
          previousSessionKey: null,
          handoffMarkdown: null,
        };
      }
      const reason = decision.reason ?? "session generation threshold reached";
      return {
        generation: decision.generation,
        rotate: true,
        reason,
        messages: decision.messages,
        ageDays: decision.ageDays,
        previousSessionKey: state.sessionKey,
        handoffMarkdown: renderSessionGenerationHandoff({
          previousSessionKey: state.sessionKey,
          issueId,
          generation: decision.generation,
          reason,
          messages: decision.messages,
          latestRunSummary: state.latestRunSummary,
          continuationSummary: input.continuationSummary ?? null,
        }),
      };
    },
  };
}

const resolvers = new WeakMap<Db, SessionGenerationResolver>();

/** The resolver of this process for this database handle. */
export function sessionGenerationResolver(db: Db): SessionGenerationResolver {
  const existing = resolvers.get(db);
  if (existing) return existing;
  const settings = instanceSettingsService(db);
  const resolver = createSessionGenerationResolver({
    reader: createSessionGenerationCache({
      reader: createDbSessionGenerationStateReader(db),
    }),
    readSettings: async () =>
      resolveSessionGenerationSettings({
        stored: (await settings.getGeneral())[SESSION_GENERATIONS_SETTINGS_KEY],
      }),
  });
  resolvers.set(db, resolver);
  return resolver;
}

/** Convenience for the run dispatch: the resolver of the process this db belongs to. */
export function resolveHeartbeatSessionGeneration(
  input: SessionGenerationResolveInput & { db: Db },
): Promise<RunSessionGeneration | null> {
  const { db, ...rest } = input;
  return sessionGenerationResolver(db).resolve(rest);
}