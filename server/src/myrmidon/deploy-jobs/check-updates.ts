// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): domain service for manual update check
import {
  type CheckUpdatesRequest,
  type CheckUpdatesResponse,
  type UpdateChannel,
  checkUpdatesRequestSchema,
  evaluateUpdateAvailability,
  normalizeVersionString,
} from "@myrmidon/shared";
import { readAboutBuildInfo } from "../about/build-info.js";
import { readDeployJobsSettings } from "./settings.js";

export interface CheckUpdatesDeps {
  buildInfo?: () => {
    version: string;
    commit: string | null;
    imageDigest: string | null;
  };
  fetchJson?: (url: string, init?: RequestInit) => Promise<any>;
  now?: () => Date;
  ttlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  response: CheckUpdatesResponse;
}

const checkCache = new Map<string, CacheEntry>();

export function clearCheckUpdatesCache(): void {
  checkCache.clear();
}

import { GHCR_REPO_PATH } from "./registry.js";

const GITHUB_API = "https://api.github.com";
const DEFAULT_TTL_MS = 60_000; // 1 minute

async function defaultFetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstream request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function checkSystemUpdates(
  rawInput?: Partial<CheckUpdatesRequest>,
  deps?: CheckUpdatesDeps,
): Promise<CheckUpdatesResponse> {
  const input = checkUpdatesRequestSchema.parse(rawInput ?? {});
  const channel = input.channel;
  const force = input.force;
  const reference = input.reference;

  const nowFn = deps?.now ?? (() => new Date());
  const currentTime = nowFn();
  const nowMs = currentTime.getTime();
  const ttlMs = deps?.ttlMs ?? DEFAULT_TTL_MS;

  const cacheKey = `${channel}:${reference ?? ""}`;
  if (!force) {
    const cached = checkCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.response;
    }
  }

  const build = deps?.buildInfo
    ? deps.buildInfo()
    : (() => {
        const info = readAboutBuildInfo();
        return {
          version: info.version,
          commit: info.commit,
          imageDigest: info.imageDigest,
        };
      })();

  const currentVersion = build.version;
  const currentCommit = build.commit;
  const currentDigest = build.imageDigest;

  const settings = readDeployJobsSettings();
  const fetchJson = deps?.fetchJson ?? defaultFetchJson;

  let latestVersion: string | null = null;
  let latestCommit: string | null = null;
  let latestDigest: string | null = null;
  let releaseTag: string | null = null;
  let releaseUrl: string | null = null;
  let releaseNotes: string | null = null;
  let publishedAt: string | null = null;
  let checkError: string | null = null;

  try {
    if (reference) {
      // If a reference was passed, e.g. "ghcr.io/itkadr-git/myrmidon:myr-v1.7.0"
      const colonIdx = reference.lastIndexOf(":");
      const tag = colonIdx !== -1 ? reference.slice(colonIdx + 1) : reference;
      latestVersion = normalizeVersionString(tag);
      releaseTag = tag;
    } else if (channel === "canary" || channel === "latest") {
      // Check latest commit on main branch
      const commitUrl = `${GITHUB_API}/repos/${GHCR_REPO_PATH}/commits/main`;
      const commitData = await fetchJson(commitUrl, {
        headers: {
          ...(settings.githubHeaders ?? {}),
          Accept: "application/vnd.github.v3+json",
        },
      });

      latestCommit = typeof commitData?.sha === "string" ? commitData.sha : null;
      releaseUrl = typeof commitData?.html_url === "string" ? commitData.html_url : null;
      releaseNotes = typeof commitData?.commit?.message === "string" ? commitData.commit.message : null;
      publishedAt =
        typeof commitData?.commit?.author?.date === "string" ? commitData.commit.author.date : null;
      latestVersion = currentVersion;
    } else if (channel === "rc") {
      // Fetch releases/tags to find the latest pre-release
      const releasesUrl = `${GITHUB_API}/repos/${GHCR_REPO_PATH}/releases`;
      const releases = await fetchJson(releasesUrl, {
        headers: {
          ...(settings.githubHeaders ?? {}),
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (Array.isArray(releases) && releases.length > 0) {
        // Find newest release (including pre-releases)
        const rel = releases[0];
        releaseTag = typeof rel.tag_name === "string" ? rel.tag_name : null;
        latestVersion = releaseTag ? normalizeVersionString(releaseTag) : null;
        releaseUrl = typeof rel.html_url === "string" ? rel.html_url : null;
        releaseNotes = typeof rel.body === "string" ? rel.body : null;
        publishedAt = typeof rel.published_at === "string" ? rel.published_at : null;
      }
    } else {
      // Channel: "stable" (default)
      const releaseUrlApi = `${GITHUB_API}/repos/${GHCR_REPO_PATH}/releases/latest`;
      const release = await fetchJson(releaseUrlApi, {
        headers: {
          ...(settings.githubHeaders ?? {}),
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (release) {
        releaseTag = typeof release.tag_name === "string" ? release.tag_name : null;
        latestVersion = releaseTag ? normalizeVersionString(releaseTag) : null;
        releaseUrl = typeof release.html_url === "string" ? release.html_url : null;
        releaseNotes = typeof release.body === "string" ? release.body : null;
        publishedAt = typeof release.published_at === "string" ? release.published_at : null;
      }
    }
  } catch (err) {
    checkError = err instanceof Error ? err.message : String(err);
  }

  const updateAvailable = evaluateUpdateAvailability(
    {
      version: currentVersion,
      commit: currentCommit,
      digest: currentDigest,
    },
    {
      version: latestVersion,
      commit: latestCommit,
      digest: latestDigest,
    },
  );

  const response: CheckUpdatesResponse = {
    currentVersion,
    currentCommit,
    currentDigest,
    channel,
    updateAvailable,
    latestVersion,
    latestCommit,
    latestDigest,
    releaseTag,
    releaseUrl,
    releaseNotes,
    publishedAt,
    checkedAt: currentTime.toISOString(),
    error: checkError,
  };

  if (!checkError) {
    checkCache.set(cacheKey, {
      expiresAt: nowMs + ttlMs,
      response,
    });
  }

  return response;
}
