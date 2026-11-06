import { describe, expect, it } from "vitest";

import {
  BOT_DEVELOPER_TOOL_GROUPS,
  BOT_STANDARD_TOOL_GROUPS,
  BOT_TOOL_GROUPS,
  DEFAULT_BOT_DEVELOPER_ROLES,
  botToolDietTier,
  parseBotDeveloperRoles,
  parseBotRoleToolDiet,
  resolveBotToolDiet,
  type BotToolDietRequest,
} from "./tool-diet.js";

// myrmidon(TOOL-DIET-ROLES, OPE-11947): role (caste key) + card -> the tools a bot keeps out of its schema.

/** What a role is shown to use in the measured sample, plus the board tools: never on any default list. */
const TOOLS_THAT_STAY = [
  "terminal",
  "process_manage",
  "read_file",
  "write_file",
  "patch",
  "search_files",
  "read_stale_tool_result",
  "skill_view",
  "skills_list",
  "execute_code",
  "todo_list",
  "session_search",
  "delegate_task",
  "tool_search",
  "tool_describe",
  "tool_call",
];

function diet(overrides: Partial<BotToolDietRequest> = {}) {
  return resolveBotToolDiet({ role: "engineer", cardToolsets: [], keepTools: [], ...overrides });
}

describe("myrmidon(TOOL-DIET-ROLES) groups", () => {
  it("names only valid Hermes tool names, and never a tool a role is shown to use", () => {
    const all = Object.values(BOT_TOOL_GROUPS).flatMap((group) => [...group.tools, ...group.disabledToolsets]);
    for (const name of all) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
    for (const name of TOOLS_THAT_STAY) expect(all).not.toContain(name);
  });

  it("the standard tier is a subset of the developer tier", () => {
    for (const key of BOT_STANDARD_TOOL_GROUPS) expect(BOT_DEVELOPER_TOOL_GROUPS).toContain(key);
    expect(BOT_STANDARD_TOOL_GROUPS).not.toContain("memory");
    expect(BOT_STANDARD_TOOL_GROUPS).not.toContain("web");
  });

  it("memory is a toolset gate: it takes the Hindsight provider tools with it", () => {
    expect(BOT_TOOL_GROUPS.memory.disabledToolsets).toEqual(["memory"]);
    expect(BOT_TOOL_GROUPS.memory.tools).toEqual([]);
  });
});

describe("myrmidon(TOOL-DIET-ROLES) resolveBotToolDiet", () => {
  it("developer roles with a card that names no toolsets get the whole developer list", () => {
    for (const role of DEFAULT_BOT_DEVELOPER_ROLES) {
      const result = diet({ role });
      expect(result?.tier).toBe("developer");
      expect(result?.disabledToolsets).toEqual(["memory"]);
      expect(result?.disabledTools).toEqual(
        expect.arrayContaining([
          "web_search",
          "web_extract",
          "browser_exec",
          "browser_navigate",
          "browser_vault_fill",
          "image_generate",
          "video_generate",
          "text_to_speech",
        ]),
      );
      for (const name of TOOLS_THAT_STAY) expect(result?.disabledTools).not.toContain(name);
    }
  });

  it("matches the role as a caste key, case-insensitively, and never by anything else", () => {
    expect(diet({ role: "  Reviewer " })?.tier).toBe("developer");
    expect(diet({ role: "RELEASE" })?.tier).toBe("developer");
    expect(botToolDietTier("Engineer", undefined)).toBe("developer");
    expect(botToolDietTier("lead", undefined)).toBe("standard");
  });

  it("every other role gets the standard list: browser and media tools only, memory and web stay", () => {
    for (const role of ["lead", "operator", "analyst", "infra", "qa", "copywriter", "general"]) {
      const result = diet({ role });
      expect(result?.tier).toBe("standard");
      expect(result?.disabledToolsets).toEqual([]);
      expect(result?.disabledTools).toEqual(expect.arrayContaining(["browser_exec", "image_generate"]));
      expect(result?.disabledTools).not.toContain("web_search");
      expect(result?.disabledTools).not.toContain("web_extract");
    }
  });

  it("a bot with no role gets no role diet", () => {
    for (const role of [undefined, null, "", "   "]) expect(diet({ role })).toBeUndefined();
  });

  it("a toolset the card lists itself is never dropped by the role", () => {
    // The card of a bot that asked for memory, web and the browser.
    const asked = diet({ cardToolsets: ["terminal", "file", "web", "memory", "browser", "clarify"] });
    expect(asked?.disabledToolsets).toEqual([]);
    expect(asked?.disabledTools).not.toContain("web_search");
    expect(asked?.disabledTools).not.toContain("browser_exec");
    // Media was not asked for, so it still goes.
    expect(asked?.disabledTools).toEqual(expect.arrayContaining(["image_generate", "text_to_speech"]));
    // One browser toolset keeps the whole browser group (the card chose its own surface).
    expect(diet({ cardToolsets: ["browser-use"] })?.disabledTools).not.toContain("browser_navigate");
    // Names are compared trimmed and case-insensitively.
    expect(diet({ cardToolsets: [" Memory "] })?.disabledToolsets).toEqual([]);
  });

  it("keepTools re-enables a group by key or toolset name, or one tool by name", () => {
    expect(diet({ keepTools: ["memory"] })?.disabledToolsets).toEqual([]);
    expect(diet({ keepTools: ["web"] })?.disabledTools).not.toContain("web_search");
    expect(diet({ keepTools: ["browser-cdp"] })?.disabledTools).not.toContain("browser_exec");
    const one = diet({ keepTools: ["web_search"] });
    expect(one?.disabledTools).not.toContain("web_search");
    expect(one?.disabledTools).toContain("web_extract");
    expect(one?.disabledToolsets).toEqual(["memory"]);
  });

  it("the developer roles are the instance's to name", () => {
    expect(diet({ role: "lead", developerRoles: ["lead"] })?.tier).toBe("developer");
    expect(diet({ role: "engineer", developerRoles: [] })?.tier).toBe("standard");
    expect(diet({ role: "engineer", developerRoles: [] })?.disabledToolsets).toEqual([]);
  });

  it("is deterministic: the same request gives the same lists in the same order", () => {
    expect(diet({ role: "engineer" })).toEqual(diet({ role: "engineer" }));
    const names = diet({ role: "engineer" })?.disabledTools ?? [];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("myrmidon(TOOL-DIET-ROLES) instance settings", () => {
  it("MYRMIDON_BOT_ROLE_TOOL_DIET: unset is on, an off token is off", () => {
    expect(parseBotRoleToolDiet(null)).toBe(true);
    expect(parseBotRoleToolDiet("on")).toBe(true);
    expect(parseBotRoleToolDiet("1")).toBe(true);
    for (const raw of ["off", " OFF ", "0", "false", "no", "none", "-"]) expect(parseBotRoleToolDiet(raw)).toBe(false);
  });

  it("MYRMIDON_BOT_DEVELOPER_ROLES: unset is the default, none is empty, otherwise clean unique keys", () => {
    expect(parseBotDeveloperRoles(null)).toEqual([...DEFAULT_BOT_DEVELOPER_ROLES]);
    for (const raw of ["none", " NONE ", "off", "-"]) expect(parseBotDeveloperRoles(raw)).toEqual([]);
    expect(parseBotDeveloperRoles(" Engineer , lead,, engineer, bad role!, qa-lead")).toEqual(["engineer", "lead", "qa-lead"]);
    // Nothing usable falls back to the default instead of emptying the developer tier.
    expect(parseBotDeveloperRoles("!!, ??")).toEqual([...DEFAULT_BOT_DEVELOPER_ROLES]);
  });
});
