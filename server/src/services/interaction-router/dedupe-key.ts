import { createHash } from "node:crypto";

export interface InteractionDedupeKeyInput {
  source: string;
  sourceEventId: string;
  issueId: string;
  routeType: string;
}

/** Build a stable, bounded database key for one routed source event. */
export function buildInteractionDedupeKey(input: InteractionDedupeKeyInput): string {
  const parts = [input.source, input.sourceEventId, input.issueId, input.routeType];
  if (parts.some((part) => !part.trim())) {
    throw new Error("Interaction dedupe key components must be non-empty");
  }
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `interaction-route:${digest}`;
}
