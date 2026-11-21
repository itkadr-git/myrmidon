import type { RequestHandler } from "express";

export function lazyAiConnectionRoutes(load: () => Promise<RequestHandler>): RequestHandler {
  let pending: Promise<RequestHandler> | undefined;
  return async (req, res, next) => {
    if (!req.path.toLowerCase().includes("ai-connections")) return next();
    try {
      pending ??= load().catch((error) => {
        pending = undefined;
        throw error;
      });
      const router = await pending;
      router(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
