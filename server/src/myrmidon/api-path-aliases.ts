import type { NextFunction, Request, Response } from "express";

const LEGACY_PREFIX = "/paperclip";
const CANONICAL_PREFIX = "/myrmidon";

/**
 * Keeps the pre-rebrand API path available without redirecting clients.
 *
 * This middleware is mounted inside the `/api` router, so `req.url` starts
 * after the `/api` prefix. Rewriting only a complete path segment preserves
 * query strings and avoids changing unrelated paths such as `/paperclip-old`.
 */
export function apiPathAliasMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const url = req.url;
    if (url === LEGACY_PREFIX || url.startsWith(`${LEGACY_PREFIX}/`)) {
      req.url = `${CANONICAL_PREFIX}${url.slice(LEGACY_PREFIX.length)}`;
    }
    next();
  };
}
