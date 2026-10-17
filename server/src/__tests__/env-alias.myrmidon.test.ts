// myrmidon(REBRAND-C): acceptance tests for the MYRMIDON_* environment read
// path. The product reads MYRMIDON_*; a PAPERCLIP_* spelling keeps working for
// one release as an alias with a deprecation warning. These tests fail on the
// vendor code path (direct process.env.PAPERCLIP_* reads): a setup that only
// sets the new names stops working, and precedence flips once the read order
// changes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { readProductEnv, resetEnvAliasWarningsForTest } from "@paperclipai/shared/env-alias";

describe("MYRMIDON_* env names with PAPERCLIP_* alias", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvAliasWarningsForTest();
  });

  it("reads a setting from the new MYRMIDON_* name", () => {
    vi.stubEnv("MYRMIDON_LOG_LEVEL", "debug");
    vi.stubEnv("MYRMIDON_ANNOUNCEMENTS_ENABLED", "true");
    const config = loadConfig();
    expect(config.announcementsEnabled).toBe(true);
    expect(readProductEnv("LOG_LEVEL")).toBe("debug");
  });

  it("an installation with only the old PAPERCLIP_* names still works (alias)", () => {
    // myrmidon(REBRAND-C): the compatibility contract of the release.
    vi.stubEnv("PAPERCLIP_ANNOUNCEMENTS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_LOG_LEVEL", "debug");
    const config = loadConfig();
    expect(config.announcementsEnabled).toBe(true);
    expect(readProductEnv("LOG_LEVEL")).toBe("debug");
  });

  it("when both names are set, the new MYRMIDON_* name wins", () => {
    vi.stubEnv("MYRMIDON_ANNOUNCEMENTS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_ANNOUNCEMENTS_ENABLED", "false");
    expect(loadConfig().announcementsEnabled).toBe(true);

    vi.stubEnv("MYRMIDON_ANNOUNCEMENTS_ENABLED", "false");
    vi.stubEnv("PAPERCLIP_ANNOUNCEMENTS_ENABLED", "true");
    expect(loadConfig().announcementsEnabled).toBe(false);
  });

  it("the old name alone produces exactly one deprecation warning per variable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubEnv("PAPERCLIP_LOG_LEVEL", "debug");
      expect(readProductEnv("LOG_LEVEL")).toBe("debug");
      expect(readProductEnv("LOG_LEVEL")).toBe("debug");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("PAPERCLIP_LOG_LEVEL");
      expect(warn.mock.calls[0]![0]).toContain("MYRMIDON_LOG_LEVEL");
    } finally {
      warn.mockRestore();
    }
  });

  it("no warning when only the new name is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubEnv("MYRMIDON_LOG_LEVEL", "debug");
      expect(readProductEnv("LOG_LEVEL")).toBe("debug");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a whole old-style installation boots: loadConfig resolves with old names only", () => {
    // myrmidon(REBRAND-C): the ticket acceptance criterion — a setup with old
    // names starts and works.
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PAPERCLIP_AUTH_DISABLE_SIGN_UP", "true");
    vi.stubEnv("PAPERCLIP_ANNOUNCEMENTS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_UI_DEV_MIDDLEWARE", "false");
    const config = loadConfig();
    expect(config.deploymentMode).toBe("authenticated");
    expect(config.authDisableSignUp).toBe(true);
    expect(config.announcementsEnabled).toBe(true);
    expect(config.uiDevMiddleware).toBe(false);
  });
});
