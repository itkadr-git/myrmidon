// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeSettingsScreen } from "./KnowledgeSettingsScreen";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./knowledgeSettingsApi", () => ({ fetchKnowledgeSettings: fetchMock, patchKnowledgeSettings: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => ({
  "knowledgeSettings.invalidNumber": "Enter a valid number",
  "knowledgeSettings.invalidConfidence": "Enter a valid confidence",
  "knowledgeSettings.invalidSchedule": "Enter a valid schedule",
} as Record<string, string>)[key] ?? key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const fields = [
  { id: "knowledge-max-items", invalid: "999999999999", valid: "5000", message: "Enter a valid number" },
  { id: "knowledge-max-bytes", invalid: "-1", valid: "262144", message: "Enter a valid number" },
  { id: "knowledge-confidence", invalid: "2", valid: "0.9", message: "Enter a valid confidence" },
  { id: "knowledge-schedule", invalid: "not a cron", valid: "0 0 0 0 0", message: "Enter a valid schedule" },
];

describe("knowledge settings validation accessibility", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;
  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    fetchMock.mockResolvedValue({
      maxItems: { value: 5000, source: "default" },
      maxRevisionBytes: { value: 262144, source: "default" },
      autoAcceptEnabled: { value: false, source: "default" },
      autoAcceptMinConfidence: { value: "0.9", source: "default" },
      schedule: { value: "0 0 0 0 0", source: "default" },
      sectionReviewers: { value: [], source: "default" },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><KnowledgeSettingsScreen /></QueryClientProvider>);
    });
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });
  it.each(fields)("links and clears the error for $id", async ({ id, invalid, valid, message }) => {
    const input = container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
    expect(input).not.toBeNull();
    const change = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await change(invalid);
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const error = document.getElementById(describedBy!);
    expect(error?.textContent).toBe(message);
    expect(error?.getAttribute("role")).toBe("alert");
    for (const other of fields.filter((field) => field.id !== id)) {
      const neighbor = container.querySelector(`[data-testid="${other.id}"]`);
      expect(neighbor?.getAttribute("aria-invalid")).not.toBe("true");
      expect(neighbor?.getAttribute("aria-describedby")).toBeNull();
    }
    await change(valid);
    expect(input?.getAttribute("aria-invalid")).not.toBe("true");
    expect(input?.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById(describedBy!)).toBeNull();
  });
});
