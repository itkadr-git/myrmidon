// @vitest-environment jsdom
//
// myrmidon(1.7-DEBATE-ASYM-B): the "Debates per caste" section of the debate
// settings — the caste picker, the effective values with their sources, the
// switch, the guidance fields, the dirty gate on Save and the clear back to
// the instance configuration.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DebateSettings } from "@paperclipai/shared";
import { CasteDebateSettingsPanelView, buildCasteDebatePatch } from "./CasteDebateSettingsPanel";
import type { CasteDebateSettingsView, DebateCastePatch } from "./debateApi";

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

const castes = [
  { key: "marketing", label: "Marketing" },
  { key: "engineering", label: "Engineering" },
];

function view(overrides: Partial<CasteDebateSettingsView> = {}): CasteDebateSettingsView {
  return {
    casteKey: "marketing",
    enabled: true,
    enabledSource: "default",
    settings,
    source: "default",
    instanceSource: "default",
    overrides: [],
    prompts: {},
    problem: null,
    stored: null,
    summary: "caste marketing · on · generator=qwen-plus-free · enabled from default · config from default",
    gateway: { configured: true, problem: null },
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof CasteDebateSettingsPanelView>[0]> = {}) {
  const onSelect = vi.fn();
  const onSave = vi.fn();
  const onClear = vi.fn();
  flushSync(() => {
    root.render(
      <CasteDebateSettingsPanelView
        castes={castes}
        selectedKey="marketing"
        onSelect={onSelect}
        view={view()}
        loading={false}
        onSave={onSave}
        onClear={onClear}
        pending={false}
        error={null}
        {...props}
      />,
    );
  });
  return { onSelect, onSave, onClear };
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function setValue(element: HTMLElement, value: string) {
  flushSync(() => {
    // Inputs and textareas carry the value on different prototypes: using the
    // wrong setter throws an illegal invocation instead of typing.
    const proto =
      element instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("myrmidon(1.7-DEBATE-ASYM-B): the per-caste debate section", () => {
  it("renders the section, the caste picker and the effective values", () => {
    render();
    expect(byTestId("myrmidon-caste-debate-settings")).toBeTruthy();
    const select = byTestId("caste-debate-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "marketing", "engineering"]);
    expect((byTestId("caste-debate-model-generator") as HTMLInputElement).value).toBe("qwen-plus-free");
    expect((byTestId("caste-debate-rounds") as HTMLInputElement).value).toBe("3");
    expect((byTestId("caste-debate-ceiling") as HTMLInputElement).value).toBe("50000");
    expect(byTestId("caste-debate-enabled")?.getAttribute("aria-checked")).toBe("true");
  });

  it("reports where the switch and the configuration come from", () => {
    render({ view: view({ enabledSource: "caste", source: "caste", overrides: ["enabled", "rounds"] }) });
    expect(byTestId("caste-debate-enabled-source")?.textContent).toContain("Set for this caste");
    expect(byTestId("caste-debate-source")?.textContent).toContain("Set for this caste");
    expect(byTestId("caste-debate-summary")?.textContent).toContain("caste marketing");

    render();
    expect(byTestId("caste-debate-enabled-source")?.textContent).toContain("On by default");
    expect(byTestId("caste-debate-source")?.textContent).toContain("Inherited from the instance level");
  });

  it("tells the operator to pick a caste before anything is shown", () => {
    render({ selectedKey: null, view: null });
    expect(byTestId("caste-debate-empty")).toBeTruthy();
    expect(byTestId("caste-debate-form-marketing")).toBeNull();
  });

  it("selects a caste and saves the tuned values, guidance included", () => {
    const { onSelect, onSave } = render();
    const select = byTestId("caste-debate-select") as HTMLSelectElement;
    flushSync(() => {
      select.value = "engineering";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("engineering");

    setValue(byTestId("caste-debate-prompt-critic") as HTMLElement, "check the legal claims");
    setValue(byTestId("caste-debate-rounds") as HTMLElement, "2");
    const save = byTestId("caste-debate-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    flushSync(() => save.click());

    const patch = onSave.mock.calls[0][0] as DebateCastePatch;
    expect(patch.enabled).toBe(true);
    expect(patch.rounds).toBe(2);
    expect(patch.generator).toEqual({ model: "qwen-plus-free" });
    expect(patch.prompts).toEqual({ critic: "check the legal claims" });
  });

  it("keeps Save disabled until something changes, and refuses four rounds", () => {
    const { onSave } = render();
    const save = byTestId("caste-debate-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing edited yet
    setValue(byTestId("caste-debate-rounds") as HTMLElement, "4");
    const stillDisabled = byTestId("caste-debate-save") as HTMLButtonElement;
    expect(stillDisabled.disabled).toBe(true); // out of the owner's limit
    flushSync(() => stillDisabled.click());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers the clear only for a caste that has an entry of its own", () => {
    const cleared = render({ view: view({ stored: { enabled: false }, enabled: false }) });
    const clear = byTestId("caste-debate-clear") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    flushSync(() => clear.click());
    expect(cleared.onClear).toHaveBeenCalled();

    render();
    expect((byTestId("caste-debate-clear") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's refusal reason verbatim", () => {
    render({ error: "the judge shares the family \"qwen\" with a debater", view: view({ problem: null }) });
    expect(byTestId("caste-debate-save-error")?.textContent).toContain("shares the family");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): the PATCH body", () => {
  it("drops empty guidance and optional numbers but keeps the switch", () => {
    const patch = buildCasteDebatePatch({
      enabled: false,
      generator: " qwen-plus-free ",
      critic: "glm-4-flash-free",
      judge: "deepseek-chat-free",
      rounds: "",
      tokenCeiling: "",
      prompts: { generator: "  ", critic: "x", judge: "" },
    });
    expect(patch).toEqual({
      enabled: false,
      generator: { model: "qwen-plus-free" },
      critic: { model: "glm-4-flash-free" },
      judge: { model: "deepseek-chat-free" },
      prompts: { critic: "x" },
    });
  });

  it("returns null for an incomplete or out-of-range form", () => {
    const base = {
      enabled: true,
      generator: "a",
      critic: "b",
      judge: "c",
      rounds: "",
      tokenCeiling: "",
      prompts: { generator: "", critic: "", judge: "" },
    };
    expect(buildCasteDebatePatch({ ...base, judge: "" })).toBeNull();
    expect(buildCasteDebatePatch({ ...base, rounds: "0" })).toBeNull();
    expect(buildCasteDebatePatch({ ...base, rounds: "4" })).toBeNull();
    expect(buildCasteDebatePatch({ ...base, tokenCeiling: "10" })).toBeNull();
  });
});