// DEBRAND (OPE-5806): migration of legacy `paperclip.*` browser storage keys
// into `myrmidon.*`. myrmidon(DB3)
import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_KEYS_UNDER_MIGRATION,
  migrateLegacyPaperclipStorage,
  readMigratedStorageItem,
  toMyrmidonKey,
  writeMigratedStorageItem,
} from "./storage-brand-migration";

describe("storage brand migration (paperclip.* -> myrmidon.*)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("maps legacy keys preserving the separator style", () => {
    expect(toMyrmidonKey("paperclip.theme")).toBe("myrmidon.theme");
    expect(toMyrmidonKey("paperclip:plugin-issues-view")).toBe("myrmidon:plugin-issues-view");
    expect(toMyrmidonKey("proj-1:paperclip:projects:proj-1")).toBe("proj-1:myrmidon:projects:proj-1");
  });

  it("readMigratedStorageItem copies the legacy key into the new key and removes it", () => {
    window.localStorage.setItem("paperclip.sidebar.width", "312");
    expect(readMigratedStorageItem("myrmidon.sidebar.width")).toBe("312");
    expect(window.localStorage.getItem("myrmidon.sidebar.width")).toBe("312");
    expect(window.localStorage.getItem("paperclip.sidebar.width")).toBeNull();
  });

  it("readMigratedStorageItem prefers the new key when both exist", () => {
    window.localStorage.setItem("paperclip.sidebar.width", "old");
    window.localStorage.setItem("myrmidon.sidebar.width", "new");
    expect(readMigratedStorageItem("myrmidon.sidebar.width")).toBe("new");
    expect(window.localStorage.getItem("paperclip.sidebar.width")).toBe("old");
  });

  it("writeMigratedStorageItem writes only the new key", () => {
    writeMigratedStorageItem("myrmidon.missions", "running");
    expect(window.localStorage.getItem("myrmidon.missions")).toBe("running");
    expect(window.localStorage.getItem("paperclip.missions")).toBeNull();
  });

  it("startup sweep migrates dot, colon, dash, composite and session keys", () => {
    window.localStorage.setItem("paperclip.theme", "dark");
    window.localStorage.setItem("paperclip-onboarding-state", '{"step":2}');
    window.localStorage.setItem("paperclip:plugin-issues-view:proj-1", '{"tab":"all"}');
    window.localStorage.setItem("proj-1:paperclip:projects:proj-1", "[\"a\"]");
    window.sessionStorage.setItem("paperclip.onboarding-active", "1");
    migrateLegacyPaperclipStorage();
    expect(window.localStorage.getItem("myrmidon.theme")).toBe("dark");
    expect(window.localStorage.getItem("paperclip.theme")).toBeNull();
    expect(window.localStorage.getItem("myrmidon-onboarding-state")).toBe('{"step":2}');
    expect(window.localStorage.getItem("paperclip-onboarding-state")).toBeNull();
    expect(window.localStorage.getItem("myrmidon:plugin-issues-view:proj-1")).toBe('{"tab":"all"}');
    expect(window.localStorage.getItem("paperclip:plugin-issues-view:proj-1")).toBeNull();
    expect(window.localStorage.getItem("proj-1:myrmidon:projects:proj-1")).toBe('["a"]');
    expect(window.localStorage.getItem("proj-1:paperclip:projects:proj-1")).toBeNull();
    expect(window.sessionStorage.getItem("myrmidon.onboarding-active")).toBe("1");
    expect(window.sessionStorage.getItem("paperclip.onboarding-active")).toBeNull();
  });

  it("startup sweep keeps the newer value when the new key already exists", () => {
    window.localStorage.setItem("paperclip.theme", "old");
    window.localStorage.setItem("myrmidon.theme", "new");
    migrateLegacyPaperclipStorage();
    expect(window.localStorage.getItem("myrmidon.theme")).toBe("new");
    expect(window.localStorage.getItem("paperclip.theme")).toBeNull();
  });

  it("startup sweep leaves paperclip.recentTasks:* alone (v2 reader migrates it)", () => {
    // lib/recent-tasks.ts migrates the legacy prefix to myrmidon.recentTasks.v2:*;
    // a naive sweep to myrmidon.recentTasks:* would strand the value.
    window.localStorage.setItem("paperclip.recentTasks:c-1:u-1", "[]");
    migrateLegacyPaperclipStorage();
    expect(window.localStorage.getItem("paperclip.recentTasks:c-1:u-1")).toBe("[]");
    expect(window.localStorage.getItem("myrmidon.recentTasks:c-1:u-1")).toBeNull();
  });

  it("startup sweep is idempotent and touches unrelated keys", () => {
    window.localStorage.setItem("paperclip.theme", "dark");
    window.localStorage.setItem("unrelated-key", "x");
    migrateLegacyPaperclipStorage();
    const first = window.localStorage.getItem("myrmidon.theme");
    migrateLegacyPaperclipStorage();
    expect(window.localStorage.getItem("myrmidon.theme")).toBe(first);
    expect(window.localStorage.getItem("unrelated-key")).toBe("x");
  });

  it("locked legacy key list stays non-empty and paperclip-prefixed", () => {
    expect(LEGACY_KEYS_UNDER_MIGRATION.length).toBeGreaterThan(0);
    for (const key of LEGACY_KEYS_UNDER_MIGRATION) {
      expect(key).toContain("paperclip");
    }
  });
});
