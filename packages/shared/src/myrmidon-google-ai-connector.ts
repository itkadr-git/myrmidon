// myrmidon(GOOGLE-AI-CONNECT-UI): shared contracts of the Google AI Pro
// subscription connector.
//
// The board owns one owner-authorized session (the browser cookies of the
// owner's Google account on gemini.google.com) and hands agents capabilities
// through the subscription bridge. The bridge contract is frozen and lives in
// the deploy repository; these types are the wire contract between the API,
// the UI and the agent-facing call surface. English-only copy, neutral test
// data only: no internal addresses, hosts or agent names, and never a cookie
// value.

import { z } from "zod";

/** Capabilities the connector grants per agent. `generate_video` ships marked
 * disabled until the owner enables it (quota and ban-risk decision). */
export const GAI_CAPABILITIES = ["generate_image", "generate_video", "creative_text"] as const;
export type GaiCapability = (typeof GAI_CAPABILITIES)[number];

/** Connection status the owner sees on the screen. */
export const GAI_CONNECTION_STATUSES = ["connected", "stale", "error"] as const;
export type GaiConnectionStatus = (typeof GAI_CONNECTION_STATUSES)[number];

/** How the session secret reaches the bridge. `endpoint` — the bridge pulls
 * the rotated bundle from the board with the operator-provisioned token;
 * `hook` — the board pushes the bundle to a rotation hook URL; `off` — the
 * delivery is disabled and the operator runbook path stays in charge. */
export const GAI_DELIVERY_MODES = ["endpoint", "hook", "off"] as const;
export type GaiDeliveryMode = (typeof GAI_DELIVERY_MODES)[number];

export const GAI_GRANT_TARGET_KINDS = ["agent", "caste", "all"] as const;
export type GaiGrantTargetKind = (typeof GAI_GRANT_TARGET_KINDS)[number];

/** One company's connection record. Carries no secret material: the session
 * lives in the instance secret store and only its id is referenced. */
export interface GaiConnection {
  id: string;
  companyId: string;
  status: GaiConnectionStatus;
  /** Id of the connector-owned company secret holding the cookie bundle. */
  secretId: string;
  connectedAt: string;
  connectedBy: string;
  /** Last health probe of the bridge and what it answered. */
  lastCheckedAt: string | null;
  lastSession: "ok" | "stale" | null;
  lastError: string | null;
}

export interface GaiGrant {
  id: string;
  companyId: string;
  capability: GaiCapability;
  targetKind: GaiGrantTargetKind;
  /** Set for `agent` targets. */
  agentId: string | null;
  /** Set for `caste` targets. */
  caste: string | null;
  createdAt: string;
  createdBy: string;
}

/** One journal row: every bridge call attempt by an agent (and the owner's
 * trial and health actions), allowed or refused. */
export interface GaiJournalEntry {
  id: string;
  at: string;
  /** Agent id, or the board user id for owner actions. */
  actor: string;
  actorKind: "agent" | "owner";
  /** text | image | video for calls; check | connect | disconnect for owner actions. */
  action: string;
  ok: boolean;
  /** Short outcome: refusal reason, bridge error code, or "ok". Never a secret. */
  detail: string;
}

export interface GaiQuotaBucket {
  used: number | null;
  limit: number | null;
}

/** The bridge's health projection onto the board. Mirrors the frozen
 * `GET /v1/health` contract: { session, quota, version }. */
export interface GaiHealth {
  session: "ok" | "stale";
  quota: {
    images: GaiQuotaBucket;
    videos: GaiQuotaBucket;
    paused: boolean;
    pausedUntil: string | null;
  };
  version: string | null;
}

/** What the state route answers: everything the screen renders. */
export interface GaiStateView {
  connection: GaiConnection | null;
  grants: GaiGrant[];
  health: GaiHealth | null;
  capabilities: Array<{ id: GaiCapability; enabled: boolean }>;
  deliveryMode: GaiDeliveryMode;
}

/** The cookie names the bridge session needs (fixed by the session runbook). */
export const GAI_REQUIRED_COOKIE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS"] as const;

/**
 * The owner's paste payload. Two accepted shapes, both what a browser cookie
 * export gives:
 *  - an array of cookie objects with `name` and `value` (EditThisCookie /
 *    FireCookie export format, other fields ignored);
 *  - a plain object mapping cookie name to value.
 * The server keeps only the two required names; everything else is dropped.
 */
export const gaiCookiePasteSchema = z.object({
  companyId: z.string().trim().min(1).max(120),
  /** The raw paste: a JSON string in one of the two shapes above. Kept as a
   * string so this schema can guard the route before any parsing. */
  cookieJson: z.string().min(2).max(200_000),
});
export type GaiCookiePaste = z.infer<typeof gaiCookiePasteSchema>;

export const gaiGrantPutSchema = z
  .object({
    companyId: z.string().trim().min(1).max(120),
    capability: z.enum(GAI_CAPABILITIES),
    targetKind: z.enum(GAI_GRANT_TARGET_KINDS),
    agentId: z.string().trim().min(1).max(120).optional(),
    caste: z.string().trim().min(1).max(60).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.targetKind === "agent" && !value.agentId) {
      ctx.addIssue({ code: "custom", message: "an agent grant needs agentId", path: ["agentId"] });
    }
    if (value.targetKind === "caste" && !value.caste) {
      ctx.addIssue({ code: "custom", message: "a caste grant needs caste", path: ["caste"] });
    }
  });
export type GaiGrantPut = z.infer<typeof gaiGrantPutSchema>;

/** The agent-facing call: the board resolves the grant, then forwards to the
 * frozen bridge contract. Video is refused while disabled. */
export const gaiCallSchema = z.object({
  kind: z.enum(["text", "image", "video"]),
  prompt: z.string().trim().min(1).max(8000),
});
export type GaiCall = z.infer<typeof gaiCallSchema>;

/** Owner trial from the screen: a prompt the board runs as the owner. */
export const gaiTrialSchema = z.object({
  companyId: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000).optional(),
});
export type GaiTrial = z.infer<typeof gaiTrialSchema>;

/** The names agents see for the board call surface. */
export const GAI_TOOL_NAMES = ["google_ai_generate"] as const;
export type GaiToolName = (typeof GAI_TOOL_NAMES)[number];

/** Result row the screen and the agent call show for a finished generation.
 * The bridge answers image paths inside its workspace; the frozen contract
 * has no byte download, so the board surfaces text plus workspace paths. */
export interface GaiGenerateResult {
  ok: boolean;
  kind: "text" | "image" | "video";
  /** Assistant text for kind=text (and the job note for accepted video). */
  text: string | null;
  /** Workspace paths of generated images (bridge `image_paths`). */
  imagePaths: string[];
  /** Present on refusal; short, explicit, never a secret. */
  error: string | null;
}
