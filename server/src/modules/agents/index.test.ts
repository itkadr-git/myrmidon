import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../../errors.js";
import {
  AgentQuotaExceededError,
  createAgentQuotaMiddleware,
} from "./index.js";

describe("createAgentQuotaMiddleware", () => {
  it("calls next() without error when within quota", async () => {
    const assertQuota = vi.fn(async () => ({
      allowed: true,
      currentCount: 2,
      quota: 5,
      tier: "free",
    }));

    const middleware = createAgentQuotaMiddleware(assertQuota);
    const req = { params: { companyId: "comp-1" } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(assertQuota).toHaveBeenCalledWith("comp-1");
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next with HttpError 403 and code quota_exceeded when over quota", async () => {
    const assertQuota = vi.fn(async () => {
      throw new AgentQuotaExceededError({
        allowed: false,
        currentCount: 5,
        quota: 5,
        tier: "free",
      });
    });

    const middleware = createAgentQuotaMiddleware(assertQuota);
    const req = { params: { companyId: "comp-1" } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(assertQuota).toHaveBeenCalledWith("comp-1");
    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.details).toEqual({ code: "quota_exceeded" });
  });

  it("skips check and calls next() when companyId is missing from params", async () => {
    const assertQuota = vi.fn();
    const middleware = createAgentQuotaMiddleware(assertQuota);
    const req = { params: {} } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(assertQuota).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it("passes unexpected errors through to next(err)", async () => {
    const customErr = new Error("db failure");
    const assertQuota = vi.fn(async () => {
      throw customErr;
    });

    const middleware = createAgentQuotaMiddleware(assertQuota);
    const req = { params: { companyId: "comp-1" } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(customErr);
  });
});
