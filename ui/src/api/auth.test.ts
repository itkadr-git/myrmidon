import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthSessionRecoveryCoordinator,
  authSessionRecovery,
} from "@/lib/auth-session-recovery";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";
import { authApi } from "./auth";

afterEach(() => {
  authSessionRecovery.reset();
  tenantSessionRecovery.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authApi.getSession", () => {
  it("redirects and stays pending when the protected session endpoint returns 401", async () => {
    const redirectToLogin = vi.fn();
    const recovery = createAuthSessionRecoveryCoordinator({
      redirectToLogin,
      getLocation: () => ({ pathname: "/OPE/agents/all", search: "?filter=active", hash: "" }),
    });
    vi.spyOn(authSessionRecovery, "handleUnauthorized").mockImplementation(
      recovery.handleUnauthorized,
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = authApi.getSession();
    await vi.waitFor(() =>
      expect(redirectToLogin).toHaveBeenCalledWith(
        "/auth?next=%2FOPE%2Fagents%2Fall%3Ffilter%3Dactive",
      ),
    );
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("returns null for an ordinary local 401", async () => {
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockReturnValue(false);
    const handleUnauthorized = vi
      .spyOn(authSessionRecovery, "handleUnauthorized")
      .mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getSession()).resolves.toBeNull();
    expect(handleUnauthorized).toHaveBeenCalledWith(401, { error: "unauthorized" });
  });

  it("initiates recovery and stays pending for a Cloud tenant-session 401", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = authApi.getSession();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe("authApi.signOut", () => {
  it("returns the managed deployment redirect from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, redirectTo: "/cloud/logout" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.signOut()).resolves.toEqual({
      success: true,
      redirectTo: "/cloud/logout",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});
