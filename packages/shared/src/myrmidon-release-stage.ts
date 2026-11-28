// myrmidon(1.8 RELEASE-STAGE): release authority, gate completion, and
// signed publication contract. This is deliberately pure so API and release
// tooling can enforce the same decision without trusting caller instructions.

import { z } from "zod";

export const RELEASE_CASTER_KEY = "release_manager" as const;
export const RELEASE_ACTIONS = ["sign_artifact", "publish_release"] as const;
export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];

export const RELEASE_CASTER_ALLOWED_ACTIONS: readonly ReleaseAction[] = RELEASE_ACTIONS;

export interface ReleaseGate {
  key: string;
  completed: boolean;
}

export interface ReleaseArtifact {
  artifactId: string;
  /** Exact immutable release tag, for example v2026.1114.1. */
  tag: string;
  /** Human-readable version represented by the tag. */
  version: string;
  /** Issue identifiers included in this candidate. */
  composition: string[];
  digest: string;
  signedAt: string;
  signedBy: { type: "agent" | "board"; id: string; casteKey?: string };
  verificationUrl: string;
}

export interface ReleaseStage {
  releaseId: string;
  gates: ReleaseGate[];
  artifact: ReleaseArtifact | null;
  publishedAt: string | null;
  publishedBy: { type: "agent" | "board"; id: string; casteKey?: string } | null;
  publicationUrl: string | null;
}

export const releaseGateSchema = z.object({
  key: z.string().min(1).max(120),
  completed: z.boolean(),
});

export const releaseStageSchema = z.object({
  releaseId: z.string().min(1).max(200),
  gates: z.array(releaseGateSchema).max(1000),
  artifact: z.object({
    artifactId: z.string().min(1).max(300),
    tag: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    composition: z.array(z.string().min(1).max(200)).min(1).max(1000),
    digest: z.string().min(1).max(512),
    signedAt: z.string().datetime(),
    signedBy: z.object({ type: z.enum(["agent", "board"]), id: z.string().min(1), casteKey: z.string().optional() }),
    verificationUrl: z.string().url(),
  }).nullable(),
  publishedAt: z.string().datetime().nullable(),
  publishedBy: z.object({ type: z.enum(["agent", "board"]), id: z.string().min(1), casteKey: z.string().optional() }).nullable(),
  publicationUrl: z.string().url().nullable(),
});

export type ReleaseStageDecision =
  | { allowed: true; action: ReleaseAction }
  | { allowed: false; action: ReleaseAction; code: "release_action_forbidden" | "release_gates_incomplete" | "release_signature_required" };

export function canReleaseAction(casteKey: string | null | undefined, action: ReleaseAction): ReleaseStageDecision {
  if (casteKey?.trim().toLowerCase().replace(/-/g, "_") !== RELEASE_CASTER_KEY) {
    return { allowed: false, action, code: "release_action_forbidden" };
  }
  return { allowed: true, action };
}

export function canPublishRelease(stage: ReleaseStage, casteKey: string | null | undefined): ReleaseStageDecision {
  if (!stage.gates || stage.gates.length === 0 || stage.gates.some((gate) => !gate.completed)) {
    return { allowed: false, action: "publish_release", code: "release_gates_incomplete" };
  }
  if (!stage.artifact) {
    return { allowed: false, action: "publish_release", code: "release_signature_required" };
  }
  const authority = canReleaseAction(casteKey, "publish_release");
  if (!authority.allowed) return authority;
  return authority;
}

export function signedReleaseReference(stage: ReleaseStage): { verificationUrl: string; signedBy: ReleaseArtifact["signedBy"] } | null {
  if (!stage.artifact) return null;
  return { verificationUrl: stage.artifact.verificationUrl, signedBy: stage.artifact.signedBy };
}
