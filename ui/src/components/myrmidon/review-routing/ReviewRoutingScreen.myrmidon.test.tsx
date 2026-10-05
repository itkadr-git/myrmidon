// @vitest-environment jsdom
// myrmidon(REVIEW-ROUTING): the review routing settings screen — pure helpers
// and the view tier, no network.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRoutingScreenView } from "./ReviewRoutingScreen";
import type { ReviewRoutingSettings } from "./reviewRoutingApi";
import { draftFromSettings, parseBoundedInt, parseRoles, settingsFromDraft } from "./reviewRoutingConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

const SETTINGS: ReviewRoutingSettings = {
  enabled: true,
  reviewerRoles: ["reviewer", "qa"],
  maxLoadPerReviewer: 5,
  reassignAfterHours: 24,
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

function setInput(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("reviewRoutingConfig", () => {
  it("parses roles from a comma or space separated list without duplicates", () => {
    expect(parseRoles("reviewer, qa  qa,,lead")).toEqual(["reviewer", "qa", "lead"]);
    expect(parseRoles("   ")).toEqual([]);
  });

  it("bounds integers", () => {
    expect(parseBoundedInt("5", 1, 100)).toEqual({ ok: true, value: 5 });
    expect(parseBoundedInt("0", 1, 100).ok).toBe(false);
    expect(parseBoundedInt("101", 1, 100).ok).toBe(false);
    expect(parseBoundedInt("2.5", 0, 100).ok).toBe(false);
    expect(parseBoundedInt("", 0, 100).ok).toBe(false);
  });

  it("round-trips a draft and rejects an invalid one", () => {
    expect(settingsFromDraft(draftFromSettings(SETTINGS))).toEqual(SETTINGS);
    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), maxLoad: "x" })).toBeNull();
  });
});

describe("ReviewRoutingScreenView", () => {
  it("shows the loading state until the settings arrive", () => {
    act(() => root.render(<ReviewRoutingScreenView settings={undefined} onSave={vi.fn()} pending={false} error={null} />));
    expect(container.querySelector('[data-testid="myrmidon-review-routing-loading"]')).not.toBeNull();
  });

  it("saves the edited values", () => {
    const onSave = vi.fn();
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={onSave} pending={false} error={null} />));
    setInput("review-routing-roles", "qa, lead");
    setInput("review-routing-max-load", "3");
    setInput("review-routing-hours", "0");
    act(() => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      reviewerRoles: ["qa", "lead"],
      maxLoadPerReviewer: 3,
      reassignAfterHours: 0,
    });
  });

  it("blocks saving an invalid number and shows the message", () => {
    const onSave = vi.fn();
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={onSave} pending={false} error={null} />));
    setInput("review-routing-max-load", "0");
    expect(container.querySelector('[data-testid="review-routing-max-load-error"]')).not.toBeNull();
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a server error", () => {
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={vi.fn()} pending={false} error="boom" />));
    expect(container.querySelector('[data-testid="myrmidon-review-routing-error"]')?.textContent).toBe("boom");
  });
});
