// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  migrateLegacyBrowserStorage,
  migrateLegacyStorage,
  myrmidonStorageKey,
} from "./browser-storage";

describe("browser storage namespace migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("preserves the legacy separator when creating a Myrmidon key", () => {
    expect(myrmidonStorageKey("paperclip.theme")).toBe("myrmidon.theme");
    expect(myrmidonStorageKey("paperclip:issue-comment-draft:issue-1"))
      .toBe("myrmidon:issue-comment-draft:issue-1");
  });

  it("moves legacy values when the new key is missing or empty", () => {
    window.localStorage.setItem("paperclip.sidebar.width", "320");
    window.sessionStorage.setItem("paperclip:agent-chat-draft:company-1", "Draft");
    window.localStorage.setItem("myrmidon.theme", "");
    window.localStorage.setItem("paperclip.theme", "light");

    migrateLegacyBrowserStorage();

    expect(window.localStorage.getItem("myrmidon.sidebar.width")).toBe("320");
    expect(window.localStorage.getItem("myrmidon.theme")).toBe("light");
    expect(window.sessionStorage.getItem("myrmidon:agent-chat-draft:company-1")).toBe("Draft");
    expect(window.localStorage.getItem("paperclip.sidebar.width")).toBeNull();
    expect(window.localStorage.getItem("paperclip.theme")).toBeNull();
    expect(window.sessionStorage.getItem("paperclip:agent-chat-draft:company-1")).toBeNull();
  });

  it("keeps an existing Myrmidon value while removing its legacy key", () => {
    window.localStorage.setItem("myrmidon.sidebar.width", "400");
    window.localStorage.setItem("paperclip.sidebar.width", "320");

    migrateLegacyStorage(window.localStorage);

    expect(window.localStorage.getItem("myrmidon.sidebar.width")).toBe("400");
    expect(window.localStorage.getItem("paperclip.sidebar.width")).toBeNull();
  });

  it("preserves the language plugin locale key across startup migration", () => {
    window.localStorage.setItem("paperclip.lang.locale", "ru");

    migrateLegacyBrowserStorage();

    expect(window.localStorage.getItem("paperclip.lang.locale")).toBe("ru");
    expect(window.localStorage.getItem("myrmidon.lang.locale")).toBeNull();
  });
});
