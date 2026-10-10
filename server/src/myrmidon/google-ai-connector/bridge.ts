// myrmidon(GOOGLE-AI-CONNECT-UI): the client of the subscription bridge.
//
// The bridge contract is frozen (it lives in the deploy repository):
//   POST /v1/generate {kind, prompt, workspace_dir, agent_id} -> 200 {text, image_paths} | 202 {job_id}
//   GET  /v1/jobs/{id}                        -> {status, result?, error?}
//   GET  /v1/health                            -> {session, quota, version}
//   errors: 401 session_stale, 403 video_disabled, 404 job_not_found,
//           429 quota_*, 502 transport_error.
// This module maps those codes onto typed outcomes and carries no secret: the
// board-to-bridge call is unauthenticated on purpose because the bridge sits
// on the internal network only; the cookie bundle never crosses this client.

import type { GaiHealth } from "@paperclipai/shared/myrmidon-google-ai-connector";

export interface GaiBridgeGenerateInput {
  kind: "text" | "image" | "video";
  prompt: string;
  workspaceDir: string;
  agentId: string;
}

export type GaiBridgeErrorCode =
  | "session_stale"
  | "video_disabled"
  | "quota_exceeded"
  | "quota_paused"
  | "quota_refused"
  | "job_not_found"
  | "transport_error"
  | "bad_response";

export type GaiBridgeOutcome =
  | { ok: true; kind: "sync"; text: string | null; imagePaths: string[] }
  | { ok: true; kind: "job"; jobId: string }
  | { ok: false; code: GaiBridgeErrorCode; detail: string };

export interface GaiBridgeJob {
  status: string;
  result: unknown;
  error: unknown;
}

export interface GaiBridgeClient {
  generate(input: GaiBridgeGenerateInput): Promise<GaiBridgeOutcome>;
  job(jobId: string): Promise<{ job: GaiBridgeJob | null }>;
  health(): Promise<GaiHealth | null>;
}

export interface GaiBridgeClientDeps {
  /** Base URL of the bridge (env-provisioned; never in the repository). */
  baseUrl: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapErrorCode(status: number, body: unknown): GaiBridgeErrorCode {
  const code = (body as { error?: unknown } | null)?.error;
  if (code === "session_stale") return "session_stale";
  if (code === "video_disabled") return "video_disabled";
  if (code === "quota_exceeded" || code === "quota_paused" || code === "quota_refused") return code;
  if (status === 401) return "session_stale";
  if (status === 403) return "video_disabled";
  if (status === 404) return "job_not_found";
  if (status === 429) return "quota_exceeded";
  return "transport_error";
}

export function gaiBridgeClient(deps: GaiBridgeClientDeps): GaiBridgeClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(path: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> {
    const base = deps.baseUrl();
    if (!base) return null;
    try {
      const response = await fetchImpl(new URL(path, base), {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json", ...(init?.headers ?? {}) },
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch {
      // network failure, DNS, timeout — the bridge is unreachable.
      return { status: 0, body: null };
    }
  }

  return {
    async generate(input) {
      const response = await call("/v1/generate", {
        method: "POST",
        body: JSON.stringify({
          kind: input.kind,
          prompt: input.prompt,
          workspace_dir: input.workspaceDir,
          agent_id: input.agentId,
        }),
      });
      if (!response) return { ok: false, code: "transport_error", detail: "the bridge base URL is not configured on this board" };
      if (response.status === 200 || response.status === 201) {
        const body = response.body as { text?: unknown; image_paths?: unknown } | null;
        const imagePaths = Array.isArray(body?.image_paths)
          ? body!.image_paths.filter((p): p is string => typeof p === "string")
          : [];
        return { ok: true, kind: "sync", text: str(body?.text), imagePaths };
      }
      if (response.status === 202) {
        const jobId = str((response.body as { job_id?: unknown } | null)?.job_id);
        if (!jobId) return { ok: false, code: "bad_response", detail: "the bridge accepted the job without an id" };
        return { ok: true, kind: "job", jobId };
      }
      if (response.status === 0) return { ok: false, code: "transport_error", detail: "the bridge is unreachable" };
      const code = mapErrorCode(response.status, response.body);
      return { ok: false, code, detail: `the bridge refused the call (${response.status})` };
    },

    async job(jobId) {
      const response = await call(`/v1/jobs/${encodeURIComponent(jobId)}`);
      if (!response || response.status === 0 || response.status === 404) return { job: null };
      const body = response.body as { status?: unknown; result?: unknown; error?: unknown } | null;
      return { job: { status: str(body?.status) ?? "unknown", result: body?.result ?? null, error: body?.error ?? null } };
    },

    async health() {
      const response = await call("/v1/health");
      if (!response || response.status !== 200) return null;
      const body = response.body as Record<string, unknown> | null;
      if (!body || (body.session !== "ok" && body.session !== "stale")) return null;
      const quota = (body.quota ?? {}) as Record<string, unknown>;
      const bucket = (value: unknown) => {
        const row = (value ?? {}) as Record<string, unknown>;
        return {
          used: typeof row.used === "number" ? row.used : null,
          limit: typeof row.limit === "number" ? row.limit : null,
        };
      };
      return {
        session: body.session,
        quota: {
          images: bucket(quota.images),
          videos: bucket(quota.videos),
          paused: quota.paused === true,
          pausedUntil: str(quota.paused_until),
        },
        version: str(body.version),
      };
    },
  };
}
