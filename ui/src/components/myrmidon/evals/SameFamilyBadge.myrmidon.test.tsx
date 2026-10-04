// @vitest-environment jsdom
// myrmidon(OPE-4150 EVALS-JUDGE-FAMILY): the same-family judge badge on an
// eval result — view tier, no network. Checked: the badge renders with its
// label and tooltip hint when sameFamily is true; a false flag renders
// nothing at all.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SameFamilyBadge } from "./SameFamilyBadge";

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

function badge(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid=same-family-badge]");
}

describe("myrmidon(OPE-4150 EVALS-JUDGE-FAMILY) SameFamilyBadge", () => {
  it("renders the badge with label and tooltip when sameFamily is true", () => {
    act(() => root.render(<SameFamilyBadge sameFamily={true} />));
    expect(badge()).not.toBeNull();
    expect(badge()?.textContent).toContain("Same-family judge");
    expect(badge()?.getAttribute("title")).toContain("same family");
  });

  it("renders nothing when sameFamily is false", () => {
    act(() => root.render(<SameFamilyBadge sameFamily={false} />));
    expect(badge()).toBeNull();
    expect(container.textContent).toBe("");
  });
});
