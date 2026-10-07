// @vitest-environment jsdom
//
// myrmidon(1.7-DEBATE-ASYM-A): the Asymmetric debates section of
// Instance → General — the role model fields, the source line, the dirty gate
// on the Save button, and the refusal reason shown when the server reports a
// symmetric configuration.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DebateSettings } from "@paperclipai/shared";
import { DebateSettingsPanelView } from "./DebateSettingsPanel";
import type { DebateSettingsView } from "./debateApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const settings: DebateSettings = {
  generator: { model: "qwen-plus-free" },
  critic: { model: "glm-4-flash-free" },
  judge: { model: "deepseek-chat-free" },
  rounds: 3,
  tokenCeiling: 50000,
};

const view: DebateSettingsView = {
  settings,
  source: "settings",
  problem: null,
  gateway: { configured: true, problem: null },
};

function render(
  value: DebateSettingsView | null | undefined,
  onSave = vi.fn(),
  onClear = vi.fn(),
  pending = false,
  error: string | null = null,
) {
  flushSync(() => {
    root.render(
      <DebateSettingsPanelView
        view={value}
        onSave={onSave}
        onClear={onClear}
        pending={pending}
        error={error}
      />,
    );
  });
  return { onSave, onClear };
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save debate configuration"))!;
}

function field(id: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

function type(id: string, value: string) {
  const input = field(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DebateSettingsPanelView", () => {
  it("renders the role models, the numbers and the source line", () => {
    render(view);
    expect(field("debate-generator").value).toBe("qwen-plus-free");
    expect(field("debate-critic").value).toBe("glm-4-flash-free");
    expect(field("debate-judge").value).toBe("deepseek-chat-free");
    expect(field("debate-rounds").value).toBe("3");
    expect(container.querySelector("[data-testid='debate-source']")?.textContent).toBe("Saved here");
    // Nothing changed yet: Save stays disabled.
    expect(saveButton().disabled).toBe(true);
  });

  it("enables Save after a role model changes and saves the full edited config", () => {
    const { onSave } = render(view);
    type("debate-critic", "mistral-7b-free");
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    expect(onSave).toHaveBeenCalledWith({
      generator: { model: "qwen-plus-free" },
      critic: { model: "mistral-7b-free" },
      judge: { model: "deepseek-chat-free" },
      rounds: 3,
      tokenCeiling: 50000,
    });
  });

  it("keeps Save disabled while a required field is empty", () => {
    render(view);
    type("debate-generator", "");
    expect(saveButton().disabled).toBe(true);
  });

  it("shows the server refusal reason (symmetric config) in the panel", () => {
    render(
      { ...view, problem: 'generator and critic share the model family "qwen" — debates must be asymmetric (different families)' },
      vi.fn(),
      vi.fn(),
      false,
      'generator and critic share the model family "qwen" — debates must be asymmetric (different families)',
    );
    expect(container.querySelector("[data-testid='debate-save-error']")?.textContent).toContain("asymmetric");
  });

  it("warns when the gateway contour is not configured", () => {
    render({ ...view, gateway: { configured: false, problem: "set MYRMIDON_DEBATE_BASE_URL" } });
    expect(container.querySelector("[data-testid='debate-gateway-problem']")?.textContent).toContain("MYRMIDON_DEBATE_BASE_URL");
  });

  it("the clear button is enabled only when a row is stored", () => {
    const { onClear } = render(view);
    const clear = [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Clear to default"))!;
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(onClear).toHaveBeenCalled();

    const other = render({ ...view, settings: null, source: "default" });
    const clear2 = [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Clear to default"))!;
    expect(clear2.disabled).toBe(true);
    void other;
  });
});
