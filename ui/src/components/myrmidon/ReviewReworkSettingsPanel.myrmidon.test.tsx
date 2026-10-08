// @vitest-environment jsdom
//
// myrmidon(REVIEW-REWORK): the "Review-return loop" section of Instance →
// General. The switch and the fallback executor must round-trip through the
// patch the panel builds, an empty fallback must mean "the role queue", and a
// non-UUID draft must refuse to save.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewReworkSettingsPanelView, parseReviewReworkDraft } from "./ReviewReworkSettingsPanel";
import type { ReviewReworkSettingsView } from "./reviewReworkSettingsApi";

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

const AGENT_UUID = "887ed69b-5982-4572-a151-f8c809543f29";

const view: ReviewReworkSettingsView = {
  settings: { enabled: true, fallbackAssigneeAgentId: AGENT_UUID },
  journal: [
    { at: "2026-10-05T07:00:00.000Z", actorType: "user", actorId: "user-1", patch: { enabled: true } },
  ],
};

function render(
  value: ReviewReworkSettingsView | null,
  onSave = vi.fn(),
  pending = false,
  error: string | null = null,
) {
  flushSync(() => {
    root.render(
      <ReviewReworkSettingsPanelView view={value} onSave={onSave} pending={pending} error={error} />,
    );
  });
  return onSave;
}

describe("parseReviewReworkDraft", () => {
  it("empty fallback means the role queue (null), not a validation error", () => {
    const { patch, errors } = parseReviewReworkDraft({ enabled: true, fallback: "" });
    expect(errors).toEqual({});
    expect(patch).toEqual({ enabled: true, fallbackAssigneeAgentId: null });
  });

  it("accepts a UUID and the word none", () => {
    expect(parseReviewReworkDraft({ enabled: false, fallback: AGENT_UUID }).patch.fallbackAssigneeAgentId)
      .toBe(AGENT_UUID);
    expect(parseReviewReworkDraft({ enabled: true, fallback: "NONE" }).patch.fallbackAssigneeAgentId)
      .toBeNull();
  });

  it("refuses anything that is not a UUID", () => {
    const { patch, errors } = parseReviewReworkDraft({ enabled: true, fallback: "adm-dev-lead" });
    expect(errors.fallback).toBeTruthy();
    expect(patch.fallbackAssigneeAgentId).toBeUndefined();
  });
});

describe("ReviewReworkSettingsPanelView", () => {
  it("renders the stored settings and the journal", () => {
    render(view);
    expect(container.querySelector("[data-testid='myrmidon-review-rework-settings']")).not.toBeNull();
    const toggle = container.querySelector("[data-testid='review-rework-enabled-toggle']") as HTMLElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((container.querySelector("#review-rework-fallback") as HTMLInputElement).value).toBe(AGENT_UUID);
    expect(container.textContent).toContain("2026-10-05T07:00:00.000Z");
  });

  it("saves the merged draft patch", () => {
    const onSave = render(view) as ReturnType<typeof vi.fn>;
    const input = container.querySelector("#review-rework-fallback") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => setter.call(input, ""));
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    const button = container.querySelector("[data-testid='review-rework-save']") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    flushSync(() => button.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual({ enabled: true, fallbackAssigneeAgentId: null });
  });

  it("disables save while the draft is malformed", () => {
    render(view);
    const input = container.querySelector("#review-rework-fallback") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => setter.call(input, "not-a-uuid"));
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    const button = container.querySelector("[data-testid='review-rework-save']") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("Enter an agent UUID");
  });
});
