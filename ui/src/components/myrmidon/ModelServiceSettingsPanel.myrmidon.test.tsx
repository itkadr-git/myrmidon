// @vitest-environment jsdom
//
// myrmidon(1.7 SETTINGS-TO-UI D): the "Service models & limits" panel —
// sources shown, an environment-pinned key read-only and out of the patch,
// the draft parse, and an empty aux model saved as an empty string.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_SERVICE_FIELDS,
  ModelServiceSettingsPanelView,
  parseModelServiceField,
} from "./ModelServiceSettingsPanel";
import type { ModelServiceSettingsView } from "./modelServiceSettingsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW: ModelServiceSettingsView = {
  settings: {
    litellmCostIntervalSec: 300,
    botAuxTitleModel: null,
    botModelContextLengths: { "model-a": 8000 },
    ocrBackend: "ragflow",
    evalsLangfuseExport: false,
    ctoChatTimeoutSec: 90,
  },
  sources: { litellmCostIntervalSec: "default", ctoChatTimeoutSec: "env", botAuxTitleModel: "default" },
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(onSave = vi.fn()) {
  act(() => {
    root.render(<ModelServiceSettingsPanelView view={VIEW} onSave={onSave} pending={false} error={null} saved={false} />);
  });
  return onSave;
}
const input = (key: string) => container.querySelector<HTMLInputElement>(`#model-service-${key}`)!;
function setText(key: string, value: string) {
  const el = input(key);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const save = () =>
  act(() => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Save model settings"))!.click());
const field = (key: string) => MODEL_SERVICE_FIELDS.find((f) => f.key === key)!;

describe("parseModelServiceField", () => {
  it("parses whole numbers, maps, backends and keeps empty text", () => {
    expect(parseModelServiceField(field("ocrMaxPages"), "12")).toEqual({ value: 12 });
    expect("error" in parseModelServiceField(field("ocrMaxPages"), "1.5")).toBe(true);
    expect(parseModelServiceField(field("botModelContextLengths"), "a=1000, b=2000")).toEqual({
      value: { a: 1000, b: 2000 },
    });
    expect("error" in parseModelServiceField(field("botModelContextLengths"), "a")).toBe(true);
    expect("error" in parseModelServiceField(field("ocrBackend"), "other")).toBe(true);
    expect(parseModelServiceField(field("botAuxTitleModel"), "")).toEqual({ value: "" });
  });
});

describe("ModelServiceSettingsPanelView", () => {
  it("shows values and sources, pins env keys read-only and saves only changes", () => {
    const onSave = render();
    expect(input("litellmCostIntervalSec").value).toBe("300");
    expect(input("botModelContextLengths").value).toBe("model-a=8000");
    expect(container.querySelector("[data-testid='model-service-source-ctoChatTimeoutSec']")!.textContent).toBe(
      "Environment override",
    );
    expect(input("ctoChatTimeoutSec").disabled).toBe(true);
    setText("litellmCostIntervalSec", "600");
    save();
    expect(onSave).toHaveBeenCalledWith({ litellmCostIntervalSec: 600 });
  });

  it("blocks saving on an invalid value", () => {
    const onSave = render();
    setText("ocrMaxPages", "abc");
    expect(container.querySelector("[data-testid='model-service-error-ocrMaxPages']")).not.toBeNull();
    save();
    expect(onSave).not.toHaveBeenCalled();
  });
});
