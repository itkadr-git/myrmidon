import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

const OLD_PREFIX = "x-paperclip-";
const NEW_PREFIX = "x-myrmidon-";

export function brandHeadersMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const headers = req.headers;
    for (const key of Object.keys(headers)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith(OLD_PREFIX)) {
        const suffix = lowerKey.slice(OLD_PREFIX.length);
        const newKey = NEW_PREFIX + suffix;
        logger.warn(
          { header: lowerKey, replacement: newKey },
          `Header "${lowerKey}" is deprecated; use "${newKey}" instead`,
        );
        if (headers[newKey] === undefined) {
          headers[newKey] = headers[key];
        }
      } else if (lowerKey.startsWith(NEW_PREFIX)) {
        const suffix = lowerKey.slice(NEW_PREFIX.length);
        const oldKey = OLD_PREFIX + suffix;
        if (headers[oldKey] === undefined) {
          headers[oldKey] = headers[key];
        }
      }
    }

    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: any) {
      if (typeof name === "string" && name.toLowerCase().startsWith(OLD_PREFIX)) {
        const suffix = name.slice(OLD_PREFIX.length);
        const canonical = NEW_PREFIX + suffix;
        return origSetHeader(canonical, value);
      }
      return origSetHeader(name, value);
    };

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (statusCode: number, ...args: any[]) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
          const transformed: Record<string, any> = {};
          for (const [k, v] of Object.entries(arg)) {
            if (typeof k === "string" && k.toLowerCase().startsWith(OLD_PREFIX)) {
              transformed[NEW_PREFIX + k.slice(OLD_PREFIX.length)] = v;
            } else {
              transformed[k] = v;
            }
          }
          args[i] = transformed;
        }
      }
      return (origWriteHead as any)(statusCode, ...args);
    };

    next();
  };
}
