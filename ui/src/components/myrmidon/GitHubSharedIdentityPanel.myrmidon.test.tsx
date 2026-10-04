// @vitest-environment jsdom
//
// myrmidon(GITHUB-SHARED-IDENTITY): the shared GitHub authorization panel of
// the company settings — per-connection rules (repositories, roles, agents),
// the dirty gate on Save and the PUT body it sends.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubSharedIdentityView } from "./githubSharedIdentityApi";
import { GitHubSharedIdentityPanelView, bodyFromDraft } from "./GitHubSharedIdentityPanel";

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

const CONNECTION_A = "11111111-1111-4111-8111-111111111111";
const CONNECTION_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";

const view: GitHubSharedIdentityView = {
  settings: {
    version: 1,
    enabled: true,
    connections: [{ connectionId: CONNECTION_A, roles: ["engineer"], agentIds: [], allowedRepos: ["owner-a/*"] }],
    commitEmailDomain: null,
  },
  connections: [
    {
      id: CONNECTION_A,
      name: "GitHub (product A)",
      enabled: true,
      status: "active",
      installedForCompany: true,
      grant: { status: "active", login: "account-a", repositoryCount: 3, repositorySelection: "selected" },
    },
    {
      id: CONNECTION_B,
      name: "GitHub (product B)",
      enabled: true,
      status: "active",
      installedForCompany: true,
      grant: { status: "active", login: "account-b", repositoryCount: 1, repositorySelection: "selected" },
    },
  ],
};

const agents = [{ id: AGENT_A, name: "Agent A", role: "engineer" as const }];

function render(onSave = vi.fn(), value: GitHubSharedIdentityView | null = view) {
  flushSync(() => {
    root.render(<GitHubSharedIdentityPanelView view={value} agents={agents} onSave={onSave} pending={false} error={null} />);
  });
  return onSave;
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Save GitHub access"))!;
}

function byLabel<T extends HTMLElement>(label: string): T {
  return container.querySelector(`[aria-label="${label}"]`) as T;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GitHubSharedIdentityPanelView", () => {
  it("shows each shared connection with its account and the stored rule", () => {
    render();
    expect(container.textContent).toContain("GitHub (product A)");
    expect(container.textContent).toContain("as account-a");
    expect(byLabel<HTMLInputElement>("Allow agents to use GitHub (product A)").checked).toBe(true);
    expect(byLabel<HTMLInputElement>("Allow agents to use GitHub (product B)").checked).toBe(false);
    expect(byLabel<HTMLTextAreaElement>("Allowed repositories for GitHub (product A)").value).toBe("owner-a/*");
    expect(saveButton().disabled).toBe(true);
  });

  it("saves a second connection's rule for another product", () => {
    const onSave = render();
    flushSync(() => byLabel<HTMLInputElement>("Allow agents to use GitHub (product B)").click());
    flushSync(() => setValue(byLabel<HTMLTextAreaElement>("Allowed repositories for GitHub (product B)"), "owner-b/*\nowner-b/app-b"));
    flushSync(() => byLabel<HTMLInputElement>("Agent A may use GitHub (product B)").click());
    expect(saveButton().disabled).toBe(false);
    flushSync(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      commitEmailDomain: null,
      connections: [
        { connectionId: CONNECTION_A, roles: ["engineer"], agentIds: [], allowedRepos: ["owner-a/*"] },
        { connectionId: CONNECTION_B, roles: [], agentIds: [AGENT_A], allowedRepos: ["owner-b/*", "owner-b/app-b"] },
      ],
    });
  });

  it("drops a connection's rule when it is switched off, and explains an empty list", () => {
    expect(
      bodyFromDraft({
        enabled: false,
        commitEmailDomain: " example.com ",
        rules: { [CONNECTION_A]: { enabled: false, roles: "engineer", agentIds: [], allowedRepos: "owner-a/*" } },
      }),
    ).toEqual({ enabled: false, commitEmailDomain: "example.com", connections: [] });

    render(vi.fn(), { ...view, connections: [] });
    expect(container.querySelector("[data-testid='github-shared-no-connections']")).toBeTruthy();
  });
});
