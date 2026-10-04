// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotLspSettingsPanelView, botLspDraftFrom, parseBotLspDraft, type BotLspDraft } from "./BotLspSettingsPanel";
import type { BotLspView } from "./botLspApi";

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
  act(() => root.unmount());
  container.remove();
});

const VIEW: BotLspView = {
  settings: {},
  effective: {
    codingRoles: ["engineer", "qa", "devops", "reviewer", "release"],
    codingMode: "limited",
    nonCodingMode: "off",
    idleTimeoutSeconds: 120,
    tsserverMemoryMb: 1024,
    excludeRoots: [],
  },
  agents: [],
  counts: { off: 3, limited: 2, full: 0 },
};

const EMPTY: BotLspDraft = botLspDraftFrom({});

function renderView(view: BotLspView = VIEW) {
  const onSave = vi.fn();
  act(() => {
    root.render(<BotLspSettingsPanelView view={view} onSave={onSave} pending={false} error={null} />);
  });
  return onSave;
}

function setInput(id: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(`#bot-lsp-${id}`)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(id: string, value: string) {
  const el = container.querySelector<HTMLSelectElement>(`#bot-lsp-${id}`)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function save() {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Save language servers"))!;
  act(() => button.click());
}

describe("myrmidon(BOT-LSP-DEFAULTS) parseBotLspDraft", () => {
  it("sends every field, empty ones as null (back to the default)", () => {
    expect(parseBotLspDraft(EMPTY)).toEqual({
      patch: {
        codingRoles: null,
        codingMode: null,
        nonCodingMode: null,
        idleTimeoutSeconds: null,
        tsserverMemoryMb: null,
        excludeRoots: null,
      },
      errors: {},
    });
  });

  it("splits roles on commas and spaces and roots on lines", () => {
    const { patch } = parseBotLspDraft({
      ...EMPTY,
      codingRoles: "engineer, dev-lead  engineer",
      excludeRoots: "/srv/big\n\n/srv/other\n",
      idleTimeoutSeconds: "300",
      tsserverMemoryMb: "2048",
      codingMode: "full",
    });
    expect(patch).toMatchObject({
      codingRoles: ["engineer", "dev-lead"],
      excludeRoots: ["/srv/big", "/srv/other"],
      idleTimeoutSeconds: 300,
      tsserverMemoryMb: 2048,
      codingMode: "full",
    });
  });

  it("rejects a bad role key and out-of-range numbers", () => {
    const parsed = parseBotLspDraft({ ...EMPTY, codingRoles: "eng!neer", idleTimeoutSeconds: "5", tsserverMemoryMb: "1.5" });
    expect(parsed.patch).toBeNull();
    expect(Object.keys(parsed.errors).sort()).toEqual(["codingRoles", "idleTimeoutSeconds", "tsserverMemoryMb"]);
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) settings panel", () => {
  it("shows the defaults as placeholders and the bot counts", () => {
    renderView();
    expect(container.querySelector<HTMLInputElement>("#bot-lsp-idleTimeoutSeconds")?.placeholder).toBe("120");
    expect(container.querySelector("[data-testid=bot-lsp-counts]")?.textContent).toContain("2 limited, 3 off, 0 full");
  });

  it("saves the edited policy", () => {
    const onSave = renderView();
    setInput("codingRoles", "engineer, dev-lead");
    setSelect("nonCodingMode", "limited");
    save();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ codingRoles: ["engineer", "dev-lead"], nonCodingMode: "limited", idleTimeoutSeconds: null }),
    );
  });

  it("blocks saving while a field is invalid", () => {
    const onSave = renderView();
    setInput("tsserverMemoryMb", "10");
    expect(container.querySelector("[data-testid=bot-lsp-error-tsserverMemoryMb]")).not.toBeNull();
    save();
    expect(onSave).not.toHaveBeenCalled();
  });
});
