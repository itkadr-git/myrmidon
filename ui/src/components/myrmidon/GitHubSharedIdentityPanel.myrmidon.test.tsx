// @vitest-environment jsdom
//
// myrmidon(GITHUB-SHARED-IDENTITY): the self-hosted GitHub App identities
// panel of the company settings — entries per App (id, key secret,
// installation, repositories, roles, agents, token permissions), the dirty
// gate on Save, the PUT body it sends and the vendor connector state line.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubSharedIdentityView } from "./githubSharedIdentityApi";
import {
  DEFAULT_APP_DESCRIPTION,
  GitHubSharedIdentityPanel,
  GitHubSharedIdentityPanelView,
  bodyFromDraft,
  readManifestCallbackNotice,
  submitManifestForm,
} from "./GitHubSharedIdentityPanel";
import { DEFAULT_GITHUB_APP_PERMISSIONS } from "./githubSharedIdentityApi";

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
        permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS },
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

/** Async-safe button lookup: poll until the control appears. The container
 * renders after several data queries resolve, and CI runners are slow enough
 * that a fixed number of ticks is not reliable. */
async function waitForButton(text: string, attempts = 50): Promise<HTMLButtonElement> {
  for (let i = 0; i < attempts; i++) {
    const found = [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
    if (found) return found as HTMLButtonElement;
    // A macrotask, not a microtask: react-query delivers a resolved query to
    // the component through a setTimeout(0) batch, so microtask ticks alone
    // never let the data (and the buttons that depend on it) arrive.
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error(`button not found: ${text}`);
}

function byLabel<T extends HTMLElement>(label: string): T {
  return container.querySelector(`[aria-label="${label}"]`) as T;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

// myrmidon(GITHUB-APP-MANIFEST): container mocks. vi.mock calls are hoisted
// by vitest, so they apply to the whole module; they only affect the
// container describe below — the view describes render the view component
// directly and never touch the api client or the company context.
const apiMocks = vi.hoisted(() => ({
  beginAppManifest: vi.fn(),
  getAppInstallUrl: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./githubSharedIdentityApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./githubSharedIdentityApi")>();
  return {
    ...original,
    githubSharedIdentityApi: {
      get: apiMocks.get,
      save: apiMocks.save,
      beginAppManifest: apiMocks.beginAppManifest,
      getAppInstallUrl: apiMocks.getAppInstallUrl,
    },
  };
});
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-a", selectedCompany: { name: "Company A" } }),
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("@/api/secrets", () => ({ secretsApi: { list: vi.fn(async () => []) } }));
// The tests run outside the app bootstrap, so i18n.init has not run; make
// t() return the key's EN text from the fork catalog.
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      let node: unknown = enCatalog;
      for (const part of key.split(".")) node = (node as Record<string, unknown>)?.[part];
      return typeof node === "string" ? node : key;
    },
  }),
}));
import enCatalog from "@/i18n/myrmidon-locales/en.json";

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
          permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS },
        },
      ],
    });
  });

  it("widens the permission list of an entry: workflows write, pulls the token defaults down", () => {
    const onSave = render();
    const workflowSelect = byLabel<HTMLSelectElement>("Permissions of App A: workflows");
    expect(workflowSelect.value).toBe("none");
    // GitHub's token API has no `workflows: read` — only none/write are offered.
    expect([...workflowSelect.querySelectorAll("option")].map((option) => option.value)).toEqual(["none", "write"]);
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(workflowSelect, "write");
      workflowSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => {
      const issuesSelect = byLabel<HTMLSelectElement>("Permissions of App A: issues");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(issuesSelect, "read");
      issuesSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => {
      const prSelect = byLabel<HTMLSelectElement>("Permissions of App A: pull_requests");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(prSelect, "none");
      prSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => button("Save GitHub access").click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].apps[0]!.permissions).toEqual({
      ...DEFAULT_GITHUB_APP_PERMISSIONS,
      workflows: "write",
      issues: "read",
      pull_requests: "none",
    });
  });

  it("builds the body from a draft: trims, empties to null, splits lists, copies permissions", () => {
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
            permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS, workflows: "write" },
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
          permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS, workflows: "write" },
        },
      ],
    });
  });
});

// myrmidon(GITHUB-APP-MANIFEST): the manifest-flow UI — the create dialog,
// the form POST to github.com, the install redirect and the callback query
// parsing. The server contract is mocked: begin returns
// { manifestUrl, manifest }, install returns { installUrl }.
describe("GitHubSharedIdentityPanelView — manifest flow", () => {
  function renderWithManifest(props: {
    onBeginAppManifest?: (body: import("./githubSharedIdentityApi").BeginAppManifestBody) => void;
    onInstallApp?: (entryId: string) => void;
    manifestError?: string | null;
    companyName?: string | null;
    value?: GitHubSharedIdentityView | null;
  }) {
    const onSave = vi.fn();
    flushSync(() => {
      root.render(
        <GitHubSharedIdentityPanelView
          view={props.value === undefined ? view : props.value}
          agents={agents}
          secrets={[]}
          onSave={onSave}
          pending={false}
          error={null}
          newId={() => ENTRY_B}
          onBeginAppManifest={props.onBeginAppManifest}
          manifestError={props.manifestError ?? null}
          onInstallApp={props.onInstallApp}
          companyName={props.companyName ?? null}
        />,
      );
    });
    return onSave;
  }

  it("the create button opens the dialog with the default name and description", () => {
    const onBeginAppManifest = vi.fn();
    renderWithManifest({ onBeginAppManifest, companyName: "Company A" });
    flushSync(() => button("Create GitHub App").click());
    const dialog = container.querySelector("[data-testid='github-app-manifest-dialog']")!;
    expect(dialog).toBeTruthy();
    expect(byLabel<HTMLInputElement>("App name").value).toBe("Myrmidon — Company A");
    expect(byLabel<HTMLTextAreaElement>("Description (shown on GitHub)").value).toBe(DEFAULT_APP_DESCRIPTION);
    // The RU rendering of the default description sits next to the field.
    expect(dialog.textContent).toContain("Позволяет агентам вашего сервера");
  });

  it("submit sends the begin call for a personal account app", () => {
    const onBeginAppManifest = vi.fn();
    renderWithManifest({ onBeginAppManifest });
    flushSync(() => button("Create GitHub App").click());
    flushSync(() => setValue(byLabel<HTMLInputElement>("App name"), "My App"));
    flushSync(() => button("Create on GitHub").click());
    expect(onBeginAppManifest).toHaveBeenCalledWith({
      ownerKind: "user",
      name: "My App",
      description: DEFAULT_APP_DESCRIPTION,
    });
  });

  it("submit sends the begin call for an organization app", () => {
    const onBeginAppManifest = vi.fn();
    renderWithManifest({ onBeginAppManifest });
    flushSync(() => button("Create GitHub App").click());
    const orgRadio = byLabel<HTMLInputElement>("An organization");
    flushSync(() => orgRadio.click());
    flushSync(() => setValue(byLabel<HTMLInputElement>("Organization login"), " org-a "));
    flushSync(() => button("Create on GitHub").click());
    expect(onBeginAppManifest).toHaveBeenCalledWith({
      ownerKind: "org",
      orgLogin: "org-a",
      name: "Myrmidon",
      description: DEFAULT_APP_DESCRIPTION,
    });
  });

  it("shows the manifest error with the unique-name hint", () => {
    renderWithManifest({ onBeginAppManifest: vi.fn(), manifestError: "manifest flow failed" });
    const errorBox = container.querySelector("[data-testid='github-app-manifest-error']")!;
    expect(errorBox.textContent).toContain("manifest flow failed");
    expect(errorBox.textContent).toContain("unique App name");
  });

  it("the install button appears only for entries with a slug and asks for the install url", () => {
    const onInstallApp = vi.fn();
    const withSlug: GitHubSharedIdentityView = {
      ...view,
      settings: {
        ...view.settings,
        apps: [{ ...view.settings.apps[0], slug: "my-app" }],
      },
    };
    renderWithManifest({ onBeginAppManifest: vi.fn(), onInstallApp, value: withSlug });
    const installButton = button("Install on repositories");
    expect(installButton).toBeTruthy();
    flushSync(() => installButton.click());
    expect(onInstallApp).toHaveBeenCalledWith(ENTRY_A);
    // Entries without a slug (manual path) get no install button.
    renderWithManifest({ onBeginAppManifest: vi.fn(), onInstallApp });
    expect(container.querySelector("[data-testid='github-app-0']")!.textContent).not.toContain("Install on repositories");
  });

  it("the manual add path is untouched by the manifest flow", () => {
    const onBeginAppManifest = vi.fn();
    const onSave = renderWithManifest({ onBeginAppManifest });
    flushSync(() => button("Add GitHub App").click());
    flushSync(() => setValue(byLabel<HTMLInputElement>("Name of App 2"), "App B"));
    flushSync(() => setValue(byLabel<HTMLInputElement>("App id of App B"), "202"));
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
          agentIds: [],
          allowedRepos: [],
          permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS },
        },
      ],
    });
  });
});

describe("manifest flow helpers", () => {
  it("readManifestCallbackNotice parses created, error and none", () => {
    expect(readManifestCallbackNotice("?github_app_created=1")).toEqual({ kind: "created" });
    expect(readManifestCallbackNotice("?github_app_error=name%20taken")).toEqual({ kind: "error", message: "name taken" });
    expect(readManifestCallbackNotice("?other=1")).toBeNull();
    expect(readManifestCallbackNotice("")).toBeNull();
  });

  it("submitManifestForm posts the manifest and the state to the manifest url", () => {
    let submitted: HTMLFormElement | null = null;
    const submitSpy = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(function (this: HTMLFormElement) {
        submitted = this;
      });
    try {
      const manifest = { name: "my-app", public: false };
      submitManifestForm("https://github.com/settings/apps/new", manifest, "state-abc");
      expect(submitSpy).toHaveBeenCalledTimes(1);
      const form = submitted as unknown as HTMLFormElement | null;
      expect(form).not.toBeNull();
      expect(form!.method.toLowerCase()).toBe("post");
      expect(form!.action).toBe("https://github.com/settings/apps/new");
      const input = form!.querySelector("input[name='manifest']") as HTMLInputElement;
      expect(input.type).toBe("hidden");
      expect(JSON.parse(input.value)).toEqual(manifest);
      const stateInput = form!.querySelector("input[name='state']") as HTMLInputElement;
      expect(stateInput.type).toBe("hidden");
      expect(stateInput.value).toBe("state-abc");
      form!.remove();
    } finally {
      submitSpy.mockRestore();
    }
  });
});

// myrmidon(GITHUB-APP-MANIFEST): the container reads the server callback
// outcome from the page query string once, invalidates the list on success,
// shows the error with the unique-name hint on failure and cleans the URL.
describe("GitHubSharedIdentityPanel — server callback", () => {

  let queryClient: QueryClient | null = null;
  let invalidateSpy: ReturnType<typeof vi.spyOn> | null = null;

  async function renderContainer(search: string) {
    window.history.replaceState(null, "", `/settings${search}`);
    // New QueryClient per test (and per render): the view caches per companyId
    // and the callback notice state lives in the component instance.
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = queryClient;
    invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(GitHubSharedIdentityPanel))),
    );
    // Flush the three data queries (identity, agents, secrets) before the
    // caller interacts: poll for the panel instead of guessing tick counts.
    for (let i = 0; i < 50 && !container.querySelector("[data-testid='myrmidon-github-shared-identity'] input"); i++) {
      await act(async () => Promise.resolve());
    }
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
    apiMocks.get.mockReset();
    apiMocks.beginAppManifest.mockReset();
    apiMocks.getAppInstallUrl.mockReset();
    apiMocks.get.mockResolvedValue({ settings: { version: 1, enabled: true, apps: [], commitEmailDomain: null }, vendorConnectorEnabled: false });
    apiMocks.beginAppManifest.mockResolvedValue({
      manifestUrl: "https://github.com/settings/apps/new",
      manifest: { name: "my-app" },
      state: "state-from-begin",
    });
    apiMocks.getAppInstallUrl.mockResolvedValue({ installUrl: "https://github.com/apps/my-app/installations/new" });
  });

  afterEach(() => {
    invalidateSpy?.mockRestore();
    queryClient = null;
    invalidateSpy = null;
  });

  it("?github_app_created=1 invalidates the list, shows the success notice and cleans the URL", async () => {
    await renderContainer("?github_app_created=1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["myrmidon", "github-shared-identity", "company-a"] });
    expect(container.querySelector("[data-testid='github-app-created-notice']")?.textContent).toContain("was created");
    expect(window.location.search).toBe("");
  });

  it("?github_app_error=... shows the error with the unique-name hint and cleans the URL", async () => {
    await renderContainer("?github_app_error=name%20already%20taken");
    await act(async () => Promise.resolve());
    const errorBox = container.querySelector("[data-testid='github-app-manifest-error']");
    expect(errorBox?.textContent).toContain("name already taken");
    expect(errorBox?.textContent).toContain("unique App name");
    expect(window.location.search).toBe("");
  });

  it("submitting the dialog posts the manifest form to the manifest url", async () => {
    await renderContainer("");
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    try {
      await act(async () => (await waitForButton("Create GitHub App")).click());
      await act(async () => (await waitForButton("Create on GitHub")).click());
      expect(apiMocks.beginAppManifest).toHaveBeenCalledWith("company-a", {
        ownerKind: "user",
        name: "Myrmidon — Company A",
        description: DEFAULT_APP_DESCRIPTION,
      });
      await act(async () => Promise.resolve());
      expect(submitSpy).toHaveBeenCalledTimes(1);
      const form = [...document.querySelectorAll("form")].find((f) => f.action === "https://github.com/settings/apps/new");
      expect(form).toBeTruthy();
      expect(JSON.parse((form!.querySelector("input[name='manifest']") as HTMLInputElement).value)).toEqual({ name: "my-app" });
      expect((form!.querySelector("input[name='state']") as HTMLInputElement).value).toBe("state-from-begin");
      form!.remove();
    } finally {
      submitSpy.mockRestore();
    }
  });

  it("the install button redirects to the install url", async () => {
    apiMocks.get.mockResolvedValue({
      settings: {
        version: 1,
        enabled: true,
        apps: [
          {
            id: ENTRY_A,
            name: "App A",
            appId: "101",
            privateKeySecretId: KEY_A,
            installationId: null,
            roles: [],
            agentIds: [],
            allowedRepos: [],
            permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS },
            slug: "my-app",
          },
        ],
        commitEmailDomain: null,
      },
      vendorConnectorEnabled: false,
    });
    await renderContainer("");
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });
    try {
      await act(async () => (await waitForButton("Install on repositories")).click());
      expect(apiMocks.getAppInstallUrl).toHaveBeenCalledWith("company-a", ENTRY_A);
      await act(async () => Promise.resolve());
      expect(assignSpy).toHaveBeenCalledWith("https://github.com/apps/my-app/installations/new");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });
});
