import { describe, expect, it, vi } from "vitest";
import { createSemanticMirror, splitSections } from "./semantic-mirror.js";

const json = (data: unknown, code = 0) => ({ ok: true, json: async () => ({ code, data }) }) as Response;

describe("knowledge semantic mirror", () => {
  it("splits markdown into section chunks without losing the preamble", () => {
    expect(splitSections("intro\n# One\nbody\n## Two\nmore")).toEqual(["intro", "# One\nbody", "## Two\nmore"]);
  });

  it("replaces old chunks and attaches document metadata on publish", async () => {
    const request = vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("/datasets?")) return json([{ id: "ds", name: "knowledge-mirror:nest" }]);
      if (url.includes("/documents?name=")) return json({ docs: [{ id: "doc", name: "item.txt" }] });
      return json({});
    });
    const mirror = createSemanticMirror("http://ragflow", "test-token", request as typeof fetch);
    await mirror.upsert({ itemId: "item", slug: "page", title: "Page", revision: 3, lang: "ru", space: "nest", content: "# One\na\n# Two\nb" });
    const calls = request.mock.calls.map(([url, options]) => [url, options.method, options.body]);
    expect(calls.filter(([url, method]) => String(url).endsWith("/chunks") && method === "POST")).toHaveLength(2);
    expect(calls.some(([url, method, body]) => String(url).endsWith("/doc") && method === "PATCH" && String(body).includes('"revision":3'))).toBe(true);
    expect(calls.some(([url, method, body]) => String(url).endsWith("/chunks") && method === "DELETE" && String(body).includes('"delete_all":true'))).toBe(true);
  });

  it("propagates business-code failures for FTS fallback", async () => {
    const request = vi.fn(async () => json(null, 100));
    await expect(createSemanticMirror("http://ragflow", "test-token", request as typeof fetch).search("nest", "q", 2)).rejects.toThrow("RAGFlow");
  });
});
