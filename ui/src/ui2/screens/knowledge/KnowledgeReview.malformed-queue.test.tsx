// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReview } from "./KnowledgeReview";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), language: "en" }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ i18n: { language: mocks.language } }) }));

const endpoint = "/myrmidon/companies/c1/knowledge/suggestions?status=pending";
const row = { id: "s1", body: "Proposed text", targetItemId: "i1", rationale: "Reason" };
const cases = [["null", null], ["missing suggestions", {}], ["null suggestions", { suggestions: null }], ["object suggestions", { suggestions: {} }], ["invalid row", { suggestions: [{}] }]] as const;
let host: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><KnowledgeReview /></QueryClientProvider>));
}
async function waitForText(text: string) {
  await vi.waitFor(() => expect(host.textContent).toContain(text));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => { button?.click(); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset();
  mocks.post.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe.each([
  ["en", "Could not load suggestions", "Retry", "No pending suggestions", "Accept", "Reject"],
  ["ru", "Не удалось загрузить предложения", "Повторить", "Нет предложений на разбор", "Принять", "Отклонить"],
  ["ru-RU", "Не удалось загрузить предложения", "Повторить", "Нет предложений на разбор", "Принять", "Отклонить"],
] as const)("locale %s", (language, error, retry, empty, accept, reject) => {
  beforeEach(() => { mocks.language = language; });
  it.each(cases)("rejects %s and recovers via Retry", async (_name, malformed) => {
    let resolveRetry!: (value: unknown) => void;
    mocks.get.mockResolvedValueOnce(malformed).mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; })).mockResolvedValue({ suggestions: [] });
    mocks.post.mockResolvedValue({ suggestion: row });
    await render();
    await waitForText(error);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(error);
    expect(host.textContent).not.toContain(empty);
    expect(mocks.get.mock.calls).toEqual([[endpoint]]);
    expect(mocks.post).not.toHaveBeenCalled();
    await click(retry);
    expect(mocks.get.mock.calls).toEqual([[endpoint], [endpoint]]);
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => { resolveRetry({ suggestions: [row] }); });
    await waitForText(row.body);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain(empty);
    expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).toEqual([accept, reject, language === "en" ? "Edit" : "Править"]);
    await click(accept);
    await vi.waitFor(() => expect(mocks.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions/s1/accept", {}]]));
    await waitForText(empty);
  });
  it("renders a valid empty queue without an error or writes", async () => {
    mocks.get.mockResolvedValue({ suggestions: [] });
    await render();
    await waitForText(empty);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.get.mock.calls).toEqual([[endpoint]]);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
