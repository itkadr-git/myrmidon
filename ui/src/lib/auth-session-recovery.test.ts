import { describe, expect, it, vi } from "vitest";
import {
  createAuthSessionRecoveryCoordinator,
  isPublicAuthPath,
  isUnauthorizedError,
  pollInterval,
} from "./auth-session-recovery";

describe("isUnauthorizedError", () => {
  it("detects 401 status in various error shapes", () => {
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
    expect(isUnauthorizedError({ statusCode: 401 })).toBe(true);
    expect(isUnauthorizedError({ status: 403 })).toBe(false);
    expect(isUnauthorizedError({ status: 500 })).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
    expect(isUnauthorizedError(new Error("network error"))).toBe(false);
  });
});

describe("isPublicAuthPath", () => {
  it("recognizes public auth routes", () => {
    expect(isPublicAuthPath("/auth")).toBe(true);
    expect(isPublicAuthPath("/auth/reset-password")).toBe(true);
    expect(isPublicAuthPath("/board-claim/token123")).toBe(true);
    expect(isPublicAuthPath("/cli-auth")).toBe(true);
    expect(isPublicAuthPath("/invite/xyz")).toBe(true);
    expect(isPublicAuthPath("/password-set")).toBe(true);
    expect(isPublicAuthPath("/oauth-handoff")).toBe(true);
  });

  it("identifies protected routes as non-public", () => {
    expect(isPublicAuthPath("/")).toBe(false);
    expect(isPublicAuthPath("/OPE/agents/all")).toBe(false);
    expect(isPublicAuthPath("/OPE/issues")).toBe(false);
    expect(isPublicAuthPath("/dashboard")).toBe(false);
  });
});

describe("pollInterval", () => {
  it("stops polling on 401 error", () => {
    const fn = pollInterval(30_000);
    expect(typeof fn).toBe("function");
    if (typeof fn === "function") {
      expect(fn({ state: { error: { status: 401 } } })).toBe(false);
      expect(fn({ state: { error: null } })).toBe(30_000);
      expect(fn({ state: { error: { status: 500 } } })).toBe(30_000);
    }
  });

  it("preserves false when interval is disabled", () => {
    expect(pollInterval(false)).toBe(false);
  });
});

describe("createAuthSessionRecoveryCoordinator", () => {
  it("ignores non-401 responses", () => {
    const redirectToLogin = vi.fn();
    const coordinator = createAuthSessionRecoveryCoordinator({
      redirectToLogin,
      getLocation: () => ({ pathname: "/OPE/agents/all", search: "", hash: "" }),
    });

    const handled = coordinator.handleUnauthorized(500);
    expect(handled).toBe(false);
    expect(coordinator.isSessionExpired()).toBe(false);
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("does not redirect if already on an auth path", () => {
    const redirectToLogin = vi.fn();
    const coordinator = createAuthSessionRecoveryCoordinator({
      redirectToLogin,
      getLocation: () => ({ pathname: "/auth", search: "", hash: "" }),
    });

    const handled = coordinator.handleUnauthorized(401);
    expect(handled).toBe(false);
    expect(coordinator.isSessionExpired()).toBe(false);
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("marks session expired, fires listeners, and redirects on protected 401", () => {
    const redirectToLogin = vi.fn();
    const onUnauthorized = vi.fn();
    const coordinator = createAuthSessionRecoveryCoordinator({
      redirectToLogin,
      getLocation: () => ({ pathname: "/OPE/agents/all", search: "?filter=active", hash: "" }),
    });

    coordinator.onUnauthorized(onUnauthorized);

    const handled = coordinator.handleUnauthorized(401);
    expect(handled).toBe(true);
    expect(coordinator.isSessionExpired()).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(redirectToLogin).toHaveBeenCalledWith("/auth?next=%2FOPE%2Fagents%2Fall%3Ffilter%3Dactive");

    // Repeated 401 does not fire redirect or listeners again
    const secondHandled = coordinator.handleUnauthorized(401);
    expect(secondHandled).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(redirectToLogin).toHaveBeenCalledTimes(1);

    // Reset clears expired state
    coordinator.reset();
    expect(coordinator.isSessionExpired()).toBe(false);
  });
});
