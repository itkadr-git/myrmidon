// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardGitHubIdentitiesFields,
  readGitHubIdentities,
} from "./AgentCardGitHubIdentitiesFields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITIES = [
  { owner: "example-org", login: "example-bot", secretName: "example-org-github-token" },
  { owner: "acme-inc", login: "acme-bot", secretName: "acme-inc-github-token" },
];

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

/** The section as the card mounts it: `adapterConfig.githubIdentities`. */
function render(value: unknown) {
  act(() => {
    root.render(
      <TooltipProvider>
        <AgentCardGitHubIdentitiesFields value={value} />
      </TooltipProvider>,
    );
  });
}

function texts(testId: string) {
  return [...container.querySelectorAll(`[data-testid="${testId}"]`)].map((el) => (el.textContent ?? "").trim());
}

function buttons() {
  return [...container.querySelectorAll("button")];
}

describe("myrmidon(GITHUB-IDENTITIES-C) card section", () => {
  it("shows every account with its owner scope, login and secret", () => {
    render(IDENTITIES);

    expect(texts("myrmidon-agent-github-identity")).toHaveLength(2);
    expect(texts("myrmidon-agent-github-identity-owner")).toEqual(["example-org/*", "acme-inc/*"]);
    expect(texts("myrmidon-agent-github-identity-login")).toEqual(["Login: example-bot", "Login: acme-bot"]);
    expect(texts("myrmidon-agent-github-identity-secret")).toEqual([
      "Secret: example-org-github-token",
      "Secret: acme-inc-github-token",
    ]);
    expect(texts("myrmidon-agent-github-identity-problem")).toEqual([]);
    expect(container.querySelector('[data-testid="myrmidon-agent-github-identities-empty"]')).toBeNull();
  });

  it("reads the stored field and nothing else", () => {
    expect(readGitHubIdentities(undefined)).toEqual({ identities: [], problems: [] });
    expect(readGitHubIdentities(null)).toEqual({ identities: [], problems: [] });
    expect(readGitHubIdentities([])).toEqual({ identities: [], problems: [] });
    expect(readGitHubIdentities("example-org")).toEqual({
      identities: [],
      problems: ["The card's GitHub identities are not a list."],
    });
    expect(readGitHubIdentities({ owner: "example-org" }).identities).toEqual([]);
    expect(readGitHubIdentities([{ owner: "example-org", secretName: "token" }]).identities).toEqual([
      { owner: "example-org", login: null, secretName: "token" },
    ]);
    // A value the card stores with padding is shown as the container will read it.
    expect(readGitHubIdentities([{ owner: " example-org ", login: " example-bot ", secretName: " token " }])).toEqual({
      identities: [{ owner: "example-org", login: "example-bot", secretName: "token" }],
      problems: [],
    });
    // An empty string is not an owner and not a secret name.
    expect(readGitHubIdentities([{ owner: "  ", secretName: "token" }]).identities).toEqual([]);
  });

  it("says a login the card does not name instead of inventing one", () => {
    render([{ owner: "example-org", secretName: "example-org-github-token" }]);

    expect(texts("myrmidon-agent-github-identity-login")).toEqual(["Login: not reported"]);
    expect(texts("myrmidon-agent-github-identity-secret")).toEqual(["Secret: example-org-github-token"]);
  });
  it("reports an entry the container cannot use and keeps the usable ones", () => {
    render([IDENTITIES[0], { owner: "acme-inc" }, "nope"]);

    expect(texts("myrmidon-agent-github-identity")).toHaveLength(1);
    expect(texts("myrmidon-agent-github-identity-owner")).toEqual(["example-org/*"]);
    expect(texts("myrmidon-agent-github-identity-problem")).toEqual([
      "Entry 2 is incomplete: secretName missing.",
      "Entry 3 is not an object.",
    ]);

    render([{ login: "example-bot" }]);
    expect(texts("myrmidon-agent-github-identity-problem")).toEqual([
      "Entry 1 is incomplete: owner and secretName missing.",
    ]);
    expect(texts("myrmidon-agent-github-identity")).toHaveLength(0);
  });

  it("flags two entries claiming one owner, and still shows both", () => {
    render([IDENTITIES[0], { owner: "example-org", login: "example-bot-2", secretName: "other-token" }]);

    expect(texts("myrmidon-agent-github-identity")).toHaveLength(2);
    expect(texts("myrmidon-agent-github-identity-problem")).toEqual([
      "Two entries claim the same owner: example-org/*.",
    ]);
  });

  it("shows an empty list as an empty section, not as a problem", () => {
    render(undefined);

    expect(container.querySelector('[data-testid="myrmidon-agent-github-identities-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="myrmidon-agent-github-identities-list"]')).toBeNull();
    expect(texts("myrmidon-agent-github-identity-problem")).toEqual([]);

    render({ owner: "example-org" });
    expect(container.querySelector('[data-testid="myrmidon-agent-github-identities-empty"]')).toBeNull();
    expect(texts("myrmidon-agent-github-identity-problem")).toEqual([
      "The card's GitHub identities are not a list.",
    ]);
  });

  it("keeps the list read-only: no field to type a token, owner or secret into", () => {
    render(IDENTITIES);

    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    // The one control is the section header itself.
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].textContent).toContain("GitHub identities");
    expect(buttons()[0].getAttribute("aria-expanded")).toBe("true");

    act(() => buttons()[0].click());
    expect(buttons()[0].getAttribute("aria-expanded")).toBe("false");
    expect(texts("myrmidon-agent-github-identity")).toHaveLength(0);

    act(() => buttons()[0].click());
    expect(texts("myrmidon-agent-github-identity")).toHaveLength(2);
  });
});
