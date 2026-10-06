// @vitest-environment jsdom
// myrmidon(REVIEW-ROUTING): the review routing settings screen — pure helpers
// and the view tier, no network.
//
// myrmidon(REVIEW-ROUTING PR-events UI): prWatch guard tests — the section
// renders and round-trips when the server carries the block, is hidden and
// never PUT when the loaded settings omit it (the server schema is .strict()),
// an invalid repository entry is rejected client-side, and the steward fields
// follow steward.enabled.
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
  supportsPrWatch,
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

const BASE_WITHOUT_PR_WATCH: ReviewRoutingSettings = {
  enabled: true,
  reviewerRoles: ["reviewer"],
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

  it("validates owner/repo repository entries with the server's pattern", () => {
    // Mirrors GITHUB_REPOSITORY_PATTERN ([A-Za-z0-9_.-]+ halves): the client
    // must not accept an entry the server schema then rejects.
    expect(repositoriesValid("company-a/repo-a\ncompany-b/repo-b")).toBe(true);
    expect(repositoriesValid("org.name/repo_name.git")).toBe(true);
    expect(repositoriesValid("")).toBe(true);
    expect(repositoriesValid("repo-a")).toBe(false);
    expect(repositoriesValid("company-a/")).toBe(false);
    expect(repositoriesValid("company a/repo")).toBe(false);
    expect(repositoriesValid("company-a/repo-a/ref-head")).toBe(false);
    expect(repositoriesValid("owner/repo@sha")).toBe(false);
    expect(repositoriesValid("owner/repo#1")).toBe(false);
  });

  it("round-trips a draft and rejects an invalid one", () => {
    expect(settingsFromDraft(draftFromSettings(SETTINGS), SETTINGS)).toEqual(SETTINGS);
    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), maxLoad: "x" }, SETTINGS)).toBeNull();
    expect(
      settingsFromDraft({ ...draftFromSettings(SETTINGS), prRepositories: "not-a-repo" }, SETTINGS),
    ).toBeNull();
  });

  it("omits prWatch from the saved object when the loaded base has no block", () => {
    // The server schema is .strict(): PUTting prWatch to an older server without the PR lane
    // would 400 the whole save. The draft still carries the display defaults.
    expect(supportsPrWatch(SETTINGS)).toBe(true);
    expect(supportsPrWatch(BASE_WITHOUT_PR_WATCH)).toBe(false);
    expect(supportsPrWatch(null)).toBe(false);
    const draft = draftFromSettings(BASE_WITHOUT_PR_WATCH);
    expect(draft.prPollIntervalSec).toBe(String(defaultPrWatchSettings().pollIntervalSec));
    const saved = settingsFromDraft({ ...draft, maxLoad: "7" }, BASE_WITHOUT_PR_WATCH);
    expect(saved).not.toBeNull();
    expect(saved!.prWatch).toBeUndefined();
    expect("prWatch" in saved!).toBe(false);
    expect(saved).toEqual({ ...BASE_WITHOUT_PR_WATCH, maxLoadPerReviewer: 7 });
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

  it("hides the prWatch section when the server omits the block", () => {
    // An older server without the PR lane: .strict() would reject a prWatch key, so the screen
    // shows nothing of the lane and its save must not carry the key.
    const onSave = vi.fn();
    act(() =>
      root.render(<ReviewRoutingScreenView settings={BASE_WITHOUT_PR_WATCH} onSave={onSave} pending={false} error={null} />),
    );
    expect(container.querySelector('[data-testid="review-routing-pr-watch"]')).toBeNull();
    const button = clickSave();
    expect(button.disabled).toBe(false);
    expect(onSave).toHaveBeenCalledWith(BASE_WITHOUT_PR_WATCH);
    expect("prWatch" in onSave.mock.calls[0]![0]).toBe(false);
  });

  it("renders prWatch inputs with the values the server sent", () => {
    act(() => root.render(<ReviewRoutingScreenView settings={SETTINGS} onSave={vi.fn()} pending={false} error={null} />));
    const prWatch = SETTINGS.prWatch!;
    const value = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!.value;
    expect(container.querySelector('[data-testid="review-routing-pr-watch"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#review-routing-pr-watch-enabled")!.checked).toBe(
      prWatch.enabled,
    );
    expect(value("review-routing-pr-repositories")).toBe(prWatch.repositories.join("\n"));
    expect(value("review-routing-pr-max-open")).toBe(String(prWatch.maxOpenReviewsPerReviewer));
    expect(value("review-routing-pr-max-new")).toBe(String(prWatch.maxNewAssignmentsPerPass));
    expect(value("review-routing-pr-poll-interval")).toBe(String(prWatch.pollIntervalSec));
    expect(container.querySelector<HTMLInputElement>("#review-routing-steward-enabled")!.checked).toBe(
      prWatch.steward.enabled,
    );
    expect(value("review-routing-steward-roles")).toBe(prWatch.steward.roles.join(", "));
    expect(value("review-routing-steward-max-merges")).toBe(String(prWatch.steward.maxMergesPerSteward));
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
