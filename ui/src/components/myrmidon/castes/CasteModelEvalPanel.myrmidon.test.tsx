// @vitest-environment jsdom
// myrmidon(1.8 CASTE-MODEL-EVAL OPE-12948): view-tier tests for the model
// comparison panel — pure props in, markup out, no network.
//
// Checked: the model → score table renders with free/disabled badges and the
// best free enabled model marked; empty results render the empty state and no
// table; decline sends nothing and hides the decision row; confirm calls
// onConfirm with the suggested model and the "current" column then shows the
// value the API reported.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasteModelEvalView } from "./CasteModelEvalPanel";
import { bestFreeEnabledModel, sortEvalResults } from "./casteModelEval";
import type { CasteModelEvalResultView } from "./castesApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string, params?: Record<string, string>) =>
    params && "model" in params ? `${key}:${params.model}` : key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

function result(overrides: Partial<CasteModelEvalResultView> = {}): CasteModelEvalResultView {
  return {
    model: "qwen-plus",
    score: 82,
    free: true,
    enabled: true,
    ...overrides,
  };
}

const RESULTS: CasteModelEvalResultView[] = [
  result({ model: "qwen-plus", score: 82, free: true, enabled: true }),
  result({ model: "deepseek-chat", score: 78, free: true, enabled: true }),
  result({ model: "gpt-4o", score: 90, free: false, enabled: true }),
  result({ model: "qwen-turbo", score: 40, free: true, enabled: false }),
];

const KEY = "engineer";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

interface RenderOptions {
  results?: readonly CasteModelEvalResultView[];
  suggestedModel?: string | null;
  currentModel?: string | null;
  confirming?: boolean;
  onConfirm?: (model: string) => void;
  onDecline?: () => void;
}

function render({
  results = RESULTS,
  suggestedModel = null,
  currentModel = null,
  confirming = false,
  onConfirm = vi.fn(),
  onDecline = vi.fn(),
}: RenderOptions = {}) {
  const handlers = {
    onConfirm: onConfirm as (model: string) => void,
    onDecline: onDecline as () => void,
  };
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <CasteModelEvalView
        casteKey={KEY}
        results={results}
        suggestedModel={suggestedModel}
        currentModel={currentModel}
        confirming={confirming}
        onConfirm={handlers.onConfirm}
        onDecline={handlers.onDecline}
      />,
    );
  });
  return handlers;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    container.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("myrmidon(1.8 CASTE-MODEL-EVAL OPE-12948) view tier", () => {
  it("renders the model → score table and marks the best free enabled model", async () => {
    render({ suggestedModel: "qwen-plus", currentModel: "deepseek-chat" });
    await flushReact();

    const table = container.querySelector(
      `[data-testid="myrmidon-castes-model-eval-table-${KEY}"]`,
    );
    expect(table).not.toBeNull();
    // One row per compared model
    for (const model of ["qwen-plus", "deepseek-chat", "gpt-4o", "qwen-turbo"]) {
      expect(
        container.querySelector(`[data-testid="myrmidon-castes-model-eval-row-${KEY}-${model}"]`),
      ).not.toBeNull();
      expect(
        container.querySelector(`[data-testid="myrmidon-castes-model-eval-score-${KEY}-${model}"]`)
          ?.textContent,
      ).toBe(String(RESULTS.find((row) => row.model === model)?.score));
    }
    // Best free enabled marked; the higher-scoring paid model is not
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-best-${KEY}-qwen-plus"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-best-${KEY}-gpt-4o"]`),
    ).toBeNull();
    // free / disabled badges
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-free-${KEY}-gpt-4o"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-disabled-${KEY}-qwen-turbo"]`),
    ).not.toBeNull();
    // current model column from the API-reported value
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-current-${KEY}-deepseek-chat"]`),
    ).not.toBeNull();
    // decision row offers the explicit confirm with the suggested model
    const confirm = container.querySelector<HTMLButtonElement>(
      `[data-testid="myrmidon-castes-model-eval-confirm-${KEY}"]`,
    );
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("castes.modelEval.confirm:qwen-plus");
  });

  it("the server-suggested model wins over the local derivation", async () => {
    // A server may rank differently on tie-breaks; when it names a row, the
    // UI must not re-rank over it (the ranking belongs to the server).
    render({ results: RESULTS, suggestedModel: "deepseek-chat", currentModel: null });
    await flushReact();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-best-${KEY}-deepseek-chat"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-best-${KEY}-qwen-plus"]`),
    ).toBeNull();
  });

  it("empty results render the empty state and no table", async () => {
    render({ results: [], suggestedModel: null });
    await flushReact();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-empty-${KEY}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-table-${KEY}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-confirm-${KEY}"]`),
    ).toBeNull();
  });

  it("decline sends nothing and the caste model is not changed", async () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    render({ suggestedModel: "qwen-plus", currentModel: "deepseek-chat", onConfirm, onDecline });
    await flushReact();

    await click(`[data-testid="myrmidon-castes-model-eval-decline-${KEY}"]`);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDecline).toHaveBeenCalledTimes(1);
    // The decision row is gone after declining (local dismissal)
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-decide-${KEY}"]`),
    ).toBeNull();
    // The current-model column still shows the old value
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-current-${KEY}-deepseek-chat"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="myrmidon-castes-model-eval-current-${KEY}-qwen-plus"]`),
    ).toBeNull();
  });

  it("confirm calls onConfirm with the suggested model and the display then shows the API-reported model", async () => {
    let displayedModel: string | null = "deepseek-chat";
    const onConfirm = vi.fn((model: string) => {
      // The parent mirrors the real container: the displayed default model
      // comes from the PATCH response, synchronously in this fake.
      displayedModel = model;
    });
    render({
      suggestedModel: "qwen-plus",
      currentModel: displayedModel,
      onConfirm,
    });
    await flushReact();

    await click(`[data-testid="myrmidon-castes-model-eval-confirm-${KEY}"]`);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("qwen-plus");
  });

  it("confirming disables the confirm button while the PATCH is in flight", async () => {
    render({ suggestedModel: "qwen-plus", confirming: true });
    await flushReact();
    const confirm = container.querySelector<HTMLButtonElement>(
      `[data-testid="myrmidon-castes-model-eval-confirm-${KEY}"]`,
    );
    expect(confirm?.disabled).toBe(true);
  });
});

describe("myrmidon(1.8 CASTE-MODEL-EVAL OPE-12948) highlight logic", () => {
  it("bestFreeEnabledModel derives the fallback when the server omits the suggestion", () => {
    // max score among free+enabled, alphabetical tie-break
    expect(bestFreeEnabledModel(RESULTS, null)).toBe("qwen-plus");
    expect(
      bestFreeEnabledModel(
        [
          result({ model: "b-model", score: 80 }),
          result({ model: "a-model", score: 80 }),
        ],
        null,
      ),
    ).toBe("a-model");
    // paid and disabled rows never win
    expect(
      bestFreeEnabledModel([result({ model: "paid", score: 99, free: false })], null),
    ).toBeNull();
    expect(
      bestFreeEnabledModel([result({ model: "off", score: 99, enabled: false })], null),
    ).toBeNull();
    // an unknown suggestion falls back to the derivation
    expect(bestFreeEnabledModel(RESULTS, "not-in-list")).toBe("qwen-plus");
  });

  it("sortEvalResults puts the best model first, then score desc, then name", () => {
    const best = "qwen-plus";
    const sorted = sortEvalResults(
      [
        result({ model: "gpt-4o", score: 90, free: false }),
        result({ model: "qwen-turbo", score: 40, enabled: false }),
        result({ model: "deepseek-chat", score: 78 }),
        result({ model: "qwen-plus", score: 82 }),
      ],
      best,
    );
    expect(sorted.map((row) => row.model)).toEqual([
      "qwen-plus",
      "gpt-4o",
      "deepseek-chat",
      "qwen-turbo",
    ]);
  });
});
