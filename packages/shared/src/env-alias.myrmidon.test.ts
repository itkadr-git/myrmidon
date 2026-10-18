// myrmidon(REBRAND-C): tests for the MYRMIDON_* env read path with the
// PAPERCLIP_* one-release alias. These tests fail on the vendor code path
// (direct process.env.PAPERCLIP_* reads): old-only setups stop working once
// the alias is removed, and precedence flips once the read order changes.

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  readProductEnv,
  readProductEnvFrom,
  materializeProductEnv,
  writeProductEnv,
  deleteProductEnv,
  isProductEnvKey,
  resetEnvAliasWarningsForTest,
} from "./env-alias.js";

const warn = vi.fn();

afterEach(() => {
  resetEnvAliasWarningsForTest();
  warn.mockReset();
});

describe("readProductEnv", () => {
  it("reads the MYRMIDON_* name", () => {
    const value = readProductEnv("RUN_STALL_ENABLED", {
      env: { MYRMIDON_RUN_STALL_ENABLED: "1" },
      warn,
    });
    expect(value).toBe("1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the old PAPERCLIP_* name when only it is set and warns once", () => {
    const env: NodeJS.ProcessEnv = { PAPERCLIP_RUN_STALL_ENABLED: "1" };
    expect(readProductEnv("RUN_STALL_ENABLED", { env, warn })).toBe("1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("PAPERCLIP_RUN_STALL_ENABLED");
    expect(warn.mock.calls[0]![0]).toContain("MYRMIDON_RUN_STALL_ENABLED");
    expect(warn.mock.calls[0]![0]).toContain("deprecated");

    // Same variable again: the warning is emitted exactly once.
    expect(readProductEnv("RUN_STALL_ENABLED", { env, warn })).toBe("1");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("prefers the new name when both are set", () => {
    const env: NodeJS.ProcessEnv = {
      MYRMIDON_LOG_LEVEL: "debug",
      PAPERCLIP_LOG_LEVEL: "info",
    };
    expect(readProductEnv("LOG_LEVEL", { env, warn })).toBe("debug");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty new-name value as unset and falls back to the old name", () => {
    const env: NodeJS.ProcessEnv = { MYRMIDON_LOG_LEVEL: "", PAPERCLIP_LOG_LEVEL: "info" };
    expect(readProductEnv("LOG_LEVEL", { env, warn })).toBe("info");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when neither name is set", () => {
    expect(readProductEnv("ABSENT", { env: {}, warn })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per variable name, not globally", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_LOG_LEVEL: "info",
      PAPERCLIP_LISTEN_PORT: "3200",
    };
    expect(readProductEnv("LOG_LEVEL", { env, warn })).toBe("info");
    expect(readProductEnv("LISTEN_PORT", { env, warn })).toBe("3200");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not warn again for a variable already warned through another call", () => {
    const env: NodeJS.ProcessEnv = { PAPERCLIP_LOG_LEVEL: "info" };
    readProductEnv("LOG_LEVEL", { env, warn });
    readProductEnv("LOG_LEVEL", { env, warn });
    readProductEnv("LOG_LEVEL", { env, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("readProductEnvFrom", () => {
  it("prefers the new name and falls back without warning", () => {
    expect(readProductEnvFrom({ MYRMIDON_API_URL: "new", PAPERCLIP_API_URL: "old" }, "API_URL")).toBe("new");
    expect(readProductEnvFrom({ PAPERCLIP_API_URL: "old" }, "API_URL")).toBe("old");
    expect(readProductEnvFrom({}, "API_URL")).toBeUndefined();
  });
});

describe("materializeProductEnv", () => {
  it("emits canonical names only, resolving aliases", () => {
    const env: NodeJS.ProcessEnv = {
      MYRMIDON_LISTEN_PORT: "3100",
      PAPERCLIP_PUBLIC_URL: "https://board.example.com",
      UNRELATED: "keep-me-out",
    };
    expect(materializeProductEnv(env, ["LISTEN_PORT", "PUBLIC_URL", "ABSENT"])).toEqual({
      MYRMIDON_LISTEN_PORT: "3100",
      MYRMIDON_PUBLIC_URL: "https://board.example.com",
    });
  });
});

describe("writeProductEnv / deleteProductEnv", () => {
  it("writes and deletes both spellings", () => {
    const env: NodeJS.ProcessEnv = {};
    writeProductEnv(env, "INSTANCE_ID", "default");
    expect(env.MYRMIDON_INSTANCE_ID).toBe("default");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("default");
    deleteProductEnv(env, "INSTANCE_ID");
    expect("MYRMIDON_INSTANCE_ID" in env).toBe(false);
    expect("PAPERCLIP_INSTANCE_ID" in env).toBe(false);
  });
});

describe("isProductEnvKey", () => {
  it("accepts both prefixes", () => {
    expect(isProductEnvKey("MYRMIDON_HOME")).toBe(true);
    expect(isProductEnvKey("PAPERCLIP_HOME")).toBe(true);
    expect(isProductEnvKey("PATH")).toBe(false);
    expect(isProductEnvKey("MYRMIDON")).toBe(false);
    expect(isProductEnvKey("PAPERCLIPAI_CMD")).toBe(false);
  });
});
