// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";
import { knowledgeReviewApi, type KnowledgeSuggestion } from "./knowledgeReviewApi";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

const company = "company /%#\u96ea";
const id = "suggestion /%#\u96ea";
const target = "item /%#\u96ea";
const base = "/myrmidon/companies/company%20%2F%25%23%E9%9B%AA/knowledge";
const suggestion: KnowledgeSuggestion = { id, body: "body", targetItemId: target, rationale: null };
const input = { content: "  content  ", title: "  title  ", slug: "  slug  " };

beforeEach(() => { http.get.mockReset(); http.post.mockReset(); });

describe("knowledgeReviewApi transport boundary", () => {
  it("encodes the company once and requests only pending suggestions", async () => {
    const response = { suggestions: [suggestion] };
    http.get.mockResolvedValue(response);
    await expect(knowledgeReviewApi.pending(company)).resolves.toBe(response);
    expect(http.get.mock.calls).toEqual([[`${base}/suggestions?status=pending`]]);
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each(["accept", "decline"] as const)("encodes the suggestion once for %s with an empty payload", async (action) => {
    const response = { ok: true };
    http.post.mockResolvedValue(response);
    await expect(knowledgeReviewApi.decide(company, id, action)).resolves.toBe(response);
    expect(http.post.mock.calls).toEqual([[`${base}/suggestions/suggestion%20%2F%25%23%E9%9B%AA/${action}`, {}]]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("encodes the target once and sends only content for an existing page", async () => {
    http.post.mockResolvedValue("saved");
    await expect(knowledgeReviewApi.saveDraft(company, suggestion, input)).resolves.toBe("saved");
    expect(http.post.mock.calls).toEqual([[`${base}/items/item%20%2F%25%23%E9%9B%AA/draft`, { content: "  content  " }]]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("creates a page with untrimmed content and trimmed title and slug", async () => {
    http.post.mockResolvedValue("created");
    await expect(knowledgeReviewApi.saveDraft(company, { ...suggestion, targetItemId: null }, input)).resolves.toBe("created");
    expect(http.post.mock.calls).toEqual([[`${base}/items`, { content: "  content  ", title: "title", slug: "slug" }]]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it.each(["pending", "decide", "draft"] as const)("propagates the same %s rejection without another request", async (operation) => {
    const error = new Error("transport failed");
    http.get.mockRejectedValue(error);
    http.post.mockRejectedValue(error);
    const request = operation === "pending" ? knowledgeReviewApi.pending(company)
      : operation === "decide" ? knowledgeReviewApi.decide(company, id, "accept")
      : knowledgeReviewApi.saveDraft(company, suggestion, input);
    await expect(request).rejects.toBe(error);
    expect(http.get.mock.calls.length + http.post.mock.calls.length).toBe(1);
  });
});

describe("KnowledgeReview draft boundary", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find((element) => element.textContent === label);
    expect(button).toBeDefined();
    await act(async () => { button?.click(); });
    await settle();
  };
  const change = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); });

  it.each([true, false])("sends the exact editor payload for existing=%s before deciding", async (existing) => {
    http.get.mockResolvedValue({ suggestions: [{ id: "s1", body: "Original", targetItemId: existing ? "i1" : null, rationale: null }] });
    let resolveDraft: (value: unknown) => void = () => {};
    const draft = new Promise((resolve) => { resolveDraft = resolve; });
    http.post.mockReturnValueOnce(draft).mockResolvedValue({});
    await act(async () => root.render(createElement(QueryClientProvider, { client, children: createElement(KnowledgeReview) })) );
    await settle();
    expect(host.textContent).toContain("Original");
    await click("Edit");
    const editor = host.querySelector("textarea");
    expect(editor).not.toBeNull();
    await change(editor!, "  edited content  ");
    if (!existing) {
      const fields = host.querySelectorAll("input");
      expect(fields).toHaveLength(2);
      await change(fields[0], "  New title  ");
      await change(fields[1], "  new-slug  ");
    } else expect(host.querySelectorAll("input")).toHaveLength(0);
    await click("Save and accept");
    expect(http.post.mock.calls).toEqual(existing
      ? [["/myrmidon/companies/c1/knowledge/items/i1/draft", { content: "  edited content  " }]]
      : [["/myrmidon/companies/c1/knowledge/items", { content: "  edited content  ", title: "New title", slug: "new-slug" }]]);
    expect(host.querySelector("textarea")).not.toBeNull();
    await act(async () => { resolveDraft({}); await draft; });
    await settle();
    expect(http.post.mock.calls[1]).toEqual(["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]);
    expect(http.post).toHaveBeenCalledTimes(2);
  });
});
