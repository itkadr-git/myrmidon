// Stack registry (SUA): local-state collector. Everything here is read-only
// probing of what the board server process can see: its own build metadata (the
// same source /api/health uses — one truth for the board version/commit) and,
// when a Docker socket is reachable, image digests for the seeded components.
// External release data is part B and is deliberately not touched here.

import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../../server-info.js";
import { request as httpRequest } from "node:http";
import {
  PAPERCLIP_MIGRATION_SUPPORTED_VERSION,
  STACK_DOCUMENT_VERSION,
  STACK_SEED,
  emptyStackDocument,
  patchEntryFromDelta,
  seedDeltasFor,
  type StackDocument,
  type StackPatchEntry,
  type StackSeedComponent,
  type StackSnapshot,
} from "./domain.js";

export const STACK_DOCKER_SOCKET_ENV = "MYRMIDON_STACK_DOCKER_SOCKET";
export const DEFAULT_STACK_DOCKER_SOCKET = "/var/run/docker.sock";

const DOCKER_API_VERSION = "v1.45";
const DOCKER_REQUEST_TIMEOUT_MS = 10_000;

export interface DockerImageInspectSummary {
  /** RepoTag with a tag, e.g. "node:24-alpine". */
  repoTag: string | null;
  digest: string | null;
  labels: Record<string, string>;
}

export type DockerImagesPort = (
  imageRef: string,
) => Promise<DockerImageInspectSummary | null>;

interface DockerHttpResponse {
  status: number;
  body: Buffer;
}

function dockerImageInspectRequest(
  socketPath: string,
  imageRef: string,
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const segment = imageRef.split("/").map(encodeURIComponent).join("/");
    const req = httpRequest(
      { socketPath, path: `/${DOCKER_API_VERSION}/images/${segment}/json`, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(DOCKER_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`docker image inspect ${imageRef} timed out`));
    });
    req.on("error", reject);
    req.end();
  });
}

function summarizeImageInspect(raw: string): DockerImageInspectSummary | null {
  let parsed: {
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
    Config?: { Labels?: Record<string, string> | null } | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const repoTag = (parsed.RepoTags ?? []).find((tag) => typeof tag === "string" && tag.includes(":")) ?? null;
  const digestEntry = (parsed.RepoDigests ?? []).find((entry) => typeof entry === "string" && entry.includes("@sha256:"));
  const digest = digestEntry ? digestEntry.slice(digestEntry.indexOf("@") + 1) : null;
  return { repoTag, digest, labels: parsed.Config?.Labels ?? {} };
}

/** Docker image inspect over the unix socket; null when the image is absent
 * or the socket itself is unreachable (the board container has no docker.sock
 * by design — that is an honest unknown, not an infrastructure failure). */
export function dockerImagesPort(socketPath: string = DEFAULT_STACK_DOCKER_SOCKET): DockerImagesPort {
  return async (imageRef) => {
    let res: DockerHttpResponse;
    try {
      res = await dockerImageInspectRequest(socketPath, imageRef);
    } catch (err) {
      // ENOENT (no socket file) / ECONNREFUSED (daemon down): the probe is
      // simply unavailable on this host. Treat like an absent image so the
      // check keeps working; a daemon HTTP error below stays an exception.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTDIR") return null;
      throw err;
    }
    if (res.status === 404) return null;
    if (res.status >= 400) {
      throw new Error(`docker image inspect ${imageRef} failed: ${res.status} ${res.body.toString("utf8").slice(0, 200)}`);
    }
    return summarizeImageInspect(res.body.toString("utf8"));
  };
}

function imageRefWithoutTag(ref: string): string {
  const lastSegment = ref.slice(ref.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? ref.slice(0, ref.lastIndexOf(":")) : ref;
}

async function probeDockerImages(
  seed: StackSeedComponent,
  images: DockerImagesPort,
): Promise<StackSnapshot["local"]> {
  const refs = seed.imageRefs ?? [];
  const states: StackSnapshot["local"] = {
    version: null,
    commit: null,
    digest: null,
    runningOn: null,
    unknownReason: null,
    checkedAt: null,
    patches: [],
  };
  if (refs.length === 0) {
    states.unknownReason = "no image references configured for this component";
    return states;
  }
  let found = false;
  const runningOn: string[] = [];
  for (const ref of refs) {
    // A thrown error is an infrastructure failure of the probe port itself
    // (daemon HTTP error, misbehaving stub): the route turns it into a 503 so
    // the previous cache survives. A missing image or an unreachable docker
    // socket (null — see dockerImagesPort) is a normal, per-component unknown,
    // not a failure: the board container has no docker.sock by design.
    const summary = await images(imageRefWithoutTag(ref));
    if (!summary) continue;
    found = true;
    runningOn.push(summary.repoTag ?? ref);
    if (!states.version && summary.repoTag) states.version = summary.repoTag;
    if (!states.digest && summary.digest) states.digest = summary.digest;
  }
  if (found) {
    states.runningOn = runningOn.join(", ");
    return states;
  }
  states.unknownReason = "image not present on the Docker host reachable from the board";
  return states;
}

// STACK-WATCH-LIVE: the probe budget is five seconds — a slow component
// endpoint must not delay the sweep; an unreachable endpoint is an honest
// per-component unknown.
const HTTP_VERSION_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The endpoint each http-version component is probed on, relative to the base
 * URL the operator binds through MYRMIDON_STACK_HTTP_<NAME> (the documented
 * contract: one GET <base>/<endpoint> returning JSON with a `version` field).
 */
const HTTP_VERSION_ENDPOINT_PATHS: Record<string, string> = {
  hindsight: "/version",
  litellm: "/version",
  langfuse: "/api/public/health",
};

function httpVersionEndpointFor(seedName: string): string {
  return HTTP_VERSION_ENDPOINT_PATHS[seedName] ?? "/version";
}

interface HttpJsonResponse {
  status: number;
  body: string;
}

/**
 * GET an HTTP(S) endpoint and return status + raw body. Uses globalThis.fetch
 * so tests can stub the probe without a live socket; a timeout aborts the
 * request after HTTP_VERSION_REQUEST_TIMEOUT_MS.
 */
async function httpJsonRequest(url: URL): Promise<HttpJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_VERSION_REQUEST_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse an HTTP version response body: JSON with a `version` or `api_version`
 * field (non-empty string). Any other shape answers null (an honest unknown
 * instead of crashing).
 */
function extractVersionField(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  for (const raw of [obj.version, obj.api_version]) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }
  return null;
}

/**
 * http-version probe (STACK-WATCH-LIVE): read the component's own version over
 * HTTP. The endpoint URL never ships in the seed — only the env var name is
 * seeded; the operator binds the address through MYRMIDON_STACK_HTTP_<NAME>.
 * A missing binding is an honest per-component unknown, never a check failure.
 */
async function probeHttpVersion(seed: StackSeedComponent): Promise<StackSnapshot["local"]> {
  const states: StackSnapshot["local"] = {
    version: null,
    commit: null,
    digest: null,
    runningOn: null,
    unknownReason: null,
    checkedAt: null,
    patches: [],
  };
  const envName = seed.httpEndpointEnv;
  if (!envName) {
    states.unknownReason = "no http endpoint configured for this component";
    return states;
  }
  const rawUrl = process.env[envName]?.trim();
  if (!rawUrl) {
    states.unknownReason = `http endpoint env ${envName} is not set`;
    return states;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    states.unknownReason = `http endpoint env ${envName} is not a valid URL`;
    return states;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    states.unknownReason = `http endpoint env ${envName} must be http(s)`;
    return states;
  }
  // The documented value is a base URL: one GET <base>/<endpoint> (hindsight
  // and LiteLLM /version, Langfuse /api/public/health). A value that already
  // names the endpoint path keeps working unchanged.
  const endpoint = httpVersionEndpointFor(seed.name);
  if (!url.pathname || url.pathname === "/") url.pathname = endpoint;
  let res: HttpJsonResponse;
  try {
    res = await httpJsonRequest(url);
  } catch {
    states.unknownReason = `http version endpoint ${url.toString()} unreachable`;
    return states;
  }
  if (res.status < 200 || res.status >= 300) {
    states.unknownReason = `http version endpoint ${url.toString()} answered ${res.status}`;
    return states;
  }
  const version = extractVersionField(res.body);
  if (!version) {
    states.unknownReason = `http version endpoint ${url.toString()} answered without a version field`;
    return states;
  }
  states.version = version;
  states.runningOn = url.origin;
  return states;
}

export interface CollectStackLocalOptions {
  now?: () => Date;
  /** Docker image inspect port; defaults to the unix-socket implementation. */
  images?: DockerImagesPort;
  /** Board snapshot override; defaults to the live /api/health source. */
  serverInfo?: ServerInfoSnapshot;
  /**
   * The previously stored document. Part B state (upstream release data and
   * patch-closed verdicts) is carried over by component name, so a local
   * refresh never wipes the scheduled release check.
   */
  previous?: StackDocument;
}

function carryPrevious(prev: StackSnapshot | undefined, snapshot: StackSnapshot): StackSnapshot {
  if (!prev) return snapshot;
  const patches = snapshot.local.patches.map((patch) => {
    const old = prev.local.patches.find((entry) => entry.title === patch.title);
    return old ? { ...patch, state: old.state, reason: old.reason } : patch;
  });
  return {
    ...snapshot,
    local: { ...snapshot.local, patches },
    ...(prev.upstreamState ? { upstreamState: prev.upstreamState } : {}),
    ...(prev.patchClosed ? { patchClosed: prev.patchClosed } : {}),
  };
}

/**
 * Build a fresh document from the seed: the board component carries the same
 * git commit /api/health reports, docker-image components carry the digest of
 * the image present on the host, everything else is an honest unknown with a
 * reason. The patches list starts empty (filled by part B rules).
 */
export async function collectStackLocal(options: CollectStackLocalOptions = {}): Promise<StackDocument> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const previous = options.previous;
  const images = options.images ?? dockerImagesPort(process.env[STACK_DOCKER_SOCKET_ENV]?.trim() || DEFAULT_STACK_DOCKER_SOCKET);

  const serverInfo = options.serverInfo ?? getServerInfoSnapshot();
  const boardGit = serverInfo.git;

  const components: StackSnapshot[] = [];
  for (const seed of STACK_SEED) {
    const seededPatches: StackPatchEntry[] = seedDeltasFor(seed.name).map(patchEntryFromDelta);
    const snapshot: StackSnapshot = {
      version: 1,
      name: seed.name,
      releaseSource: seed.releaseSource,
      upstream: seed.upstream,
      localProbe: seed.localProbe,
      ...(seed.note ? { note: seed.note } : {}),
      local: {
        version: null,
        commit: null,
        digest: null,
        runningOn: null,
        unknownReason: null,
        checkedAt,
        patches: seededPatches,
      },
    };
    switch (seed.localProbe) {
      case "health-commit": {
        // One truth with /api/health: the same server-info snapshot source.
        if (boardGit.available) {
          snapshot.local.commit = boardGit.fullSha;
          snapshot.local.runningOn = "board server process";
        } else {
          snapshot.local.unknownReason = `board build commit unavailable (${boardGit.unavailableReason})`;
        }
        break;
      }
      case "docker-image": {
        snapshot.local = { ...(await probeDockerImages(seed, images)), checkedAt, patches: seededPatches };
        break;
      }
      case "env": {
        snapshot.local.unknownReason = "no version override configured";
        break;
      }
      case "manual": {
        if (seed.name === "paperclip") {
          snapshot.local.version = PAPERCLIP_MIGRATION_SUPPORTED_VERSION;
          snapshot.local.runningOn = "supported migration schema";
          snapshot.local.unknownReason = null;
        } else {
          snapshot.local.unknownReason = "managed by the operator; no automatic probe";
        }
        break;
      }
      case "none": {
        snapshot.local.unknownReason = "not visible from the board server process";
        break;
      }
      case "container-labels": {
        snapshot.local.unknownReason = "no matching container labels found";
        break;
      }
      case "http-version": {
        snapshot.local = { ...(await probeHttpVersion(seed)), checkedAt, patches: seededPatches };
        break;
      }
    }
    components.push(carryPrevious(previous?.components.find((c) => c.name === seed.name), snapshot));
  }
  return {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: checkedAt,
    checkedAt: options.previous?.checkedAt ?? null,
    components,
  };
}

export { emptyStackDocument };
