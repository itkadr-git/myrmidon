import { createHash } from "node:crypto";
import type { Request, Response } from "express";

/**
 * myrmidon(PERF-DIET-T): version-key ETag support for hot list routes.
 *
 * `privateJsonEtag` can only hash the serialized body, so a matching
 * If-None-Match still pays for every query that builds the body. This helper
 * instead derives the ETag from cheap per-company version aggregates
 * (count + max(updated_at)/max(created_at)) BEFORE the body queries run, so an
 * unchanged client gets a 304 without the body fetch at all.
 *
 * The trade-off is documented deliberately: the key is a coarse proxy for the
 * response. Anything that can change the response without changing the
 * aggregates (row deleted between max() rows, encoding flags) must either bump
 * `updated_at` on write or be included in the key parts by the caller. When in
 * doubt the key must over-invalidate (extra 200), never under-invalidate
 * (stale 304).
 */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

export function versionKeyEtag(
  scope: string,
  parts: Array<string | number | boolean | null | undefined>,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([scope, ...parts]))
    .digest("base64url")
    .slice(0, 22);
  return `"vk-${scope}:${hash}"`;
}

/**
 * Stamp the response with the precomputed ETag and, when the client already
 * holds it, answer 304 immediately. Returns true when the caller must stop and
 * skip building the body.
 */
export function notModifiedOrSetEtag(req: Request, res: Response, etag: string): boolean {
  res.setHeader("Cache-Control", "private, must-revalidate");
  res.setHeader("ETag", etag);
  if (matchesIfNoneMatch(req.header("if-none-match"), etag)) {
    res.status(304).end();
    return true;
  }
  return false;
}
