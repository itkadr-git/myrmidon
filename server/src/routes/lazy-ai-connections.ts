import type { RequestHandler } from "express";

export function lazyAiConnectionRoutes(load: () => Promise<RequestHandler>): RequestHandler {
  let cached: RequestHandler | undefined;
  return async (req, res, next) => {
    if (!req.path.toLowerCase().includes("ai-connections")) return next();
    try {
      cached ??= await load();
      cached(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
