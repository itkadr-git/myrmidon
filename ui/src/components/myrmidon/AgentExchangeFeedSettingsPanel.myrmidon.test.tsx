// @vitest-environment jsdom
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the feed section of Instance → General —
// the two switches, the source line of each value, and the save gate.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAgentExchangeFeedSettings } from "@paperclipai/shared";
import { AgentExchangeFeedSettingsPanelView } from "./AgentExchangeFeedSettingsPanel";

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

const view: ResolvedAgentExchangeFeedSettings = {
  settings: { feedLimit: 50, skillCandidateEnabled: true },
  sources: { feedLimit: "settings", skillCandidateEnabled: "env" },
};

function render(value: ResolvedAgentExchangeFeedSettings | null, onSave = vi.fn(), pending = false) {
  flushSync(() => {
    root.render(
      <AgentExchangeFeedSettingsPanelView view={value} onSave={onSave} pending={pending} error={null} />,
    );
  });
  return onSave;
}

describe("AgentExchangeFeedSettingsPanelView", () => {
  it("shows both fields with the source of each value", () => {
    render(view);
    const text = container.textContent ?? "";
    expect(text).toContain("Agent exchange feed");
    expect(text).toContain("Rooms per page");
    expect(text).toContain("Source: Saved here");
    expect(text).toContain("Source: Forced by the server environment");
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input?.value).toBe("50");
  });

  it("saves the draft when a value changes", () => {
    const onSave = render(view);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-exchange-feed-skill-candidate"] [role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    flushSync(() => toggle!.click());
    expect(container.textContent).toContain("Unsaved changes");
    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Save"),
    );
    expect(button).toBeDefined();
    flushSync(() => button!.click());
    expect(onSave).toHaveBeenCalledWith({ feedLimit: 50, skillCandidateEnabled: false });
  });

  it("reports a pending save and an empty view", () => {
    render(view, vi.fn(), true);
    expect(container.textContent).toContain("Saving...");
    render(null);
    expect(container.textContent).toContain("Loading the feed settings...");
  });
});