// @vitest-environment jsdom
// myrmidon(REVIEW-ROUTING): the review routing settings screen — pure helpers
// and the view tier, no network.
//
// myrmidon(REVIEW-ROUTING PR-events UI): prWatch guard tests — defaults render,
// the full-object round-trip preserves unrelated keys, an invalid repository
// entry is rejected client-side, and the steward fields follow steward.enabled.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRoutingScreenView } from "./ReviewRoutingScreen";
import type { ReviewRoutingSettings } from "./reviewRoutingApi";
import {
  defaultPrWatchSettings,
  draftFromSettings,
  parseBoundedInt,
  parseRoles,
  repositoriesValid,
  settingsFromDraft,
} from "./reviewRoutingConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

const SETTINGS: ReviewRoutingSettings = {
  enabled: true,
  reviewerRoles: ["reviewer", "qa"],
  maxLoadPerReviewer: 5,
  reassignAfterHours: 24,
  prWatch: {
    enabled: true,
    repositories: ["company-a/repo-a"],
    maxOpenReviewsPerReviewer: 3,
    maxNewAssignmentsPerPass: 5,
    pollIntervalSec: 60,
    steward: { enabled: true, roles: ["devops"], maxMergesPerSteward: 3 },
  },
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
  const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickSave() {
  const button = container.querySelector("button")!;
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return button;
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

  it("validates owner/repo repository entries", () => {
    expect(repositoriesValid("company-a/repo-a\ncompany-b/repo-b")).toBe(true);
    expect(repositoriesValid("")).toBe(true);
    expect(repositoriesValid("repo-a")).toBe(false);
    expect(repositoriesValid("company-a/")).toBe(false);
    expect(repositoriesValid("company a/repo")).toBe(false);
    expect(repositoriesValid("company-a/repo-a/ref-head")).toBe(false);
  });

  it("round-trips a draft and rejects an invalid one", () => {
    expect(settingsFromDraft(draftFromSettings(SETTINGS), SETTINGS)).toEqual(SETTINGS);
    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), maxLoad: "x" }, SETTINGS)).toBeNull();
    expect(
      settingsFromDraft({ ...draftFromSettings(SETTINGS), prRepositories: "not-a-repo" }, SETTINGS),
    ).toBeNull();
  });

  it("keeps unknown top-level keys and prWatch fields byte-identically on the round-trip", () => {
    // What the server may carry beyond the typed shape (a sibling feature's
    // key, or a field part A adds later) must survive the read-modify-write PUT.
    type LooseSettings = ReviewRoutingSettings & Record<string, unknown>;
    const server = {
      ...SETTINGS,
      futureServerOnlyField: { nested: [1, 2, 3] },
      prWatch: { ...SETTINGS.prWatch!, unknownSubField: "keep-me" },
    } as LooseSettings;
    const draft = draftFromSettings(server);
    draft.maxLoad = "7";
    const saved = settingsFromDraft(draft, server) as
      | (LooseSettings & { prWatch: ReviewRoutingSettings["prWatch"] & Record<string, unknown> })
      | null;
    expect(saved).not.toBeNull();
    expect(saved!.futureServerOnlyField).toEqual({ nested: [1, 2, 3] });
    expect(saved!.prWatch!.unknownSubField).toBe("keep-me");
    expect(saved!.maxLoadPerReviewer).toBe(7);
    expect(saved!.reviewerRoles).toEqual(SETTINGS.reviewerRoles);
    expect(saved!.enabled).toBe(SETTINGS.enabled);
  });
});

describe("ReviewRoutingScreenView", () => {
  it("shows the loading state until the settings arrive", () => {
    act(() => root.render(<ReviewRoutingScreenView settings={undefined} onSave={vi.fn()} pending={false} error={null} />));
    expect(container.querySelector('[data-testid="myrmidon-review-routing-loading"]')).not.toBeNull();
  });

  it("renders prWatch inputs with the schema defaults when the server omits the block", () => {
    const withoutPrWatch: ReviewRoutingSettings = {
      enabled: true,
      reviewerRoles: ["reviewer"],
      maxLoadPerReviewer: 5,
      reassignAfterHours: 24,
    };
    act(() => root.render(<ReviewRoutingScreenView settings={withoutPrWatch} onSave={vi.fn()} pending={false} error={null} />));
    const defaults = defaultPrWatchSettings();
    const value = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!.value;
    expect(container.querySelector<HTMLInputElement>("#review-routing-pr-watch-enabled")!.checked).toBe(
      defaults.enabled,
    );
    expect(value("review-routing-pr-repositories")).toBe("");
    expect(value("review-routing-pr-max-open")).toBe(String(defaults.maxOpenReviewsPerReviewer));
    expect(value("review-routing-pr-max-new")).toBe(String(defaults.maxNewAssignmentsPerPass));
    expect(value("review-routing-pr-poll-interval")).toBe(String(defaults.pollIntervalSec));
    expect(container.querySelector<HTMLInputElement>("#review-routing-steward-enabled")!.checked).toBe(
      defaults.steward.enabled,
    );
    expect(value("review-routing-steward-roles")).toBe(defaults.steward.roles.join(", "));
    expect(value("review-routing-steward-max-merges")).toBe(String(defaults.steward.maxMergesPerSteward));
  });

  it("saves the edited values", () => {
    const onSave = vi.fn();
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={onSave} pending={false} error={null} />));
    setInput("review-routing-roles", "qa, lead");
    setInput("review-routing-max-load", "3");
    setInput("review-routing-hours", "0");
    clickSave();
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      reviewerRoles: ["qa", "lead"],
      maxLoadPerReviewer: 3,
      reassignAfterHours: 0,
      prWatch: SETTINGS.prWatch,
    });
  });

  it("sends the full object with only the edited prWatch key changed", () => {
    const onSave = vi.fn();
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={onSave} pending={false} error={null} />));
    setInput("review-routing-pr-poll-interval", "120");
    clickSave();
    const saved = onSave.mock.calls[0]![0] as ReviewRoutingSettings;
    expect(saved).toEqual({
      ...SETTINGS,
      prWatch: { ...SETTINGS.prWatch!, pollIntervalSec: 120 },
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

  it("rejects an invalid repository entry client-side with the i18n'd message", () => {
    const onSave = vi.fn();
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={onSave} pending={false} error={null} />));
    setInput("review-routing-pr-repositories", "company-a/repo-a\nrepo-only");
    expect(container.querySelector('[data-testid="review-routing-pr-repositories-error"]')?.textContent).toBe(
      "reviewRouting.prRepositoriesInvalid",
    );
    const button = clickSave();
    expect(button.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("follows steward.enabled with the steward fieldset state", () => {
    const off: ReviewRoutingSettings = {
      ...SETTINGS,
      prWatch: { ...SETTINGS.prWatch!, steward: { ...SETTINGS.prWatch!.steward, enabled: false } },
    };
    act(() => root.render(<ReviewRoutingScreenView settings={off} onSave={vi.fn()} pending={false} error={null} />));
    const fieldset = container.querySelector<HTMLFieldSetElement>('[data-testid="review-routing-steward-fields"]')!;
    expect(container.querySelector<HTMLInputElement>("#review-routing-steward-enabled")!.checked).toBe(false);
    expect(fieldset.disabled).toBe(true);
    // the toggle is outside the fieldset: re-enabling stays clickable
    act(() => {
      container.querySelector<HTMLInputElement>("#review-routing-steward-enabled")!.click();
    });
    expect(
      container.querySelector<HTMLFieldSetElement>('[data-testid="review-routing-steward-fields"]')!.disabled,
    ).toBe(false);
  });

  it("shows a server error", () => {
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={vi.fn()} pending={false} error="boom" />));
    expect(container.querySelector('[data-testid="myrmidon-review-routing-error"]')?.textContent).toBe("boom");
  });
});
