// myrmidon(UI-RU): parity and no-English-in-RU guards for the fork catalog.
// The fork localization engine (myrmidon-i18n.ts) merges myrmidon-locales/*.json
// over the vendor catalog; these guards keep that catalog sound:
//   1. en/ru key sets match exactly (a missing key falls back to English on one
//      side and to the key string on the other — both are user-visible).
//   2. ru values contain no untranslated English sentences: latin letter runs
//      are allowed only for names of products, protocols and formats
//      (Myrmidon, Paperclip, PNG, gzip, LAN, VPN, CEO…), placeholders
//      ({{count}}) and punctuation.
// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import en from "./myrmidon-locales/en.json";
import ru from "./myrmidon-locales/ru.json";
import {
  FORK_LANGUAGES,
  mergeLocaleMessages,
  readStoredLanguage,
  setAppLanguage,
  storeLanguage,
  useAppLanguage,
  withForkCatalog,
} from "./myrmidon-i18n";
import { i18n } from "./index";
import { timeAgo } from "@/lib/timeAgo";

function flatten(
  messages: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    } else if (typeof value === "string") {
      out[path] = value;
    }
  }
  return out;
}

// Latin runs that are legitimate in RU copy: product/protocol/format names.
const ALLOWED_LATIN = new Set([
  "Myrmidon", "Paperclip", "Labs", "OpenClaw",
  "PNG", "JPEG", "WEBP", "GIF", "SVG", "gzip",
  "LAN", "VPN", "SSH", "API", "JSON",
  "CEO", "CTO", "CMO", "CFO", "DevOps", "QA", "PM",
  "markdown", "English", "ID", "Swarm",
  // myrmidon(GITHUB-APP-MANIFEST): the manifest flow names the forge the App
  // is created on — a product name, same class as Myrmidon/Paperclip.
  "GitHub",
  // plugin names (myrmidon_chatgpt-pool: «ChatGPT», myrmidon_google-ai, myrmidon_antigravity)
  // are product names, not untranslated copy.
  "ChatGPT", "Google", "Antigravity", "LiteLLM",
  // input placeholders stay language-neutral (role codes and URLs)
  "engineer", "https", "example", "com", "changelog",
  // myrmidon(1.7-AGENT-EXCHANGE-A): pull request / owner/repo are forge
  // concepts kept untranslated in RU copy, same class as GitHub.
  "pull", "request", "owner", "repo",
]);

// Specific pluginLabel keys where product qualifier tokens (e.g. "Pro" in "Google AI Pro") are permitted
const ALLOWED_KEY_LATIN: Record<string, Set<string>> = {
  "pluginLabels.myrmidon_google-ai._plugin": new Set(["Pro"]),
  "pluginLabels.myrmidon_google-ai.google-ai-sidebar": new Set(["Pro"]),
  "pluginLabels.myrmidon_google-ai.google-ai-page": new Set(["Pro"]),
};

// Common English words dictionary: ordinary English words that must not leak into RU copy.
const COMMON_ENGLISH_WORDS = new Set([
  "a", "about", "above", "accept", "account", "accounts", "action", "actions", "active",
  "add", "advanced", "after", "again", "against", "agent", "agents", "alert", "alerts",
  "all", "also", "an", "and", "any", "apply", "are", "as", "at", "available", "back",
  "be", "been", "before", "behind", "being", "below", "between", "board", "boards",
  "both", "build", "button", "buttons", "by", "can", "cancel", "change", "changes",
  "check", "checkbox", "choose", "clear", "click", "close", "comment", "comments",
  "completed", "config", "configuration", "configure", "confirm", "connect", "connection",
  "continue", "copy", "could", "count", "create", "created", "current", "custom", "cut",
  "dashboard", "date", "default", "defaults", "delete", "deleted", "deploy", "description",
  "detail", "details", "dialog", "did", "directory", "disable", "disabled", "disconnect",
  "dismiss", "do", "does", "doing", "done", "download", "down", "during", "each", "edit",
  "else", "enable", "enabled", "enter", "error", "errors", "export", "external", "failed",
  "failure", "false", "few", "field", "fields", "file", "files", "filter", "filters",
  "folder", "folders", "for", "form", "from", "further", "general", "get", "global", "group", "groups",
  "had", "has", "have", "having", "he", "help", "her", "here", "hers", "hide", "him", "his",
  "history", "home", "how", "if", "import", "in", "inactive", "info", "input", "install",
  "internal", "into", "is", "issue", "issues", "item", "items", "its", "just", "key",
  "keys", "label", "labels", "limit", "limits", "link", "links", "list", "lists", "load",
  "loading", "local", "log", "login", "logout", "logs", "manage", "may", "member", "members",
  "memory", "menu", "message", "messages", "might", "modal", "mode", "more", "most", "must",
  "name", "names", "new", "next", "no", "none", "nor", "not", "notice", "now", "null", "of",
  "off", "ok", "old", "on", "once", "only", "open", "option", "options", "or", "order",
  "organization", "other", "our", "ours", "out", "over", "own", "page", "pages", "panel",
  "paste", "path", "pause", "pending", "permission", "permissions", "please", "preference",
  "preferences", "press", "previous", "primary", "print", "private", "profile", "profiles", "project",
  "projects", "public", "queue", "ready", "refresh", "reject", "remove", "removed",
  "required", "reset", "resume", "retry", "role", "roles", "rule", "rules", "run", "running",
  "runs", "same", "save", "saved", "search", "secondary", "section", "sections", "select",
  "selected", "send", "service", "services", "set", "setting", "settings", "shall", "share",
  "she", "should", "show", "showing", "signin", "signout", "simple", "skip", "so", "some",
  "sort", "start", "started", "state", "status", "step", "steps", "stop", "stopped", "submit",
  "success", "successful", "such", "summary", "switch", "system", "tab", "table", "tabs",
  "task", "tasks", "team", "teams", "test", "tests", "than", "that", "the", "their", "theirs",
  "them", "then", "there", "these", "they", "this", "those", "through", "time", "title",
  "to", "toggle", "token", "tokens", "too", "total", "true", "type", "unavailable", "uncheck",
  "undefined", "under", "uninstall", "update", "updated", "upload", "up", "user", "users",
  "value", "values", "verify", "very", "view", "views", "warning", "warnings", "was", "we",
  "when", "where", "which", "who", "whom", "whose", "why", "will", "window", "with",
  "workspace", "would", "you", "your", "yours",
]);

function isAllowedExplicit(word: string, key?: string): boolean {
  if (word.length <= 1) return true; // single-letter shortcut hints
  if (ALLOWED_LATIN.has(word) || ALLOWED_LATIN.has(word.toUpperCase())) return true;
  const allowedForKey = key ? ALLOWED_KEY_LATIN[key] : undefined;
  if (allowedForKey instanceof Set && allowedForKey.has(word)) return true;
  // uppercase abbreviations, env vars, prefix tokens (PAP-, ID, MYR_LICENSE)
  if (/^[A-Z0-9_]{2,}-?$/.test(word)) return true;
  // hyphenated compound prefix before Cyrillic (Swarm-надзор, Telegram-личка)
  if (/^[A-Za-z0-9]+-$/.test(word)) return true;
  return false;
}

function isAllowedSingleTechnology(word: string): boolean {
  // Abbreviations and constants (e.g. S3, API, VPN, CPU, MYR_LICENSE)
  if (/^[A-Z0-9_]{2,}$/.test(word)) return true;
  // Words with digits (e.g. S3, p90, P0, PAP-1009, ED25519, IPv6)
  if (/\d/.test(word)) return true;
  // CamelCase (e.g. PostgreSQL, gRPC, OpenClaw, LiteLLM)
  if (/^[a-zA-Z0-9_-]*[a-z][A-Z][a-zA-Z0-9_-]*$/.test(word)) return true;
  // Capitalized word (Titlecase: e.g. Kubernetes, Docker, Telegram)
  if (/^[A-Z][a-z]+(-[A-Z][a-z]+)*$/.test(word)) return true;
  return false;
}

function unruledLatinRuns(value: string, key?: string): string[] {
  const withoutPlaceholders = value.replace(/\{\{[^}]+\}\}/g, " ");

  // Multi-word Latin sequence (>= 2 Latin words separated by spaces or slash)
  const multiWordRegex = /[A-Za-z][A-Za-z0-9_-]*(?:[\s/]+[A-Za-z][A-Za-z0-9_-]*)+/g;
  const multiMatches = withoutPlaceholders.match(multiWordRegex) ?? [];
  const offenders: string[] = [];

  for (const match of multiMatches) {
    const words = match.split(/[\s/]+/).filter((w) => w.length > 0);
    const allAllowed = words.every((w) => isAllowedExplicit(w, key));
    if (!allAllowed) {
      offenders.push(match);
    }
  }

  // Single Latin words
  const singleWordRegex = /[A-Za-z][A-Za-z0-9_-]*/g;
  const singleMatches = withoutPlaceholders.match(singleWordRegex) ?? [];

  for (const word of singleMatches) {
    if (word.length <= 1) continue;
    if (isAllowedExplicit(word, key)) continue;

    const lower = word.toLowerCase();
    if (COMMON_ENGLISH_WORDS.has(lower)) {
      if (!offenders.includes(word) && !offenders.some((m) => m.includes(word))) {
        offenders.push(word);
      }
      continue;
    }

    if (isAllowedSingleTechnology(word)) {
      continue;
    }

    if (!offenders.includes(word) && !offenders.some((m) => m.includes(word))) {
      offenders.push(word);
    }
  }

  return offenders;
}

describe("myrmidon fork i18n catalog", () => {
  it("en and ru expose the same key set", () => {
    const enKeys = Object.keys(flatten(en)).sort();
    const ruKeys = Object.keys(flatten(ru)).sort();
    expect(ruKeys).toEqual(enKeys);
  });

  it("ru values carry no untranslated English wording", () => {
    const flat = flatten(ru);
    const offenders = Object.entries(flat)
      .map(([key, value]) => ({ key, runs: unruledLatinRuns(value, key) }))
      .filter((entry) => entry.runs.length > 0);
    expect(
      offenders.map(({ key, runs }) => `${key}: ${runs.join(", ")}`),
    ).toEqual([]);
  });

  it("detector allows single technology names and flags English phrases or common words", () => {
    expect(unruledLatinRuns("Кластер Kubernetes")).toEqual([]);
    expect(unruledLatinRuns("База данных PostgreSQL")).toEqual([]);
    expect(unruledLatinRuns("Контейнер Docker")).toEqual([]);
    expect(unruledLatinRuns("Хранилище S3")).toEqual([]);
    expect(unruledLatinRuns("Вызов gRPC")).toEqual([]);

    expect(unruledLatinRuns("Сохранить settings")).toEqual(["settings"]);
    expect(unruledLatinRuns("Enable Kubernetes")).toEqual(["Enable Kubernetes"]);
  });

  it("every interpolation placeholder in en exists in ru", () => {
    const enFlat = flatten(en);
    const ruFlat = flatten(ru);
    const placeholder = /\{\{\s*([\w]+)\s*\}\}/g;
    const missing: string[] = [];
    for (const [key, value] of Object.entries(enFlat)) {
      const names = new Set([...value.matchAll(placeholder)].map((m) => m[1]));
      const ruValue = ruFlat[key] ?? "";
      for (const name of names) {
        if (!new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(ruValue)) {
          missing.push(`${key}: {{${name}}}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});


describe("myrmidon fork i18n engine", () => {
  it("mergeLocaleMessages deep-merges the fork catalog over the vendor messages", () => {
    const base = {
      vendor: { keep: "vendor", nested: { a: "a", b: "b" } },
      untouched: "stays",
    };
    const override = {
      vendor: { nested: { b: "B", c: "C" } },
      fork: "new",
    };
    expect(mergeLocaleMessages(base, override)).toEqual({
      vendor: { keep: "vendor", nested: { a: "a", b: "B", c: "C" } },
      untouched: "stays",
      fork: "new",
    });
  });

  it("withForkCatalog carries the fork EN catalog into every vendor locale and RU over EN", () => {
    const vendorMessages = {
      en: { vendor: "v-en" },
      de: { vendor: "v-de" },
    };
    const forkMessages = {
      en: { fork: "F", vendor: "overridden-en" },
      ru: { fork: "Р", vendor: "overridden-ru" },
    };
    const merged = withForkCatalog(vendorMessages, forkMessages);
    expect(merged.en).toEqual({ vendor: "overridden-en", fork: "F" });
    expect(merged.de).toEqual({ vendor: "overridden-en", fork: "F" });
    expect(merged.ru).toEqual({ vendor: "overridden-ru", fork: "Р" });
  });

  it("readStoredLanguage accepts the fork languages, rejects junk and survives a throwing localStorage", () => {
    for (const language of FORK_LANGUAGES) {
      window.localStorage.setItem("myrmidon:ui-language", language);
      expect(readStoredLanguage()).toBe(language);
    }
    window.localStorage.setItem("myrmidon:ui-language", "klingon");
    expect(readStoredLanguage()).toBe("en");
    window.localStorage.clear();

    const throwing = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    };
    vi.spyOn(window, "localStorage", "get").mockReturnValue(throwing as unknown as Storage);
    expect(readStoredLanguage()).toBe("en");
    vi.restoreAllMocks();
  });

  it("setAppLanguage switches the live i18n instance, the document language and storage; the storage-event path does the same", async () => {
    storeLanguage("en");
    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    await setAppLanguage("ru");
    expect(i18n.language).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(window.localStorage.getItem("myrmidon:ui-language")).toBe("ru");

    // cross-tab path: another tab wrote "en"; the storage handler that
    // useAppLanguage registers must move the live instance back, not just
    // the toggle state
    let captured: { language: string } | null = null;
    function Harness() {
      captured = useAppLanguage();
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const { act } = await import("react-dom/test-utils");
    await act(async () => {
      root.render(<Harness />);
    });
    expect(captured!.language).toBe("ru");

    await act(async () => {
      window.localStorage.setItem("myrmidon:ui-language", "en");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "myrmidon:ui-language", newValue: "en" }),
      );
    });
    expect(captured!.language).toBe("en");
    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    await act(async () => {
      root.unmount();
    });
    container.remove();

    await setAppLanguage("en");
  });

  it("timeAgo without a translator reproduces the vendor English output exactly", () => {
    expect(timeAgo(new Date())).toBe("just now");
    const minuteAgo = new Date(Date.now() - 30_000);
    expect(timeAgo(minuteAgo)).toBe("just now");
    const minutesAgo = new Date(Date.now() - 5 * 60_000);
    expect(timeAgo(minutesAgo)).toBe("5m ago");
    const hoursAgo = new Date(Date.now() - 3 * 3_600_000);
    expect(timeAgo(hoursAgo)).toBe("3h ago");
    const daysAgo = new Date(Date.now() - 2 * 86_400_000);
    expect(timeAgo(daysAgo)).toBe("2d ago");
    const weeksAgo = new Date(Date.now() - 3 * 7 * 86_400_000);
    expect(timeAgo(weeksAgo)).toBe("3w ago");
    const monthsAgo = new Date(Date.now() - 40 * 30 * 86_400_000);
    expect(timeAgo(monthsAgo)).toBe("40mo ago");
  });

  it("timeAgo with a translator uses the fork keys and interpolates count", () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const t = (key: string, options?: Record<string, unknown>) => {
      calls.push([key, options]);
      return `${key}:${options?.count ?? ""}`;
    };
    expect(timeAgo(new Date(), t)).toBe("time.justNow:");
    expect(timeAgo(new Date(Date.now() - 5 * 60_000), t)).toBe("time.minutesAgo:5");
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000), t)).toBe("time.hoursAgo:3");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000), t)).toBe("time.daysAgo:2");
    expect(timeAgo(new Date(Date.now() - 3 * 7 * 86_400_000), t)).toBe("time.weeksAgo:3");
    expect(timeAgo(new Date(Date.now() - 40 * 30 * 86_400_000), t)).toBe("time.monthsAgo:40");
  });
});
