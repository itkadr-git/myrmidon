import { beforeEach, describe, expect, it } from "vitest";
import {
  invokedBinaryName,
  isLegacyBinaryInvocation,
  resetLegacyBinaryWarningForTests,
  warnIfLegacyBinaryName,
} from "../legacy-bin.js";

describe("legacy paperclipai binary name", () => {
  beforeEach(() => resetLegacyBinaryWarningForTests());

  it("detects the old binary name, including Windows shim extensions", () => {
    expect(invokedBinaryName("/usr/local/bin/paperclipai")).toBe("paperclipai");
    expect(isLegacyBinaryInvocation("/usr/local/bin/paperclipai")).toBe(true);
    expect(isLegacyBinaryInvocation("C:\\npm\\paperclipai.cmd".replace(/\\/g, "/"))).toBe(true);
  });

  it("does not treat the new name or the bundled entrypoint as legacy", () => {
    expect(isLegacyBinaryInvocation("/usr/local/bin/myrmidon")).toBe(false);
    expect(isLegacyBinaryInvocation("/opt/node_modules/myrmidon/dist/index.js")).toBe(false);
    expect(isLegacyBinaryInvocation(undefined)).toBe(false);
  });

  it("warns once on stderr when invoked as paperclipai", () => {
    const messages: string[] = [];
    expect(warnIfLegacyBinaryName("/usr/bin/paperclipai", (m) => messages.push(m))).toBe(true);
    expect(warnIfLegacyBinaryName("/usr/bin/paperclipai", (m) => messages.push(m))).toBe(false);
    expect(messages).toEqual(["paperclipai is deprecated, use myrmidon\n"]);
  });

  it("stays silent when invoked as myrmidon", () => {
    const messages: string[] = [];
    expect(warnIfLegacyBinaryName("/usr/bin/myrmidon", (m) => messages.push(m))).toBe(false);
    expect(messages).toEqual([]);
  });

  it("warns for the deprecated package script alias", () => {
    const originalEvent = process.env.npm_lifecycle_event;
    process.env.npm_lifecycle_event = "paperclipai";
    const messages: string[] = [];
    try {
      expect(warnIfLegacyBinaryName("/node_modules/tsx/dist/cli.mjs", (m) => messages.push(m))).toBe(true);
      expect(messages).toEqual(["paperclipai is deprecated, use myrmidon\n"]);
    } finally {
      if (originalEvent === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = originalEvent;
    }
  });
});
