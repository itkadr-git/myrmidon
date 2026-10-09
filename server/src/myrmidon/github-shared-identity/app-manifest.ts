// server/src/myrmidon/github-shared-identity/app-manifest.ts
//
// myrmidon(GITHUB-APP-MANIFEST): the GitHub App Manifest flow — the board
// registers a self-hosted GitHub App in one click from the company settings,
// without hand-filling the GitHub form and without a .pem file ever touching
// a workstation.
//
//   begin     POST .../app-manifest/begin
//             builds the manifest JSON, the GitHub form URL the UI
//             auto-submits and an unguessable anti-CSRF `state`; the manifest
//             pins public=false, webhooks off and
//             the minimal permission set (contents + pull requests write,
//             metadata read) and points GitHub back at the callback below.
//   callback  GET  .../app-manifest/callback?code=...&state=...
//             the browser redirect from GitHub: FIRST verifies the `state`
//             GitHub echoes back — it must be one begin issued for this
//             company and this actor, live (short TTL) and unused (one-time);
//             a code without such a state is refused before GitHub is called.
//             Then converts the one-time code
//             (`POST /app-manifests/{code}/conversions`, unauthenticated) and
//             stores the returned private key IMMEDIATELY as a company
//             secret — the key never reaches a response body, a log line, an
//             activity entry or an error message. The App is added to the
//             shared-identity rules with its slug; the answer is a 302 back
//             to the company settings with `github_app_created=1` or
//             `github_app_error=<short message>` (never GitHub's body).
//   install   GET  .../apps/:entryId/install
//             the `https://github.com/apps/<slug>/installations/new` URL the
//             UI navigates to; the installation id is discovered per
//             repository by the existing resolver, nothing new here.
//
// The manual path (registering an existing App: App id + key secret) stays
// fully working — the manifest flow only adds entries to the same document.

import { randomUUID } from "node:crypto";
import { logActivity } from "../../services/activity-log.js";
import { getActorInfo } from "../../routes/authz.js";
import { loadConfig } from "../../config.js";
import { secretService } from "../../services/secrets.js";
import {
  normalizeGitHubAppPermissions,
  type GitHubAppEntry,
} from "./settings.js";
import type { GitHubAppPermissions } from "./app-token.js";
import { readGitHubSharedIdentitySettings, writeGitHubSharedIdentitySettings } from "./store.js";
import type { Db } from "@paperclipai/db";

/** GitHub's own host — an application constant, not an operator setting. */
const GITHUB_WEB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const CONVERSION_TIMEOUT_MS = 15_000;

/** Default description of the created App (GitHub asks for one). */
export const GITHUB_APP_MANIFEST_DEFAULT_DESCRIPTION =
  "Lets the agents of your Myrmidon server push branches and open pull requests in the repositories you choose. " +
  "Tokens are issued by your own Myrmidon server; no third-party service is involved.";

/** Fallback `url` of the manifest when the instance has no public URL configured. */
export const GITHUB_APP_MANIFEST_FALLBACK_URL = "https://github.com/itkadr-git/myrmidon";

export interface GitHubAppManifest {
  name: string;
  description: string;
  url: string;
  public: boolean;
  hook_attributes: { active: boolean };
  default_permissions: { contents: "write"; pull_requests: "write"; metadata: "read" };
  redirect_url: string;
}

/**
 * The manifest permission set as the stored permission list: the three
 * `default_permissions` lines, every other allow-listed key at the default.
 * Unknown levels in GitHub's conversion answer normalize back to the
 * default — a stored document can never widen the broker beyond what the
 * manifest asked for.
 */
function manifestPermissions(input: Record<string, unknown> | undefined): GitHubAppPermissions {
  const levels = new Set(["none", "read", "write"]);
  const requested: Record<string, string> = {};
  for (const key of ["contents", "pull_requests"] as const) {
    const level = input?.[key];
    requested[key] = typeof level === "string" && levels.has(level) ? level : "write";
  }
  return normalizeGitHubAppPermissions(requested);
}

function publicBaseUrl(): string | null {
  try {
    return loadConfig().authPublicBaseUrl ?? null;
  } catch {
    return null;
  }
}

/** The instance's public URL, or the project repository as the manifest's `url`. */
function manifestHomepageUrl(): string {
  return publicBaseUrl() ?? GITHUB_APP_MANIFEST_FALLBACK_URL;
}

/** Where GitHub returns the browser after the manifest form — needs the public URL. */
function callbackUrl(companyId: string): string | null {
  const base = publicBaseUrl();
  return base
    ? `${base.replace(/\/+$/, "")}/api/myrmidon/companies/${companyId}/github-shared-identity/app-manifest/callback`
    : null;
}

/**
 * Where the callback redirects the browser at the end: the company settings
 * with the shared-GitHub-identity section, flagged by the query the UI reads.
 */
export function settingsRedirectUrl(
  companyId: string,
  outcome: { ok: true } | { ok: false; message: string },
): string {
  const query = outcome.ok
    ? "?github_app_created=1"
    : `?github_app_error=${encodeURIComponent(outcome.message)}`;
  const base = publicBaseUrl();
  if (base) return `${base.replace(/\/+$/, "")}/company/settings${query}#github-shared-identity`;
  return `/company/settings${query}#github-shared-identity`;
}

/** The GitHub form URL + manifest the UI auto-submits (POST, hidden `manifest` field). */
export function buildGitHubAppManifest(input: {
  companyId: string;
  ownerKind: "user" | "org";
  orgLogin?: string | undefined;
  name: string;
  description?: string | undefined;
}): { manifestUrl: string; manifest: GitHubAppManifest } {
  const manifestUrl =
    input.ownerKind === "org"
      ? `${GITHUB_WEB}/organizations/${encodeURIComponent(input.orgLogin ?? "")}/settings/apps/new`
      : `${GITHUB_WEB}/settings/apps/new`;
  const redirect = callbackUrl(input.companyId);
  if (!redirect) {
    // A manifest without redirect_url would leave the created App's key on
    // the GitHub page instead of the company vault — refuse instead.
    throw new AppManifestError("The instance has no public URL; set PAPERCLIP_PUBLIC_URL first");
  }
  return {
    manifestUrl,
    manifest: {
      name: input.name,
      description: input.description ?? GITHUB_APP_MANIFEST_DEFAULT_DESCRIPTION,
      url: manifestHomepageUrl(),
      public: false,
      hook_attributes: { active: false },
      default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      redirect_url: redirect,
    },
  };
}

/** Errors of the flow that must reach the browser as a short safe message. */
export class AppManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppManifestError";
  }
}

/**
 * myrmidon(GITHUB-APP-MANIFEST): the anti-CSRF `state` of the manifest flow.
 * `begin` issues an unguessable random state, GitHub echoes it back as a
 * query parameter on the redirect to the callback (its documented manifest
 * behaviour), and the callback converts a code only for the same state.
 * In-process only — the flow lives minutes and the board is single-instance:
 * one-time use, short TTL, a bounded table, entries keyed by the company and
 * the actor who started the flow, so a state issued for one company or user
 * never validates for another.
 */
const MANIFEST_STATE_TTL_MS = 10 * 60 * 1000;
const MANIFEST_STATE_MAX = 1000;
const manifestStates = new Map<string, { key: string; expiresAt: number }>();

type ManifestActor = { actorType: string; actorId: string };

/** The identity a state is bound to: the company plus the actor who began it. */
function manifestStateKey(companyId: string, actor: ManifestActor): string {
  return `${companyId}\u0000${actor.actorType}:${actor.actorId}`;
}

/** Issue an unguessable state for the manifest form, remembering its binding. */
export function issueGitHubAppManifestState(companyId: string, actor: ManifestActor): string {
  const state = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const now = Date.now();
  for (const [token, entry] of manifestStates) {
    if (entry.expiresAt <= now) manifestStates.delete(token);
  }
  if (manifestStates.size >= MANIFEST_STATE_MAX) {
    // The map is insertion-ordered: drop the oldest live state.
    const oldest = manifestStates.keys().next();
    if (!oldest.done) manifestStates.delete(oldest.value);
  }
  manifestStates.set(state, { key: manifestStateKey(companyId, actor), expiresAt: now + MANIFEST_STATE_TTL_MS });
  return state;
}

/**
 * The callback's check: consume the state (every token validates at most
 * once) and prove it was issued for this company and this actor. `false` for
 * an unknown, expired, used or foreign state.
 */
export function consumeGitHubAppManifestState(input: {
  companyId: string;
  actor: ManifestActor;
  state: string;
}): boolean {
  if (!input.state) return false;
  const entry = manifestStates.get(input.state);
  if (!entry) return false;
  manifestStates.delete(input.state);
  return entry.key === manifestStateKey(input.companyId, input.actor) && entry.expiresAt > Date.now();
}

/** The fields of a conversions answer the flow uses — the key by value, never by copy. */
type Conversion = { appId: string; slug: string; name: string; privateKey: string; permissions: GitHubAppPermissions };

/** One-time manifest code -> the created App. GitHub's answer body never leaves this function. */
async function convertManifestCode(code: string, fetchImpl: typeof fetch): Promise<Conversion> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "myrmidon-github-app",
      },
    });
  } catch {
    throw new AppManifestError("GitHub is unreachable; try again in a moment.");
  }
  if (!response.ok) {
    // Reduce the answer to its status: the body can carry details of the
    // rejected manifest that must not be echoed into the browser URL.
    await response.arrayBuffer().catch(() => undefined);
    throw new AppManifestError(
      response.status === 422
        ? "GitHub rejected the app — the name is likely taken; pick another name and try again."
        : `GitHub could not create the app (HTTP ${response.status}); try again or register the app manually.`,
    );
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const pem = parsed?.pem;
  const id = parsed?.id;
  if (!parsed || typeof pem !== "string" || !pem || (typeof id !== "number" && typeof id !== "string")) {
    throw new AppManifestError("GitHub returned an unreadable answer; try again or register the app manually.");
  }
  return {
    appId: String(id),
    slug: typeof parsed.slug === "string" && parsed.slug ? parsed.slug : `app-${String(id)}`,
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : `GitHub App ${String(id)}`,
    permissions: manifestPermissions(
      typeof parsed.default_permissions === "object" && parsed.default_permissions !== null
        ? (parsed.default_permissions as Record<string, unknown>)
        : undefined,
    ),
    privateKey: pem,
  };
}

/**
 * The callback half of the flow: convert the code, vault the key, add the App
 * to the shared-identity rules. Returns the App entry id on success; throws
 * AppManifestError with a browser-safe message otherwise.
 */
export async function completeGitHubAppManifest(
  db: Db,
  input: {
    companyId: string;
    code: string;
    actor: ReturnType<typeof getActorInfo>;
    fetchImpl?: typeof fetch;
  },
): Promise<{ entryId: string }> {
  const conversion = await convertManifestCode(input.code, input.fetchImpl ?? fetch);
  // The private key goes straight into the company vault and is used nowhere
  // else — not the response, not the journal, not an error.
  const secret = await secretService(db).create(
    input.companyId,
    {
      name: `GitHub App ${conversion.name} key`,
      provider: "local_encrypted",
      value: conversion.privateKey,
      description: "Private key of the GitHub App created from the company settings (manifest flow).",
    },
    { userId: input.actor.actorType === "user" ? input.actor.actorId : null, agentId: input.actor.agentId },
  );
  const entry: GitHubAppEntry = {
    id: randomUUID(),
    name: conversion.name,
    appId: conversion.appId,
    slug: conversion.slug,
    privateKeySecretId: secret.id,
    installationId: null,
    roles: [],
    agentIds: [],
    allowedRepos: [],
    permissions: conversion.permissions,
  };
  const current = await readGitHubSharedIdentitySettings(db, input.companyId);
  const next = { ...current, apps: [...current.apps, entry] };
  const { previous, changed } = await writeGitHubSharedIdentitySettings(db, input.companyId, next);
  if (changed) {
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        agentApiKeyId: input.actor.agentApiKeyId,
        action: "myrmidon.github_app.settings_saved",
        entityType: "github_app_identity",
        entityId: input.companyId,
        details: { previous, next },
      });
    } catch {
      // A failed journal entry must not lose a saved setting.
    }
  }
  return { entryId: entry.id };
}

/** The install URL of a stored App entry (`null` slug — a manually added App). */
export function gitHubAppInstallUrl(entry: GitHubAppEntry): string | null {
  if (!entry.slug) return null;
  return `${GITHUB_WEB}/apps/${encodeURIComponent(entry.slug)}/installations/new`;
}
