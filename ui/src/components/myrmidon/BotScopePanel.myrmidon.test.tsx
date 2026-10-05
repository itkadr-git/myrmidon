// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { BotScopeOverview, BotScopeAgentView } from "./botScopeApi";
import * as apiModule from "./botScopeApi";
import { BotScopePanel } from "./BotScopePanel";

vi.mock("@/context/CompanyContext", () => ({ useOptionalCompany: () => ({ selectedCompanyId: "company-1" }) }));

const ISOLATED = { kind: "isolated" as const };

function agent(over: Partial<BotScopeAgentView> & { agentId: string; name: string }): BotScopeAgentView {
  return {
    role: "engineer",
    container: true,
    effective: { source: "default", scope: null, mode: "isolated", layout: ISOLATED },
    candidates: [],
    problems: [],
    pref: { isolate: false, groupId: null, projectId: null },
    applied: ISOLATED,
    restartRequired: false,
    ...over,
  };
}

const SHARED_CASTE = {
  source: "caste" as const,
  scope: { kind: "caste" as const, id: "engineer", mode: "shared" as const },
  mode: "shared" as const,
  layout: { kind: "shared" as const, dirName: "caste-company-1-engineer" },
};

function overview(over: Partial<BotScopeOverview> = {}): BotScopeOverview {
  return {
    companyId: "company-1",
    scopeRoot: "/srv/scopes",
    agents: [
      agent({ agentId: "a1", name: "alpha", effective: SHARED_CASTE, restartRequired: true }),
      agent({ agentId: "a2", name: "beta" }),
    ],
    groups: [{ id: "g1", name: "devs", memberIds: ["a1"], mode: "shared" }],
    instances: [
      { kind: "caste", id: "engineer", mode: "shared", dirName: "caste-company-1-engineer", memberIds: ["a1"] },
      { kind: "group", id: "g1", mode: "shared", dirName: "group-g1", memberIds: [] },
    ],
    ...over,
  };
}

function render(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <BotScopePanel />
    </QueryClientProvider>,
  );
  return container;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function byLabel<T extends HTMLElement>(root: HTMLElement, label: string): T {
  const found = root.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no element labelled ${label}`);
  return found;
}

describe("BotScopePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows where each agent's effective scope comes from and which restart is pending", async () => {
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(overview());
    const root = render();
    await waitFor(() => root.querySelectorAll('[data-testid="bot-scope-agent"]').length === 2);
    const [alpha, beta] = Array.from(root.querySelectorAll('[data-testid="bot-scope-agent"]'));
    expect(alpha!.querySelector('[data-testid="bot-scope-effective"]')!.textContent).toContain("Shared root");
    expect(alpha!.querySelector('[data-testid="bot-scope-effective"]')!.textContent).toContain("caste-company-1-engineer");
    expect(alpha!.querySelector('[data-testid="bot-scope-source"]')!.textContent).toContain("its caste");
    expect(alpha!.querySelector('[data-testid="bot-scope-restart-required"]')).not.toBeNull();
    expect(beta!.querySelector('[data-testid="bot-scope-effective"]')!.textContent).toContain("Isolated");
    expect(beta!.querySelector('[data-testid="bot-scope-source"]')!.textContent).toContain("default");
    expect(beta!.querySelector('[data-testid="bot-scope-restart-required"]')).toBeNull();
    // the instances list names its members and directory
    const instances = root.querySelector('[data-testid="bot-scope-instances"]')!.textContent!;
    expect(instances).toContain("engineer");
    expect(instances).toContain("1 member");
    expect(root.textContent).toContain("/srv/scopes");
  });

  it("changing an instance's mode saves it", async () => {
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(overview());
    const put = vi.spyOn(apiModule.botScopeApi, "putSetting").mockResolvedValue(overview());
    const root = render();
    await waitFor(() => root.querySelector('[aria-label="Mode of caste engineer"]') !== null);
    await act(async () => setSelect(byLabel(root, "Mode of caste engineer"), "isolated"));
    expect(put).toHaveBeenCalledWith("company-1", "caste", "engineer", "isolated");
  });

  it("applies one agent, or all pending ones", async () => {
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(overview());
    const apply = vi.spyOn(apiModule.botScopeApi, "apply").mockResolvedValue(agent({ agentId: "a1", name: "alpha" }));
    const applyAll = vi.spyOn(apiModule.botScopeApi, "applyAll").mockResolvedValue({ applied: ["a1"], skipped: [] });
    const root = render();
    await waitFor(() => root.querySelector('[data-testid="bot-scope-apply-all"]') !== null);
    const one = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Apply and restart")!;
    await act(async () => one.click());
    expect(apply).toHaveBeenCalledWith("company-1", "a1");
    await act(async () => (root.querySelector('[data-testid="bot-scope-apply-all"]') as HTMLButtonElement).click());
    expect(applyAll).toHaveBeenCalledWith("company-1");
  });

  it("flags a group conflict, blocks apply until a choice is made, and saves the choice", async () => {
    const conflicted = agent({
      agentId: "a1",
      name: "alpha",
      effective: { source: "unresolved", scope: null, mode: "isolated", layout: ISOLATED },
      problems: [{ code: "group-conflict", groupIds: ["g1", "g2"] }],
      applied: { kind: "shared", dirName: "group-g1" },
      restartRequired: true,
    });
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(
      overview({
        agents: [conflicted],
        groups: [
          { id: "g1", name: "devs", memberIds: ["a1"], mode: "shared" },
          { id: "g2", name: "ops", memberIds: ["a1"], mode: "isolated" },
        ],
      }),
    );
    const put = vi.spyOn(apiModule.botScopeApi, "putAgent").mockResolvedValue(conflicted);
    const root = render();
    await waitFor(() => root.querySelector('[data-testid="bot-scope-group-conflict"]') !== null);
    expect(root.querySelector('[data-testid="bot-scope-choices-open"]')!.textContent).toContain("1 agent need a choice");
    const applyButton = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Apply and restart") as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    // the group cards mark the conflicting member too
    expect(root.querySelector('[data-testid="bot-scope-groups"]')!.textContent).toContain("(conflict)");
    await act(async () => setSelect(byLabel(root, "Deciding group for alpha"), "g1"));
    expect(put).toHaveBeenCalledWith("company-1", "a1", { groupId: "g1" });
  });

  it("asks which project decides when an agent is in several", async () => {
    const ambiguous = agent({
      agentId: "a1",
      name: "alpha",
      effective: { source: "unresolved", scope: null, mode: "isolated", layout: ISOLATED },
      problems: [{ code: "project-ambiguous", projectIds: ["p1", "p2"] }],
    });
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(overview({ agents: [ambiguous] }));
    const put = vi.spyOn(apiModule.botScopeApi, "putAgent").mockResolvedValue(ambiguous);
    const root = render();
    await waitFor(() => root.querySelector('[data-testid="bot-scope-project-ambiguous"]') !== null);
    await act(async () => setSelect(byLabel(root, "Deciding project for alpha"), "p2"));
    expect(put).toHaveBeenCalledWith("company-1", "a1", { projectId: "p2" });
  });

  it("creates, renames, changes members of, sets the mode of, and deletes a group", async () => {
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(overview());
    const create = vi.spyOn(apiModule.botScopeApi, "createGroup").mockResolvedValue({ id: "g9", name: "new", memberIds: [], mode: null });
    const patch = vi.spyOn(apiModule.botScopeApi, "patchGroup").mockResolvedValue({ id: "g1", name: "x", memberIds: [], mode: null });
    const del = vi.spyOn(apiModule.botScopeApi, "deleteGroup").mockResolvedValue(undefined);
    const putSetting = vi.spyOn(apiModule.botScopeApi, "putSetting").mockResolvedValue(overview());
    const clear = vi.spyOn(apiModule.botScopeApi, "deleteSetting").mockResolvedValue(overview());
    const root = render();
    await waitFor(() => root.querySelector('[data-testid="bot-scope-group"]') !== null);

    await act(async () => setInput(byLabel(root, "New group name"), "new"));
    await act(async () => (Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Create group") as HTMLButtonElement).click());
    expect(create).toHaveBeenCalledWith("company-1", { name: "new" });

    await act(async () => setInput(byLabel(root, "Name of group devs"), "builders"));
    await act(async () => (Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Rename") as HTMLButtonElement).click());
    expect(patch).toHaveBeenCalledWith("company-1", "g1", { name: "builders" });

    await act(async () => byLabel<HTMLInputElement>(root, "beta in group devs").click());
    expect(patch).toHaveBeenCalledWith("company-1", "g1", { memberIds: ["a1", "a2"] });

    await act(async () => setSelect(byLabel(root, "Isolation of group devs"), "isolated"));
    expect(putSetting).toHaveBeenCalledWith("company-1", "group", "g1", "isolated");
    await act(async () => setSelect(byLabel(root, "Isolation of group devs"), "none"));
    expect(clear).toHaveBeenCalledWith("company-1", "group", "g1");

    await act(async () => (root.querySelector('[data-testid="bot-scope-group"] button:last-of-type') as HTMLButtonElement).click());
    expect(del).toHaveBeenCalledWith("company-1", "g1");
  });

  it("keep-isolated is a per-agent override and a server error is shown", async () => {
    vi.spyOn(apiModule.botScopeApi, "overview").mockResolvedValue(overview());
    const put = vi.spyOn(apiModule.botScopeApi, "putAgent").mockRejectedValue(new Error("nope"));
    const root = render();
    await waitFor(() => root.querySelector('[aria-label="Keep beta isolated"]') !== null);
    await act(async () => byLabel<HTMLInputElement>(root, "Keep beta isolated").click());
    expect(put).toHaveBeenCalledWith("company-1", "a2", { isolate: true });
    await waitFor(() => root.querySelector('[data-testid="bot-scope-error"]') !== null);
    expect(root.querySelector('[data-testid="bot-scope-error"]')!.textContent).toBe("nope");
  });
});
