import { describe, expect, it, vi } from "vitest";

import { PaperclipApiClient } from "./client.js";
import { MYRMIDON_TOOL_NAME_MAP, toMyrmidonToolName, withMyrmidonToolNames } from "./tool-aliases.js";
import { createToolDefinitions, type ToolDefinition } from "./tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "***",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function publishedTools(): ToolDefinition[] {
  return withMyrmidonToolNames(createToolDefinitions(makeClient()));
}

describe("myrmidon MCP tool names with paperclip aliases (REBRAND D)", () => {
  it("maps every old paperclip* tool to a myrmidon* name", () => {
    const base = createToolDefinitions(makeClient());
    const oldNames = base.map((tool) => tool.name).filter((name) => name.startsWith("paperclip"));
    expect(oldNames).toHaveLength(42);
    for (const name of oldNames) {
      expect(toMyrmidonToolName(name)).toBe(`myrmidon${name.slice("paperclip".length)}`);
    }
    // the map covers exactly the old names that exist in the catalog
    expect(Object.keys(MYRMIDON_TOOL_NAME_MAP).sort()).toEqual([...oldNames].sort());
  });

  it("publishes the tool list under myrmidon* names", () => {
    const names = publishedTools().map((tool) => tool.name);
    expect(names).toContain("myrmidonMe");
    expect(names).toContain("myrmidonUpdateIssue");
    expect(names).toContain("myrmidonApiRequest");
    // non-board tools keep their names
    expect(names).toContain("connections_search");
    expect(names).toContain("connection_request");
  });

  it("keeps every old name as a deprecated alias marked in the description", () => {
    const tools = publishedTools();
    for (const [oldName, newName] of Object.entries(MYRMIDON_TOOL_NAME_MAP)) {
      const alias = tools.find((tool) => tool.name === oldName);
      expect(alias, `alias ${oldName} must stay registered`).toBeDefined();
      expect(alias?.description).toContain("deprecated");
      expect(alias?.description).toContain(newName);
    }
  });

  it("both names call one and the same handler", async () => {
    // No network here: the handler validates the path before fetch, so both
    // names must produce the identical error response from one handler.
    const tools = publishedTools();
    const newTool = tools.find((tool) => tool.name === "myrmidonApiRequest")!;
    const oldTool = tools.find((tool) => tool.name === "paperclipApiRequest")!;
    expect(oldTool.execute).toBe(newTool.execute);
    expect(oldTool.schema).toBe(newTool.schema);

    for (const tool of [newTool, oldTool]) {
      const response = await tool.execute({ method: "GET", path: "no-slash" });
      expect(response.content[0]?.text).toContain("path must start with /");
    }
  });

  it("aliases hit the same underlying API call as the new names", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tools = publishedTools();
      const newName = tools.find((tool) => tool.name === "myrmidonInboxLite")!;
      const oldName = tools.find((tool) => tool.name === "paperclipInboxLite")!;
      await newName.execute({});
      await oldName.execute({});
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [unknown, RequestInit];
      const [secondUrl, secondInit] = fetchMock.mock.calls[1] as [unknown, RequestInit];
      // same endpoint and same request from both names (URL objects differ by identity)
      expect(String(firstUrl)).toBe(String(secondUrl));
      expect(String(secondUrl)).toBe("http://localhost:3100/api/agents/me/inbox-lite");
      expect(firstInit.method).toBe(secondInit.method);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not rename tools without a paperclip prefix and does not duplicate names", () => {
    const names = publishedTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(createToolDefinitions(makeClient()).length + Object.keys(MYRMIDON_TOOL_NAME_MAP).length);
  });

  it("guards the map against catalog drift: every paperclip* tool has a mapping", () => {
    // A new `makeTool("paperclip…")` in tools.ts must be added to
    // MYRMIDON_TOOL_NAME_MAP in the same PR, otherwise it would ship
    // without the myrmidon* name (REBRAND D acceptance: the list contains
    // new names for every board tool).
    const unmapped = createToolDefinitions(makeClient())
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("paperclip") && !(name in MYRMIDON_TOOL_NAME_MAP));
    expect(unmapped).toEqual([]);
  });
});
