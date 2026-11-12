import {
  normalizeProviderGarbageOutcomeText,
  resolveProviderGarbageSettings,
} from "@myrmidon/shared";
import { parseObject } from "../adapters/utils.js";

// myrmidon(PROVIDER-GARBAGE / OPE-12286): burst detection helpers extracted
// from heartbeat.ts so the finalized-run path stays testable without loading
// the whole heartbeat module.

// myrmidon(PROVIDER-GARBAGE / OPE-12286 review 2 п.3): the burst identity used
// to deduplicate run.provider_garbage.detected events — one P1 event per
// (outcome text, model group) per sliding window. The normalized outcome is
// stored in the event payload as outcomeNormalized; the model group as
// modelGroup.
export function providerGarbageBurstKey(
  outcomeNormalized: string,
  modelGroup: string | null,
): string {
  return `${outcomeNormalized.trim().toLocaleLowerCase()}\u0000${(modelGroup ?? "")
    .trim()
    .toLocaleLowerCase()}`;
}

export function providerGarbageBurstKeyFromPayload(
  payload: unknown,
): string | null {
  const record = parseObject(payload);
  const outcomeNormalized = readNonEmptyString(record?.outcomeNormalized);
  if (!outcomeNormalized) return null;
  const modelGroup = readNonEmptyString(record?.modelGroup) ?? null;
  return providerGarbageBurstKey(outcomeNormalized, modelGroup);
}

// myrmidon(PROVIDER-GARBAGE / OPE-12286 review 2 п.1/п.2): map a finalized run
// row (any status — unknown stub outcomes finalize succeeded) to the detector
// input. The model group is the actual LiteLLM group persisted on the run row
// (providerModelGroup written at finalization from the adapter-reported or
// configured model) — never agents.modelTier (light/strong), which cannot
// identify a broken channel like nexus-grok-4.7.
export function providerGarbageRunDetectorInput(recent: {
  id: string;
  agentId: string;
  finishedAt: Date | null;
  error: string | null;
  resultJson: Record<string, unknown> | null;
}) {
  const recentResultJson = parseObject(recent.resultJson);
  const summaryVal = recentResultJson?.summary;
  const outcomeCandidate =
    typeof summaryVal === "string"
      ? summaryVal
      : typeof recent.error === "string"
        ? recent.error
        : null;
  return {
    runId: recent.id,
    agentId: recent.agentId,
    modelGroup: readNonEmptyString(recentResultJson?.providerModelGroup) ?? null,
    finishedAt: recent.finishedAt ?? new Date(),
    outcomeText: normalizeProviderGarbageOutcomeText(outcomeCandidate) || "",
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// Settings for the burst window: window/detection thresholds only. Retries
// being disabled (MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS=0) does not
// affect these — detection keeps its own defaults (review 2 п.4).
export function providerGarbageWindowSettings(
  env: Record<string, string | undefined>,
) {
  return resolveProviderGarbageSettings({ env });
}
