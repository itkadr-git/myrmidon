// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { KnowledgeSettingsView } from "@myrmidon/shared";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const fetchMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initial: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};
const reviewer = { section: "runbooks-edited", reviewerKind: "agent" as const, reviewerId: "agent-2" };
const saved: KnowledgeSettingsView = { ...initial, sectionReviewers: { value: [reviewer], source: "ui" } };
const cleared: KnowledgeSettingsView = { ...initial, sectionReviewers: { value: [], source: "ui" } };

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
let client: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  container?.remove();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function click(element: Element) {
  act(() => { flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); });
}
function input(element: HTMLInputElement, value: string) {
  act(() => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }));
}

it("preserves the remaining reviewer through edits and sends an empty list when cleared", async () => {
  fetchMock.mockResolvedValue(initial);
  patchMock.mockResolvedValueOnce(saved).mockResolvedValueOnce(cleared);
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  root = createRoot(container);
  act(() => root!.render(<QueryClientProvider client={client!}><KnowledgeSettingsScreen /></QueryClientProvider>));
  await settle();

  const button = (text: string) => Array.from(container!.querySelectorAll("button")).find((item) => item.textContent === text)!;
  const fields = (testId: string) => Array.from(container!.querySelectorAll<HTMLInputElement>(`[data-testid="${testId}"]`));
  click(button("knowledgeSettings.addReviewer"));
  input(fields("knowledge-reviewer-section")[0]!, "first-section");
  input(fields("knowledge-reviewer-id")[0]!, "user-1");
  click(button("knowledgeSettings.addReviewer"));
  input(fields("knowledge-reviewer-section")[1]!, "runbooks");
  input(fields("knowledge-reviewer-id")[1]!, "user-2");
  input(fields("knowledge-reviewer-section")[1]!, "runbooks-edited");
  input(fields("knowledge-reviewer-id")[1]!, "agent-2");
  click(button("knowledgeSettings.removeReviewer"));

  expect(fields("knowledge-reviewer-section").map((field) => field.value)).toEqual(["runbooks-edited"]);
  expect(fields("knowledge-reviewer-id").map((field) => field.value)).toEqual(["agent-2"]);
  const kind = container.querySelector<HTMLSelectElement>('[data-testid="knowledge-reviewer-kind"]')!;
  expect(kind.value).toBe("user");
  act(() => { kind.value = "agent"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(kind.value).toBe("agent");
  expect(fields("knowledge-reviewer-section")[0]!.value).toBe("runbooks-edited");
  expect(fields("knowledge-reviewer-id")[0]!.value).toBe("agent-2");
  const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
  expect(save.disabled).toBe(false);
  click(save);
  await settle();
  expect(patchMock).toHaveBeenCalledTimes(1);
  expect(patchMock).toHaveBeenNthCalledWith(1, "company-1", { sectionReviewers: [reviewer] });
  expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
  expect(fields("knowledge-reviewer-section")[0]!.value).toBe("runbooks-edited");
  expect(fields("knowledge-reviewer-id")[0]!.value).toBe("agent-2");
  expect(container.querySelector<HTMLSelectElement>('[data-testid="knowledge-reviewer-kind"]')!.value).toBe("agent");

  click(button("knowledgeSettings.removeReviewer"));
  expect(fields("knowledge-reviewer-section")).toHaveLength(0);
  expect(save.disabled).toBe(false);
  click(save);
  await settle();
  expect(patchMock).toHaveBeenCalledTimes(2);
  expect(patchMock).toHaveBeenNthCalledWith(2, "company-1", { sectionReviewers: [] });
  expect(container.querySelector('[data-testid="knowledge-settings-saved"]')).not.toBeNull();
});
