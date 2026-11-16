// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), company: "c1" as string | null, language: "en" }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.company }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: mocks.language } }) }));

const english = { heading: "Review suggestions", company: "Select a company", loading: "Loading suggestions...", empty: "No pending suggestions", error: "Could not load suggestions", retry: "Retry", edit: "Edit", accept: "Accept", reject: "Reject", content: "Content", save: "Save and accept", cancel: "Cancel" };
const russian = { heading: "Разбор предложений", company: "Выберите компанию", loading: "Загрузка предложений...", empty: "Нет предложений на разбор", error: "Не удалось загрузить предложения", retry: "Повторить", edit: "Править", accept: "Принять", reject: "Отклонить", content: "Содержание", save: "Сохранить и принять", cancel: "Отмена" };
const endpoint = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
}
function expectOnlyGet() {
  expect(mocks.get.mock.calls).toEqual([[endpoint]]);
  expect(mocks.post).not.toHaveBeenCalled();
}
function buttons() { return Array.from(host.querySelectorAll("button")).map((button) => button.textContent); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.company = "c1";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe.each([["en", english, russian], ["ru", russian, english], ["ru-RU", russian, english]] as const)("locale %s", (language, text, other) => {
  beforeEach(() => { mocks.language = language; });

  it("shows the company prompt without any request", async () => {
    mocks.company = null;
    await render();
    await settle();
    expect(host.textContent).toContain(text.company);
    expect(host.textContent).not.toContain(other.company);
    expect(host.querySelector("h1")).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("shows the localized loading state and then the empty state", async () => {
    let resolve!: (value: { suggestions: never[] }) => void;
    mocks.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    expect(host.querySelector("h1")?.textContent).toBe(text.heading);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(text.loading);
    expect(host.textContent).not.toContain(text.empty);
    expect(host.textContent).not.toContain(other.loading);
    expectOnlyGet();
    await act(async () => { resolve({ suggestions: [] }); });
    await settle();
    expect(host.textContent).toContain(text.empty);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain(other.empty);
    expectOnlyGet();
  });

  it("shows the localized load error and retry control", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    await render();
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe(text.heading);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(text.error);
    expect(buttons()).toContain(text.retry);
    expect(buttons()).not.toContain(other.retry);
    expect(host.textContent).not.toContain(text.empty);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expectOnlyGet();
  });

  it("shows localized actions and editor labels for an existing item", async () => {
    mocks.get.mockResolvedValue({ suggestions: [{ id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "" }] });
    await render();
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe(text.heading);
    expect(host.textContent).toContain("Proposed text");
    expect(buttons()).toEqual([text.accept, text.reject, text.edit]);
    expect(buttons()).not.toContain(other.edit);
    const edit = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === text.edit);
    expect(edit).toBeDefined();
    await act(async () => { edit?.click(); });
    const textarea = host.querySelector("textarea");
    expect(textarea?.closest("label")?.firstChild?.textContent).toBe(text.content);
    expect(textarea?.closest("label")?.firstChild?.textContent).not.toBe(other.content);
    expect(textarea?.value).toBe("Proposed text");
    expect(host.querySelector("input")).toBeNull();
    expect(buttons()).toEqual([text.save, text.cancel]);
    expect(buttons()).not.toContain(other.save);
    expect(buttons()).not.toContain(other.cancel);
    expectOnlyGet();
  });
});
