// @vitest-environment jsdom
//
// myrmidon(GITHUB-SHARED-IDENTITY): the self-hosted GitHub App identities
// panel of the company settings — entries per App (id, key secret,
// installation, repositories, roles, agents), the dirty gate on Save, the
// PUT body it sends and the vendor connector state line.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubSharedIdentityView } from "./githubSharedIdentityApi";
import { GitHubSharedIdentityPanelView, bodyFromDraft } from "./GitHubSharedIdentityPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The secret picker (a searchable select) measures itself.
if (!globalThis.ResizeObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

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

const ENTRY_A = "11111111-1111-4111-8111-111111111111";
const ENTRY_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const KEY_A = "44444444-4444-4444-8444-444444444444";

const view: GitHubSharedIdentityView = {
  settings: {
    version: 1,
    enabled: true,
    apps: [
      {
        id: ENTRY_A,
        name: "App A",
        appId: "101",
        privateKeySecretId: KEY_A,
        installationId: "5001",
        roles: ["engineer"],
        agentIds: [],
        allowedRepos: ["owner-a/*"],
      },
    ],
    commitEmailDomain: null,
  },
  vendorConnectorEnabled: false,
};

const agents = [{ id: AGENT_A, name: "Agent A", role: "engineer" as const }];

function render(onSave = vi.fn(), value: GitHubSharedIdentityView | null = view) {
  flushSync(() => {
    root.render(
      <GitHubSharedIdentityPanelView
        view={value}
        agents={agents}
        secrets={[]}
        onSave={onSave}
        pending={false}
        error={null}
        newId={() => ENTRY_B}
      />,
    );
  });
  return onSave;
}

function button(text: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text))!;
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
  it("shows the stored App entry and the vendor connector state", () => {
    render();
    expect(byLabel<HTMLInputElement>("App id of App A").value).toBe("101");
    expect(byLabel<HTMLInputElement>("Installation id of App A").value).toBe("5001");
    expect(byLabel<HTMLTextAreaElement>("Allowed repositories of App A").value).toBe("owner-a/*");
    expect(container.querySelector("[data-testid='github-vendor-connector-state']")?.textContent).toContain("disabled");
    expect(button("Save GitHub access").disabled).toBe(true);
  });

  it("adds a second App for another product and saves both", () => {
    const onSave = render();
    flushSync(() => button("Add GitHub App").click());
    flushSync(() => setValue(byLabel<HTMLInputElement>("Name of App 2"), "App B"));
    flushSync(() => setValue(byLabel<HTMLInputElement>("App id of App B"), "202"));
    flushSync(() => setValue(byLabel<HTMLTextAreaElement>("Allowed repositories of App B"), "owner-b/*\nowner-b/app-b"));
    flushSync(() => byLabel<HTMLInputElement>("Agent A may use App B").click());
    expect(button("Save GitHub access").disabled).toBe(false);
    flushSync(() => button("Save GitHub access").click());
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      commitEmailDomain: null,
      apps: [
        view.settings.apps[0],
        {
          id: ENTRY_B,
          name: "App B",
          appId: "202",
          privateKeySecretId: "",
          installationId: null,
          roles: [],
          agentIds: [AGENT_A],
          allowedRepos: ["owner-b/*", "owner-b/app-b"],
        },
      ],
    });
  });

  it("builds the body from a draft: trims, empties to null, splits lists", () => {
    expect(
      bodyFromDraft({
        enabled: false,
        commitEmailDomain: " example.com ",
        apps: [
          {
            id: ENTRY_A,
            name: " App A ",
            appId: " 101 ",
            privateKeySecretId: KEY_A,
            installationId: " ",
            roles: "engineer, reviewer",
            agentIds: [],
            allowedRepos: "owner-a/repo-a, owner-a/repo-b",
          },
        ],
      }),
    ).toEqual({
      enabled: false,
      commitEmailDomain: "example.com",
      apps: [
        {
          id: ENTRY_A,
          name: "App A",
          appId: "101",
          privateKeySecretId: KEY_A,
          installationId: null,
          roles: ["engineer", "reviewer"],
          agentIds: [],
          allowedRepos: ["owner-a/repo-a", "owner-a/repo-b"],
        },
      ],
    });
  });
});
