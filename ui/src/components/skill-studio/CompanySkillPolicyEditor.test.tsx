// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CompanySkillPolicyEditor } from "./CompanySkillPolicyEditor";

const { getPolicy, replacePolicy, previewPolicy, listMembers } = vi.hoisted(() => ({
  getPolicy: vi.fn(), replacePolicy: vi.fn(), previewPolicy: vi.fn(), listMembers: vi.fn(),
}));
vi.mock("@/api/companySkills", () => ({ companySkillsApi: { getPolicy: (...args: unknown[]) => getPolicy(...args), replacePolicy: (...args: unknown[]) => replacePolicy(...args), previewPolicy: (...args: unknown[]) => previewPolicy(...args) } }));
vi.mock("@/api/access", () => ({ accessApi: { listMembers: (...args: unknown[]) => listMembers(...args) } }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => {
  const messages: Record<string, string> = {
    "area.skills.company-skill-policy.preview": "Preview decision",
    "area.skills.company-skill-policy.save": "Save policy",
    "area.skills.company-skill-policy.staleRevision": "Policy changed on the server",
    "area.skills.company-skill-policy.forbidden": "You do not have permission",
  };
  return messages[key] ?? key;
} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const policy = { schemaVersion: 1, defaultEffect: "deny", rules: [], revision: 4, materialized: true };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><CompanySkillPolicyEditor companyId={companyId} /></QueryClientProvider>); });
  await waitFor(() => expect(container.querySelector("textarea")?.value).toContain('"defaultEffect"'));
  await waitFor(() => expect(listMembers).toHaveBeenCalledWith(companyId));
}
async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    try { assertion(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
  }
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function change(node: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!;
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  getPolicy.mockReset().mockResolvedValue(policy);
  replacePolicy.mockReset().mockResolvedValue({ ...policy, revision: 5, defaultEffect: "allow" });
  previewPolicy.mockReset().mockResolvedValue({ allowed: false, reason: "policy_default", policyRevision: 4 });
  listMembers.mockReset().mockResolvedValue({ access: { canManageMembers: true }, members: [] });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe("CompanySkillPolicyEditor", () => {
  it("reads, validates, previews saved policy and saves using expectedRevision", async () => {
    await render();
    expect(getPolicy).toHaveBeenCalledWith(companyId);
    const editor = container.querySelector("textarea")!;
    expect(JSON.parse(editor.value)).toEqual({ schemaVersion: 1, defaultEffect: "deny", rules: [] });
    await change(container.querySelector('input')!, agentId);
    await act(async () => button("Preview decision").click());
    await waitFor(() => expect(previewPolicy).toHaveBeenCalledWith(companyId, { action: "skills.create", principal: { agentId }, resource: {} }));
    await change(editor, JSON.stringify({ schemaVersion: 1, defaultEffect: "allow", rules: [] }));
    await act(async () => button("Save policy").click());
    expect(replacePolicy).toHaveBeenCalledWith(companyId, { schemaVersion: 1, defaultEffect: "allow", rules: [], expectedRevision: 4 });
  });

  it("blocks invalid policy and retains edits when the server rejects a stale revision", async () => {
    replacePolicy.mockRejectedValue(new ApiError("conflict", 409, {}));
    await render();
    const editor = container.querySelector("textarea")!;
    await change(editor, '{"defaultEffect":"allow"}');
    await act(async () => button("Save policy").click());
    expect(replacePolicy).not.toHaveBeenCalled();
    const draft = JSON.stringify({ schemaVersion: 1, defaultEffect: "allow", rules: [] });
    await change(editor, draft);
    await act(async () => button("Save policy").click());
    expect(container.textContent).toContain("Policy changed on the server");
    expect(editor.value).toBe(draft);
  });

  it("does not offer writes or privileged preview to a viewer", async () => {
    listMembers.mockResolvedValue({ access: { canManageMembers: false }, members: [] });
    await render();
    expect(container.querySelector("textarea")!.readOnly).toBe(true);
    expect((button("Save policy") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Preview decision") as HTMLButtonElement).disabled).toBe(true);
    expect(replacePolicy).not.toHaveBeenCalled();
  });

  it("clears a stale preview when the principal or action changes", async () => {
    await render();
    const principal = container.querySelector("input")!;
    await change(principal, agentId);
    await act(async () => button("Preview decision").click());
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toContain("policy_default"));

    await change(principal, "33333333-3333-4333-8333-333333333333");
    expect(container.querySelector("pre")).toBeNull();
    await act(async () => button("Preview decision").click());
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toContain("policy_default"));

    const action = container.querySelector("select")!;
    await act(async () => {
      action.value = "skills.remove";
      action.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("pre")).toBeNull();
    await act(async () => button("Preview decision").click());
    await waitFor(() => expect(previewPolicy).toHaveBeenLastCalledWith(companyId, {
      action: "skills.remove",
      principal: { agentId: "33333333-3333-4333-8333-333333333333" },
      resource: {},
    }));
  });

  it("surfaces server authorization rejection without changing the draft", async () => {
    replacePolicy.mockRejectedValue(new ApiError("denied", 403, {}));
    await render();
    const editor = container.querySelector("textarea")!;
    const draft = JSON.stringify({ schemaVersion: 1, defaultEffect: "allow", rules: [] });
    await change(editor, draft);
    await act(async () => button("Save policy").click());
    expect(container.textContent).toContain("You do not have permission");
    expect(editor.value).toBe(draft);
  });
});
