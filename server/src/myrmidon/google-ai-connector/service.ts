// myrmidon(GOOGLE-AI-CONNECT-UI): the service.
//
// One process-wide service owns the connection, the grants and the journal
// (store.ts) and is the only place that touches the bridge (bridge.ts) or the
// session secret (session-store.ts). The enforcement mirrors the cloud
// connector: resolve the most specific grant for the calling agent, refuse
// video while the capability is disabled, then forward the frozen bridge
// payload. Every attempt — allowed or refused — is journalled.
//
// Secret rule: the cookie bundle flows only from the owner's paste into the
// instance secret store and from there into the bridge-facing delivery. No
// method here returns bundle material; journal rows and errors carry names
// and codes only.

import { randomUUID } from "node:crypto";
import {
  GAI_CAPABILITIES,
  type GaiCapability,
  type GaiConnection,
  type GaiGenerateResult,
  type GaiGrant,
  type GaiGrantPut,
  type GaiHealth,
  type GaiJournalEntry,
  type GaiStateView,
} from "@paperclipai/shared/myrmidon-google-ai-connector";
import { GoogleAiConnectorError, type GaiAgentIdentity, type GaiSessionStore } from "./types.js";
import { parseCookiePaste, CookiePasteError } from "./cookies.js";
import type { GaiBridgeClient } from "./bridge.js";
import {
  appendGaiJournal,
  type GoogleAiConnectorDocument,
  type GoogleAiConnectorStore,
} from "./store.js";
import type { GaiDeliveryMode } from "@paperclipai/shared/myrmidon-google-ai-connector";

export interface GoogleAiConnectorService {
  /** Everything the screen renders. */
  state(companyId: string): Promise<GaiStateView>;
  /** The owner pastes their exported cookies; the bundle lands in the secret store. */
  connect(input: { companyId: string; userId: string; cookieJson: string }): Promise<{ connection: GaiConnection; keptCookies: string[]; ignoredCookies: number }>;
  /** New paste over the same connection (same secret, new version). */
  reconnect(input: { companyId: string; userId: string; cookieJson: string }): Promise<{ connection: GaiConnection; keptCookies: string[]; ignoredCookies: number }>;
  disconnect(input: { companyId: string; userId: string }): Promise<{ removed: boolean }>;
  listGrants(companyId: string): Promise<GaiGrant[]>;
  setGrant(input: GaiGrantPut, actor: string): Promise<GaiGrant>;
  removeGrant(grantId: string, companyId: string): Promise<{ removed: boolean }>;
  journal(companyId: string): Promise<GaiJournalEntry[]>;
  /** Owner "check now" and the scheduled sweep: probes bridge health. */
  checkHealth(companyId: string, actor: { kind: "owner" | "system" }): Promise<{ health: GaiHealth | null; status: GaiConnection["status"] | null; staleNow: boolean }>;
  /** Trial image from the screen (runs as the owner, uses no grant). */
  trialImage(input: { companyId: string; userId: string; prompt: string }): Promise<GaiGenerateResult>;
  /** Agent-facing call: grant check, then bridge. */
  generate(identity: GaiAgentIdentity, call: { kind: "text" | "image" | "video"; prompt: string }): Promise<GaiGenerateResult>;
  jobStatus(input: { companyId: string; jobId: string }): Promise<{ status: string; result: unknown; error: unknown } | null>;
  /** Grant decision used by the agent call route and the MCP surface alike. */
  accessFor(identity: GaiAgentIdentity): Promise<GaiCapability[]>;
  agentCaste(agentId: string): Promise<string | null>;
  /** Companies with a live connection (the sweep iterates these). */
  connectedCompanyIds(): Promise<string[]>;
  deliveryMode(): GaiDeliveryMode;
}

export interface GoogleAiConnectorServiceDeps {
  store: GoogleAiConnectorStore;
  session: GaiSessionStore;
  bridge: GaiBridgeClient;
  /** Board role of an agent — the label a `caste` grant matches on. */
  agentRole(agentId: string): Promise<string | null>;
  /** Delivery mode comes from the environment (endpoint|hook|off). */
  deliveryMode: GaiDeliveryMode;
  now?(): Date;
}

const CAPABILITY_BY_KIND: Record<"text" | "image" | "video", GaiCapability> = {
  text: "creative_text",
  image: "generate_image",
  video: "generate_video",
};

function nowIso(deps: GoogleAiConnectorServiceDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function journalEntry(input: Omit<GaiJournalEntry, "id" | "at"> & { at?: string }): GaiJournalEntry {
  return { id: randomUUID(), at: input.at ?? new Date().toISOString(), ...input } as GaiJournalEntry;
}

export function googleAiConnectorService(deps: GoogleAiConnectorServiceDeps): GoogleAiConnectorService {
  function connectionFor(document: GoogleAiConnectorDocument, companyId: string): GaiConnection | null {
    return document.connections.find((entry) => entry.companyId === companyId) ?? null;
  }

  /** The most specific grant wins: agent > caste > all. */
  function capabilitiesFor(document: GoogleAiConnectorDocument, identity: GaiAgentIdentity): GaiCapability[] {
    const granted = new Set<GaiCapability>();
    for (const grant of document.grants) {
      if (grant.companyId !== identity.companyId) continue;
      const matches =
        grant.targetKind === "all" ||
        (grant.targetKind === "agent" && grant.agentId === identity.agentId) ||
        (grant.targetKind === "caste" && identity.caste !== null && grant.caste === identity.caste);
      if (matches) granted.add(grant.capability);
    }
    return [...granted].filter((capability) => capabilityEnabled(deps, capability));
  }

  async function setStatus(companyId: string, patch: Partial<Pick<GaiConnection, "status" | "lastCheckedAt" | "lastSession" | "lastError">>): Promise<void> {
    await deps.store.mutate((current) => {
      const connection = connectionFor(current, companyId);
      if (!connection) return { next: null, result: null };
      return {
        next: {
          ...current,
          connections: current.connections.map((entry) => (entry.id === connection.id ? { ...entry, ...patch } : entry)),
        },
        result: null,
      };
    });
  }

  async function saveSession(
    request: { companyId: string; userId: string; cookieJson: string },
    action: "connect" | "reconnect",
  ): Promise<{ connection: GaiConnection; keptCookies: string[]; ignoredCookies: number }> {
    let parsed;
    try {
      parsed = parseCookiePaste(request.cookieJson);
    } catch (error) {
      const code = error instanceof CookiePasteError ? error.code : "not_json";
      throw new GoogleAiConnectorError(400, error instanceof Error ? error.message : "the paste could not be read", code);
    }
    const at = nowIso(deps);
    const document = await deps.store.read();
    const existing = connectionFor(document, request.companyId);
    let secretId = existing?.secretId ?? null;
    if (secretId) {
      secretId = (await deps.session.rotate(request.companyId, secretId, parsed.bundleJson)).secretId;
    } else {
      secretId = (await deps.session.write({ companyId: request.companyId, value: parsed.bundleJson, userId: request.userId })).secretId;
    }
    const connection: GaiConnection = existing
      ? { ...existing, status: "connected", lastCheckedAt: at, lastSession: null, lastError: null }
      : {
          id: randomUUID(),
          companyId: request.companyId,
          status: "connected",
          secretId,
          connectedAt: at,
          connectedBy: request.userId,
          lastCheckedAt: at,
          lastSession: null,
          lastError: null,
        };
    await deps.store.mutate((current) => ({
      next: {
        ...current,
        connections: existing
          ? current.connections.map((entry) => (entry.id === existing.id ? connection : entry))
          : [...current.connections, connection],
      },
      result: null,
    }));
    await deps.store.mutate((current) => ({
      next: appendGaiJournal(current, journalEntry({
        actor: request.userId,
        actorKind: "owner",
        action,
        ok: true,
        detail: `kept ${parsed.presentNames.length} cookies, ignored ${parsed.totalCookies - parsed.presentNames.length}`,
      })),
      result: null,
    }));
    return { connection, keptCookies: parsed.presentNames, ignoredCookies: parsed.totalCookies - parsed.presentNames.length };
  }

  async function logHealth(actor: { kind: "owner" | "system" }, status: GaiConnection["status"], detail: string) {
    await deps.store.mutate((current) => ({
      next: appendGaiJournal(current, journalEntry({
        actor: actor.kind === "owner" ? "owner" : "system",
        actorKind: actor.kind === "owner" ? "owner" : "agent",
        action: "check",
        ok: status !== "error",
        detail,
      })),
      result: null,
    }));
  }

  return {
    async state(companyId) {
      const document = await deps.store.read();
      const connection = connectionFor(document, companyId);
      // The screen shows the bridge projection only when a connection exists;
      // the probe itself is cheap and the stale path re-checks on demand.
      const health = connection ? await deps.bridge.health() : null;
      return {
        connection,
        grants: document.grants.filter((grant) => grant.companyId === companyId),
        health,
        capabilities: GAI_CAPABILITIES.map((id) => ({ id, enabled: capabilityEnabled(deps, id) })),
        deliveryMode: deps.deliveryMode,
      };
    },

    connect(input) {
      return saveSession(input, "connect");
    },

    reconnect(input) {
      return saveSession(input, "reconnect");
    },

    async disconnect(input) {
      const document = await deps.store.read();
      const connection = connectionFor(document, input.companyId);
      if (!connection) return { removed: false };
      await deps.session.remove(input.companyId, connection.secretId);
      await deps.store.mutate((current) => ({
        next: {
          ...current,
          connections: current.connections.filter((entry) => entry.id !== connection.id),
          grants: current.grants.filter((grant) => grant.companyId !== input.companyId),
        },
        result: null,
      }));
      await deps.store.mutate((current) => ({
        next: appendGaiJournal(current, journalEntry({
          actor: input.userId,
          actorKind: "owner",
          action: "disconnect",
          ok: true,
          detail: "session secret removed and grants cleared",
        })),
        result: null,
      }));
      return { removed: true };
    },

    async listGrants(companyId) {
      const document = await deps.store.read();
      return document.grants.filter((grant) => grant.companyId === companyId);
    },

    async setGrant(input, actor) {
      const at = nowIso(deps);
      const { result } = await deps.store.mutate((current) => {
        const existing = current.grants.find(
          (grant) =>
            grant.companyId === input.companyId &&
            grant.capability === input.capability &&
            grant.targetKind === input.targetKind &&
            (input.targetKind !== "agent" || grant.agentId === (input.agentId ?? null)) &&
            (input.targetKind !== "caste" || grant.caste === (input.caste ?? null)),
        );
        if (existing) return { next: current, result: existing };
        const grant: GaiGrant = {
          id: randomUUID(),
          companyId: input.companyId,
          capability: input.capability,
          targetKind: input.targetKind,
          agentId: input.targetKind === "agent" ? (input.agentId ?? null) : null,
          caste: input.targetKind === "caste" ? (input.caste ?? null) : null,
          createdAt: at,
          createdBy: actor,
        };
        return { next: { ...current, grants: [...current.grants, grant] }, result: grant };
      });
      return result;
    },

    async removeGrant(grantId, companyId) {
      const { result } = await deps.store.mutate((current) => {
        const grant = current.grants.find((entry) => entry.id === grantId && entry.companyId === companyId);
        if (!grant) return { next: null, result: false };
        return { next: { ...current, grants: current.grants.filter((entry) => entry.id !== grantId) }, result: true };
      });
      return { removed: result };
    },

    async journal(companyId) {
      const document = await deps.store.read();
      return document.journal;
    },

    async checkHealth(companyId, actor) {
      const health = await deps.bridge.health();
      const at = nowIso(deps);
      const document = await deps.store.read();
      const connection = connectionFor(document, companyId);
      if (!connection) return { health, status: null, staleNow: false };
      if (!health) {
        await setStatus(companyId, { status: "error", lastCheckedAt: at, lastError: "the bridge did not answer the health probe" });
        await logHealth(actor, "error", "bridge unreachable");
        return { health: null, status: "error", staleNow: false };
      }
      const status: GaiConnection["status"] = health.session === "stale" ? "stale" : "connected";
      await setStatus(companyId, {
        status,
        lastCheckedAt: at,
        lastSession: health.session,
        lastError: health.session === "stale" ? "the owner session on gemini.google.com has expired" : null,
      });
      await logHealth(actor, status, `session ${health.session}`);
      return { health, status, staleNow: health.session === "stale" && connection.status !== "stale" };
    },

    async trialImage(input) {
      const document = await deps.store.read();
      const connection = connectionFor(document, input.companyId);
      if (!connection || connection.status === "stale") {
        throw new GoogleAiConnectorError(409, "connect the subscription first", connection ? "session_stale" : "not_connected");
      }
      const outcome = await deps.bridge.generate({
        kind: "image",
        prompt: input.prompt,
        workspaceDir: "owner-trial",
        agentId: `owner:${input.userId}`,
      });
      const result = toGenerateResult("image", outcome);
      await deps.store.mutate((current) => ({
        next: appendGaiJournal(current, journalEntry({
          actor: input.userId,
          actorKind: "owner",
          action: "trial_image",
          ok: result.ok,
          detail: result.ok ? "ok" : (result.error ?? "refused"),
        })),
        result: null,
      }));
      return result;
    },

    async generate(identity, call) {
      if (!identity.companyId) throw new GoogleAiConnectorError(403, "the calling agent has no company", "no_company");
      const capability = CAPABILITY_BY_KIND[call.kind];
      const allowed = await capabilitiesFor(await deps.store.read(), identity);
      if (!allowed.includes(capability)) {
        await deps.store.mutate((current) => ({
          next: appendGaiJournal(current, journalEntry({
            actor: identity.agentId,
            actorKind: "agent",
            action: call.kind,
            ok: false,
            detail: `no grant for ${capability}`,
          })),
          result: null,
        }));
        throw new GoogleAiConnectorError(403, `this agent has no grant for ${capability}`, "no_grant");
      }
      const outcome = await deps.bridge.generate({
        kind: call.kind,
        prompt: call.prompt,
        workspaceDir: `agents/${identity.agentId}`,
        agentId: identity.agentId,
      });
      const result = toGenerateResult(call.kind, outcome);
      await deps.store.mutate((current) => ({
        next: appendGaiJournal(current, journalEntry({
          actor: identity.agentId,
          actorKind: "agent",
          action: call.kind,
          ok: result.ok,
          detail: result.ok ? (outcome.kind === "job" ? `job ${outcome.jobId}` : "ok") : (result.error ?? "refused"),
        })),
        result: null,
      }));
      if (!result.ok && outcome && !outcome.ok && outcome.code === "session_stale") {
        await setStatus(identity.companyId, { status: "stale", lastCheckedAt: nowIso(deps), lastSession: "stale", lastError: "the bridge reported the session as stale" });
      }
      return result;
    },

    async jobStatus(input) {
      const { job } = await deps.bridge.job(input.jobId);
      if (!job) return null;
      return { status: job.status, result: job.result, error: job.error };
    },

    async accessFor(identity) {
      const document = await deps.store.read();
      return capabilitiesFor(document, identity);
    },

    agentCaste(agentId) {
      return deps.agentRole(agentId);
    },

    async connectedCompanyIds() {
      const document = await deps.store.read();
      return document.connections.map((entry) => entry.companyId);
    },

    deliveryMode() {
      return deps.deliveryMode;
    },
  };
}

/** Video is not offered as working until the owner enables it: the board-side
 * flag ships `generate_video` disabled. The bridge also refuses with 403
 * video_disabled; this keeps the UI and the grant check honest first. */
function capabilityEnabled(_deps: GoogleAiConnectorServiceDeps, capability: GaiCapability): boolean {
  if (capability === "generate_video") return false;
  return true;
}

function toGenerateResult(kind: "text" | "image" | "video", outcome: Awaited<ReturnType<GaiBridgeClient["generate"]>>): GaiGenerateResult {
  if (!outcome.ok) {
    return { ok: false, kind, text: null, imagePaths: [], error: `${outcome.code}: ${outcome.detail}` };
  }
  if (outcome.kind === "job") {
    return { ok: true, kind, text: `job accepted (${outcome.jobId})`, imagePaths: [], error: null };
  }
  return { ok: true, kind, text: outcome.text, imagePaths: outcome.imagePaths, error: null };
}

export { appendGaiJournal };
