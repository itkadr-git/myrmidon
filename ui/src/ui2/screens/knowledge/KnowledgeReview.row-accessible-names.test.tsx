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

let host: HTMLDivElement;
let root: Root;
const body = '<img src=x onerror="alert(1)">';

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
  ["en", ["Accept", "Reject", "Edit"]],
  ["ru", ["Принять", "Отклонить", "Править"]],
  ["ru-RU", ["Принять", "Отклонить", "Править"]],
])("locale %s", (language, labels) => {
  it("gives each row distinct action names and rejects only the selected suggestion", async () => {
    mocks.language = language;
    let resolveQueue!: (value: unknown) => void;
    mocks.get.mockReturnValue(new Promise((resolve) => { resolveQueue = resolve; }));
    mocks.post.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><KnowledgeReview /></QueryClientProvider>); });
    await act(async () => {
      resolveQueue({ suggestions: [
        { id: "s1", body: "First", targetItemId: "i1", rationale: "" },
        { id: "s2", body, targetItemId: "i2", rationale: "" },
      ] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(async () => { await act(async () => {}); expect(host.querySelectorAll("button")).toHaveLength(6); });
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons).toHaveLength(6);
    expect(host.textContent).toContain(body);
    expect(host.querySelector("img")).toBeNull();
    for (const label of labels) {
      const matching = buttons.filter((button) => button.textContent === label);
      expect(matching).toHaveLength(2);
      expect(matching.map((button) => button.getAttribute("aria-label"))).toEqual([`${label} s1`, `${label} s2`]);
    }
    const reject = buttons.find((button) => button.getAttribute("aria-label") === `${labels[1]} s2`);
    expect(reject).toBeDefined();
    await act(async () => { reject?.click(); });
    expect(mocks.post.mock.calls).toEqual([["/myrmidon/companies/c1/knowledge/suggestions/s2/decline", {}]]);
  });
});
