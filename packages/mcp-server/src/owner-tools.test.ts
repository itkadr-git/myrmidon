import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createOwnerToolDefinitions } from "./owner-tools.js";
import { withMyrmidonToolNames } from "./tool-aliases.js";
import { createToolDefinitions } from "./tools.js";

const INTERACTION_ID = "11111111-1111-4111-8111-111111111111";
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "33333333-3333-4333-8333-333333333333",
    agentId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555",
  });
}

function getTool(name: string) {
  const tool = createOwnerToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner dialogue MCP tools", () => {
  it("publishes both tools under their myrmidon names, without paperclip aliases", () => {
    const names = withMyrmidonToolNames([
      ...createToolDefinitions(makeClient()),
      ...createOwnerToolDefinitions(makeClient()),
    ]).map((tool) => tool.name);
    expect(names).toContain("myrmidonMessageOwner");
    expect(names).toContain("myrmidonResolveInteractionByOwnerReply");
    expect(names).not.toContain("paperclipMessageOwner");
    expect(new Set(names).size).toBe(names.length);
  });

  it("posts the owner message with the run id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ commentId: COMMENT_ID }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await getTool("myrmidonMessageOwner").execute({
      interactionIds: [INTERACTION_ID],
      text: "Please choose the deploy window.",
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/myrmidon/owner-message");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      interactionIds: [INTERACTION_ID],
      text: "Please choose the deploy window.",
    });
    expect(response.content[0]?.text).toContain(COMMENT_ID);
  });

  it("posts the resolution with the owner's comment id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await getTool("myrmidonResolveInteractionByOwnerReply").execute({
      interactionId: INTERACTION_ID,
      ownerReplyCommentId: COMMENT_ID,
      action: "accept",
      body: {},
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/myrmidon/owner-message/resolve");
    expect(JSON.parse(String(init.body))).toEqual({
      interactionId: INTERACTION_ID,
      ownerReplyCommentId: COMMENT_ID,
      action: "accept",
      body: {},
    });
  });

  it("reports a refused call as an error response instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const response = await getTool("myrmidonMessageOwner").execute({
      interactionIds: [INTERACTION_ID],
      text: "Not mine.",
    });
    expect(response.content[0]?.text).toContain("403");
  });

  it("rejects an invalid action before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await getTool("myrmidonResolveInteractionByOwnerReply").execute({
      interactionId: INTERACTION_ID,
      ownerReplyCommentId: COMMENT_ID,
      action: "cancel",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.content[0]?.text).toContain("error");
  });
});
