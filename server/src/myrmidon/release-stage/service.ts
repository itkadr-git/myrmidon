// server/src/myrmidon/release-stage/service.ts
//
// myrmidon(1.8 RELEASE-STAGE): the release stage service — release authority
// (who may act), gate completion (what must be true), and signed publication
// (the observable outcome).
//
// The caste/autonomy contracts this builds on:
//  - the company caste directory (server/src/myrmidon/castes): a caste is any
//    key in `agent_castes`; "release manager" is a caste key, not a hardcoded
//    enum entry, so a company names its own releaser;
//  - the autonomy matrix (server/src/myrmidon/autonomy): role (caste key) ×
//    action class → verdict. This service resolves release actions through
//    the SAME matrix so a caste can never hold a right the matrix forbids,
//    and the release-manager role rows pin the two release actions.
//
// Pure dependency-injected core, the same shape as the castes and autonomy
// modules: the real wiring reads the database, tests pass in-memory stores.

import {
  resolveAutonomy,
  type AutonomyActionClass,
  type AutonomyMatrix,
  type ReleaseAction,
  type ReleaseGate,
  type ReleaseStage,
} from "@myrmidon/shared";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";

/** Stable error codes; the UI and tests match on these. */
export const RELEASE_ACTION_FORBIDDEN_CODE = "release_action_forbidden";
export const RELEASE_GATES_INCOMPLETE_CODE = "release_gates_incomplete";
export const RELEASE_SIGNATURE_REQUIRED_CODE = "release_signature_required";
export const RELEASE_STAGE_NOT_FOUND_CODE = "release_stage_not_found";

/** The actor that attempts a release action: an agent (by caste) or the board. */
export interface ReleaseActor {
  type: "agent" | "board";
  id: string;
  /** The agent's caste key (`agents.role`); null for board actors. */
  casteKey?: string | null;
}

/** The authority decision for one release action attempt. */
export type ReleaseAuthorityDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: typeof RELEASE_ACTION_FORBIDDEN_CODE;
      action: ReleaseAction;
      role: string | null;
    };

/**
 * Resolve whether this actor may take this release action at all.
 *
 * Rules, in order:
 *  1. the board may always act (the board is the releaser of last resort and
 *     the editor of the gates);
 *  2. the agent must hold the release-manager caste — a company-defined caste
 *     KEY (the company names its releaser in the caste directory); any other
 *     caste falls through like every unknown role, no accidental authority;
 *  3. AND the SHARED `resolveAutonomy` resolver must yield an explicit
 *     `allowed` for the release deploy class (agent > role > default, the same
 *     resolution that gates every other seam), so `forbidden` here is the
 *     same `forbidden` everywhere (authz_forbidden 403, code
 *     release_action_forbidden). Both halves are required: the caste key
 *     alone is not authority, and a broad deploy allowance on another caste
 *     alone is not release authority.
 */
export function resolveReleaseAuthority(
  actor: ReleaseActor,
  action: ReleaseAction,
  matrix: AutonomyMatrix,
  actionClass: AutonomyActionClass = "deploy",
): ReleaseAuthorityDecision {
  if (actor.type === "board") return { allowed: true };
  // The release-manager caste is the only caste eligible for this seam. The
  // autonomy matrix still supplies the explicit `allowed` verdict, including
  // agent-specific overrides; a broad deploy permission on another caste must
  // not become release authority accidentally.
  const normalizedCaste = actor.casteKey?.trim().toLowerCase().replace(/-/g, "_") ?? null;
  const isReleaseManager = normalizedCaste === "release_manager";
  if (
    !isReleaseManager ||
    resolveAutonomy(normalizedCaste, actionClass, matrix, actor.id) !== "allowed"
  ) {
    return { allowed: false, code: RELEASE_ACTION_FORBIDDEN_CODE, action, role: actor.casteKey ?? null };
  }
  return { allowed: true };
}

/** What the gate list must confirm before anything publishes. */
export function releaseGatesComplete(gates: ReleaseGate[]): boolean {
  return gates.length > 0 && gates.every((gate) => gate.completed);
}

/**
 * The full pre-publication check: authority, then gates, then signature.
 * Order matters — the failure reason is the operator's first actionable fact.
 */
export function evaluatePublication(
  actor: ReleaseActor,
  stage: ReleaseStage,
  matrix: AutonomyMatrix,
): { ok: true } | { ok: false; code: string; detail: Record<string, unknown> } {
  const authority = resolveReleaseAuthority(actor, "publish_release", matrix);
  if (!authority.allowed) {
    return {
      ok: false,
      code: RELEASE_ACTION_FORBIDDEN_CODE,
      detail: { action: "publish_release", role: authority.role },
    };
  }
  if (!releaseGatesComplete(stage.gates)) {
    return {
      ok: false,
      code: RELEASE_GATES_INCOMPLETE_CODE,
      detail: {
        incomplete: stage.gates.filter((gate) => !gate.completed).map((gate) => gate.key),
      },
    };
  }
  if (!stage.artifact || !stage.artifact.signedAt || !stage.artifact.verificationUrl) {
    return {
      ok: false,
      code: RELEASE_SIGNATURE_REQUIRED_CODE,
      detail: { artifactId: stage.artifact?.artifactId ?? null },
    };
  }
  return { ok: true };
}

/** One release stage as the API answers it. */
export interface ReleaseStageView extends ReleaseStage {
  /** True when every gate is completed (a stage with no gates is never ready). */
  gatesComplete: boolean;
  /** True when a signed artifact exists and is verifiable by URL. */
  signaturePresent: boolean;
  /** True when the release has been published, with who and where. */
  published: boolean;
}

export function releaseStageView(stage: ReleaseStage): ReleaseStageView {
  return {
    ...stage,
    gatesComplete: releaseGatesComplete(stage.gates),
    signaturePresent: Boolean(
      stage.artifact?.signedAt && stage.artifact?.verificationUrl,
    ),
    published: Boolean(stage.publishedAt && stage.publicationUrl && stage.publishedBy),
  };
}

// ---------------------------------------------------------------------------
// Mutable stage store (in-memory core; the database wiring replaces it).
// ---------------------------------------------------------------------------

export interface ReleaseStageStore {
  find(companyId: string, releaseId: string): Promise<ReleaseStage | null>;
  list(companyId: string): Promise<ReleaseStage[]>;
  save(companyId: string, stage: ReleaseStage): Promise<void>;
}

export function createInMemoryReleaseStageStore(): ReleaseStageStore {
  const stages = new Map<string, ReleaseStage>();
  const keyOf = (companyId: string, releaseId: string) => `${companyId}::${releaseId}`;
  return {
    async find(companyId, releaseId) {
      return stages.get(keyOf(companyId, releaseId)) ?? null;
    },
    async list(companyId) {
      return [...stages.entries()]
        .filter(([key]) => key.startsWith(`${companyId}::`))
        .map(([, stage]) => stage);
    },
    async save(companyId, stage) {
      stages.set(keyOf(companyId, releaseIdOf(stage)), stage);
    },
  };
}

function releaseIdOf(stage: ReleaseStage): string {
  return stage.releaseId;
}

/**
 * The release stage service: authority + gates + signature + publication,
 * all company-scoped, every mutation auditable by the caller through the
 * returned events.
 */
export function createReleaseStageService(deps: {
  store: ReleaseStageStore;
  matrixOf: (companyId: string) => Promise<AutonomyMatrix>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function loadStage(companyId: string, releaseId: string): Promise<ReleaseStage> {
    const stage = await deps.store.find(companyId, releaseId);
    if (!stage) {
      throw notFound(`Release stage "${releaseId}" not found`, { code: RELEASE_STAGE_NOT_FOUND_CODE });
    }
    return stage;
  }

  return {
    /** GET one stage. */
    async getStage(companyId: string, releaseId: string): Promise<ReleaseStageView> {
      return releaseStageView(await loadStage(companyId, releaseId));
    },

    /** GET all stages of the company. */
    async listStages(companyId: string): Promise<ReleaseStageView[]> {
      const stages = await deps.store.list(companyId);
      return stages.map(releaseStageView);
    },

    /**
     * POST: create or replace the stage definition (gates). Board-only at the
     * route layer; the service enforces "not after publication".
     */
    async defineStage(input: {
      companyId: string;
      releaseId: string;
      gates: ReleaseGate[];
      actor: ReleaseActor;
    }): Promise<ReleaseStageView> {
      if (input.actor.type !== "board") {
        throw forbidden("only the board defines release gates", { code: RELEASE_ACTION_FORBIDDEN_CODE });
      }
      const existing = await deps.store.find(input.companyId, input.releaseId);
      if (existing?.publishedAt) {
        throw conflict("release already published; gates are immutable", {
          code: "release_already_published",
        });
      }
      const stage: ReleaseStage = {
        releaseId: input.releaseId,
        gates: input.gates,
        artifact: existing?.artifact ?? null,
        publishedAt: existing?.publishedAt ?? null,
        publishedBy: existing?.publishedBy ?? null,
        publicationUrl: existing?.publicationUrl ?? null,
      };
      await deps.store.save(input.companyId, stage);
      return releaseStageView(stage);
    },

    /**
     * POST sign: record the signature of the release artifact. Allowed for the
     * board and for agents whose caste the autonomy matrix allows for the
     * release deploy class. Refuses to sign twice with a different signer.
     */
    async signArtifact(input: {
      companyId: string;
      releaseId: string;
      artifactId: string;
      tag: string;
      version: string;
      composition: string[];
      digest: string;
      verificationUrl: string;
      actor: ReleaseActor;
    }): Promise<ReleaseStageView> {
      const matrix = await deps.matrixOf(input.companyId);
      const authority = resolveReleaseAuthority(input.actor, "sign_artifact", matrix);
      if (!authority.allowed) {
        throw forbidden("this caste may not sign release artifacts", {
          code: RELEASE_ACTION_FORBIDDEN_CODE,
          actionClass: "deploy",
          role: authority.role,
        });
      }
      const stage = await loadStage(input.companyId, input.releaseId);
      if (stage.publishedAt) {
        throw conflict("release already published", { code: "release_already_published" });
      }
      if (stage.artifact && stage.artifact.signedBy.id !== input.actor.id) {
        throw conflict("artifact already signed by another actor", {
          code: "release_already_signed",
        });
      }
      const signed: ReleaseStage = {
        ...stage,
        artifact: {
          artifactId: input.artifactId,
          tag: input.tag,
          version: input.version,
          composition: [...new Set(input.composition)].sort(),
          digest: input.digest,
          signedAt: now().toISOString(),
          signedBy:
            input.actor.type === "board"
              ? { type: "board", id: input.actor.id }
              : { type: "agent", id: input.actor.id, casteKey: input.actor.casteKey ?? undefined },
          verificationUrl: input.verificationUrl,
        },
      };
      await deps.store.save(input.companyId, signed);
      return releaseStageView(signed);
    },

    /**
     * POST publish: the final gate. Refuses unless the actor holds authority,
     * every release gate is completed, and a signed artifact with a
     * verification URL exists. The result carries the verifiable publication
     * reference (URL + signer authorship).
     */
    async publishRelease(input: {
      companyId: string;
      releaseId: string;
      publicationUrl: string;
      actor: ReleaseActor;
    }): Promise<ReleaseStageView> {
      const matrix = await deps.matrixOf(input.companyId);
      const authority = resolveReleaseAuthority(input.actor, "publish_release", matrix);
      if (!authority.allowed) {
        throw forbidden("this caste may not publish releases", {
          code: RELEASE_ACTION_FORBIDDEN_CODE,
          action: "publish_release",
          role: authority.role,
        });
      }
      const stage = await loadStage(input.companyId, input.releaseId);
      if (stage.publishedAt) {
        if (stage.publicationUrl === input.publicationUrl) return releaseStageView(stage);
        throw conflict("release already published at a different URL", {
          code: "release_already_published",
          publicationUrl: stage.publicationUrl,
        });
      }
      const evaluation = evaluatePublication(input.actor, stage, matrix);
      if (!evaluation.ok) {
        if (evaluation.code === RELEASE_ACTION_FORBIDDEN_CODE) {
          throw forbidden("this caste may not publish releases", {
            code: RELEASE_ACTION_FORBIDDEN_CODE,
            ...evaluation.detail,
          });
        }
        if (evaluation.code === RELEASE_GATES_INCOMPLETE_CODE) {
          throw conflict("release gates are not complete", {
            code: RELEASE_GATES_INCOMPLETE_CODE,
            ...evaluation.detail,
          });
        }
        throw badRequest("release artifact is not signed", {
          code: RELEASE_SIGNATURE_REQUIRED_CODE,
          ...evaluation.detail,
        });
      }
      const published: ReleaseStage = {
        ...stage,
        publishedAt: now().toISOString(),
        publishedBy:
          input.actor.type === "board"
            ? { type: "board", id: input.actor.id }
            : { type: "agent", id: input.actor.id, casteKey: input.actor.casteKey ?? undefined },
        publicationUrl: input.publicationUrl,
      };
      await deps.store.save(input.companyId, published);
      return releaseStageView(published);
    },
  };
}

export type ReleaseStageService = ReturnType<typeof createReleaseStageService>;
