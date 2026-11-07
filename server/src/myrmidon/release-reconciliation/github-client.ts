/**
 * GitHub client for STACK-UPDATES-B Release Reconciliation.
 *
 * Provides tag and release queries against the vendor repository with
 * configurable base URL and optional token authentication.
 */

import type { GitHubClient, GitHubReleaseInfo, GitHubTagInfo } from "./types.js";

/**
 * Normalise a version string: strip leading 'v'/'V', strip image repository prefixes,
 * and trim whitespace.
 */
export function normaliseVersion(raw: string): string {
  let cleaned = raw.trim();
  const colonIndex = cleaned.lastIndexOf(":");
  if (colonIndex >= 0) {
    cleaned = cleaned.slice(colonIndex + 1);
  }
  if (cleaned.startsWith("myr-v") || cleaned.startsWith("myr-V")) {
    cleaned = cleaned.slice(5);
  }
  if (cleaned.startsWith("v") || cleaned.startsWith("V")) {
    cleaned = cleaned.slice(1);
  }
  return cleaned.trim();
}

export interface DefaultGitHubClientOptions {
  apiBase?: string;
  token?: string | null;
  timeoutMs?: number;
}

export function createDefaultGitHubClient(
  options: DefaultGitHubClientOptions = {},
): GitHubClient {
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const token = options.token ?? null;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function fetchJson<T>(path: string): Promise<T | null> {
    const url = `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Myrmidon-ReleaseReconciliation/1.0",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers,
        signal: controller.signal,
      });
      if (resp.status === 404) return null;
      if (!resp.ok) {
        throw new Error(`GitHub API error ${resp.status} ${resp.statusText} for ${url}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getLatestTag(repo: string): Promise<GitHubTagInfo | null> {
      interface RawTag {
        name: string;
        commit?: { sha: string };
      }
      const data = await fetchJson<RawTag[]>(`/repos/${repo}/tags?per_page=1`);
      if (!Array.isArray(data) || data.length === 0) return null;
      const tag = data[0];
      return {
        name: tag.name,
        commitSha: tag.commit?.sha,
      };
    },

    async getLatestRelease(repo: string): Promise<GitHubReleaseInfo | null> {
      interface RawRelease {
        tag_name: string;
        name?: string;
        body?: string;
        published_at?: string;
        html_url?: string;
      }
      const data = await fetchJson<RawRelease>(`/repos/${repo}/releases/latest`);
      if (!data || typeof data.tag_name !== "string") return null;
      return {
        tagName: data.tag_name,
        name: data.name,
        body: data.body,
        publishedAt: data.published_at,
        htmlUrl: data.html_url,
      };
    },

    async getReleaseNotes(repo: string, tagName: string): Promise<string | null> {
      interface RawRelease {
        body?: string;
      }
      const data = await fetchJson<RawRelease>(`/repos/${repo}/releases/tags/${encodeURIComponent(tagName)}`);
      return data?.body ?? null;
    },
  };
}
