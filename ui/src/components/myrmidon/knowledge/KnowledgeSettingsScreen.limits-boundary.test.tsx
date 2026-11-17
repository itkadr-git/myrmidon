// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_MAX_ITEMS_MIN, KNOWLEDGE_MAX_ITEMS_MAX,
  KNOWLEDGE_MAX_REVISION_BYTES_MIN, KNOWLEDGE_MAX_REVISION_BYTES_MAX,
  type KnowledgeSettingsView,
} from "@myrmidon/shared";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const fetchMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock("./knowledgeSettingsApi", () => ({
  fetchKnowledgeSettings: (...args: unknown[]) => fetchMock(...args),
  patchKnowledgeSettings: (...args: unknown[]) => patchMock(...args),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const view: KnowledgeSettingsView = {
  maxItems: { value: 5000, source: "default" },
  maxRevisionBytes: { value: 262144, source: "default" },
  autoAcceptEnabled: { value: false, source: "default" },
  autoAcceptMinConfidence: { value: "0.9", source: "default" },
  schedule: { value: "0 0 0 0 0", source: "default" },
  sectionReviewers: { value: [], source: "default" },
};
const limits = [
  { field: "maxItems", id: "knowledge-max-items", min: KNOWLEDGE_MAX_ITEMS_MIN, max: KNOWLEDGE_MAX_ITEMS_MAX },
  { field: "maxRevisionBytes", id: "knowledge-max-bytes", min: KNOWLEDGE_MAX_REVISION_BYTES_MIN, max: KNOWLEDGE_MAX_REVISION_BYTES_MAX },
] as const;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Knowledge settings limit boundaries", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(async () => {
    fetchMock.mockReset().mockResolvedValue(view);
    patchMock.mockReset().mockResolvedValue(view);
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    root = createRoot(container);
    flushSync(() => root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>));
    for (let i = 0; i < 6; i++) await settle();
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });

  for (const limit of limits) {
    for (const value of [limit.min, limit.max]) {
      it(`saves ${limit.field} at ${value} without changing the other limit`, async () => {
        const input = container.querySelector<HTMLInputElement>(`[data-testid="${limit.id}"]`)!;
        const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
        flushSync(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(input.value).toBe(String(value));
        expect(save.disabled).toBe(false);
        flushSync(() => save.click());
        for (let i = 0; i < 4; i++) await settle();
        expect(patchMock).toHaveBeenCalledTimes(1);
        expect(patchMock).toHaveBeenCalledWith("company-1", { [limit.field]: String(value) });
      });
    }
    for (const value of [String(limit.min - 1), String(limit.max + 1), `${limit.min}.5`, "not-a-number"]) {
      it(`rejects ${limit.field} value ${value} and saves after correction`, async () => {
        const input = container.querySelector<HTMLInputElement>(`[data-testid="${limit.id}"]`)!;
        const save = container.querySelector<HTMLButtonElement>('[data-testid="knowledge-settings-save"]')!;
        const change = (next: string) => flushSync(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        change(value);
        expect(input.value).toBe(value);
        expect(container.querySelector('[role="alert"]')?.textContent).toBe("knowledgeSettings.invalidNumber");
        expect(save.disabled).toBe(true);
        save.click();
        expect(patchMock).not.toHaveBeenCalled();
        change(String(limit.min));
        expect(input.value).toBe(String(limit.min));
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(save.disabled).toBe(false);
        flushSync(() => save.click());
        for (let i = 0; i < 4; i++) await settle();
        expect(patchMock).toHaveBeenCalledTimes(1);
        expect(patchMock).toHaveBeenCalledWith("company-1", { [limit.field]: String(limit.min) });
      });
    }
  }
});
