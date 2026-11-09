// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayFallbacksEditor } from "./GatewayFallbacksEditor";
import { litellmKeysApi, type GatewayFallbackModelInfo } from "./litellmKeysApi";
import { i18n } from "@/i18n";

vi.mock("./litellmKeysApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./litellmKeysApi")>()),
  litellmKeysApi: {
    updateFallbacks: vi.fn(),
  },
}));

describe("GatewayFallbacksEditor (myrmidon OPE-12361 i18n and pool fallbacks)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    void i18n.changeLanguage("ru");
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
    queryClient.clear();
    void i18n.changeLanguage("en");
  });

  function render(props: {
    chains?: Array<{ model: string; targets: string[] }>;
    knownModels?: GatewayFallbackModelInfo[];
  } = {}) {
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <GatewayFallbacksEditor
            companyId="comp-1"
            initialChains={props.chains ?? []}
            cycles={[]}
            knownModels={props.knownModels ?? []}
          />
        </QueryClientProvider>,
      );
    });
    flushSync(() => {});
  }

  it("renders editor buttons, headings, and placeholders in Russian when RU is active", () => {
    render({
      chains: [
        {
          model: "gpt-4o",
          targets: ["claude-3-5-sonnet"],
        },
      ],
      knownModels: [
        { modelName: "gpt-4o", provider: "openai", inputCostPerToken: null, outputCostPerToken: null, isFree: false },
        { modelName: "claude-3-5-sonnet", provider: "anthropic", inputCostPerToken: null, outputCostPerToken: null, isFree: false },
      ],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("Цепочка резервов:");
    expect(text).toContain("Сохранить изменения");
    expect(text).toContain("Добавить");
    expect(text).not.toContain("Save Changes");
    expect(text).not.toContain("Fallback Chain:");
    const input = container?.querySelector("input");
    expect(input?.placeholder).toBe("Добавить целевую модель/группу резервов...");
  });

  it("identifies kie-gpt-6-luna as Paid, not Free", () => {
    render({
      chains: [
        {
          model: "primary-model",
          targets: ["kie-gpt-6-luna"],
        },
      ],
      knownModels: [
        { modelName: "primary-model", provider: "openai", inputCostPerToken: null, outputCostPerToken: null, isFree: false },
        { modelName: "kie-gpt-6-luna", provider: "openai", inputCostPerToken: null, outputCostPerToken: null, isFree: false },
      ],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("kie-gpt-6-luna");
    expect(text).not.toContain("Free");
    expect(text).not.toContain("Бесплатно");
  });

  it("suppresses false single-provider warnings for pools with distinct provider types", () => {
    render({
      chains: [
        {
          model: "chatgpt-group",
          targets: ["antigravity-group"],
        },
      ],
      knownModels: [
        { modelName: "chatgpt-group", provider: "chatgpt-pool", inputCostPerToken: null, outputCostPerToken: null, isFree: true },
        { modelName: "antigravity-group", provider: "antigravity-pool", inputCostPerToken: null, outputCostPerToken: null, isFree: true },
      ],
    });

    const text = container?.textContent ?? "";
    expect(text).not.toContain("один и тот же провайдер");
    expect(text).not.toContain("single provider");
  });

  it("renders cycle detection warnings in Russian when topology contains a loop", () => {
    render({
      chains: [
        { model: "model-a", targets: ["model-b"] },
        { model: "model-b", targets: ["model-a"] },
      ],
      knownModels: [
        { modelName: "model-a", provider: "openai", inputCostPerToken: null, outputCostPerToken: null, isFree: false },
        { modelName: "model-b", provider: "anthropic", inputCostPerToken: null, outputCostPerToken: null, isFree: false },
      ],
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("В топологии обнаружен цикл");
    expect(text).not.toContain("Cycle detected");
  });
});
