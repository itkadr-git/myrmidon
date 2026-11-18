// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

let host: HTMLDivElement;
let root: Root;
const endpoint = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  http.get.mockReset();
  http.post.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function renderQueue(targetItemId: string | null) {
  let resolve!: (value: { suggestions: Array<{ id: string; body: string; targetItemId: string | null; rationale: string }> }) => void;
  http.get.mockReturnValue(new Promise((done) => { resolve = done; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>));
  await act(async () => { resolve({ suggestions: [
    { id: "s1", body: "First body", targetItemId, rationale: "" },
    { id: "s2", body: "Second body", targetItemId, rationale: "" },
  ] }); });
  await vi.waitFor(() => expect(host.querySelectorAll("section")).toHaveLength(2));
}

async function click(row: number, label: string) {
  const section = host.querySelectorAll("section")[row];
  expect(section).toBeDefined();
  const button = Array.from(section.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(button).toBeDefined();
  expect(button?.disabled).toBe(false);
  await act(async () => { button?.click(); });
}

async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fields(row: number) {
  const section = host.querySelectorAll("section")[row];
  const content = section.querySelector("textarea");
  expect(content).not.toBeNull();
  return { content: content!, inputs: Array.from(section.querySelectorAll("input")) };
}

describe.each([["existing item", "i1"], ["new item", null]] as const)("cancel unsaved edits for %s", (_kind, targetItemId) => {
  it("isolates both suggestions and discards the first unsaved edit without a write", async () => {
    await renderQueue(targetItemId);
    expect(http.get.mock.calls).toEqual([[endpoint]]);
    await click(0, "Edit");
    let editor = fields(0);
    expect(editor.content.value).toBe("First body");
    expect(editor.inputs.map((input) => input.value)).toEqual(targetItemId ? [] : ["", ""]);
    await change(editor.content, "Unsaved first body");
    if (!targetItemId) {
      await change(editor.inputs[0], "Unsaved title");
      await change(editor.inputs[1], "unsaved-slug");
      expect(editor.inputs.map((input) => input.value)).toEqual(["Unsaved title", "unsaved-slug"]);
    }
    expect(editor.content.value).toBe("Unsaved first body");
    await click(0, "Cancel");
    expect(host.querySelector("textarea")).toBeNull();
    await click(1, "Edit");
    editor = fields(1);
    expect(editor.content.value).toBe("Second body");
    expect(editor.inputs.map((input) => input.value)).toEqual(targetItemId ? [] : ["", ""]);
    await click(1, "Cancel");
    await click(0, "Edit");
    editor = fields(0);
    expect(editor.content.value).toBe("First body");
    expect(editor.inputs.map((input) => input.value)).toEqual(targetItemId ? [] : ["", ""]);
    expect(http.get.mock.calls).toEqual([[endpoint]]);
    expect(http.post).not.toHaveBeenCalled();
  });
});
