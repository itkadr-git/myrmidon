// @vitest-environment jsdom
//
// OPE-8104: behavioral coverage for the KIE_API_KEY secret_ref binding flow.
// The vendor flow is: SkillRequiredKeysSection -> SkillRequiredKeyRow ->
// select an existing secret -> AgentMultiSelect -> agentsApi.update with
// adapterConfig env uses a secret_ref with a secretId.
// Everything runs against mocked APIs (isolated fixture, no live secrets).

import React, { act as reactAct, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillRequiredKeysSection } from "./CompanySkills";
import { secretsApi } from "../api/secrets";
import { agentsApi } from "../api/agents";

vi.mock("../components/AgentMultiSelect", () => ({
  AgentMultiSelect: ({ agents, selectedAgentIds, onSave, triggerLabel }: {
    agents: Array<{ id: string; name: string }>;
    selectedAgentIds: Set<string>;
    onSave?: (ids: Set<string>) => void;
    triggerLabel?: string;
  }) => {
    const [draft, setDraft] = React.useState(new Set(selectedAgentIds));
    return (
      <div>
        <button type="button">{triggerLabel}</button>
        {agents.map((agent) => (
          <label key={agent.id}>
            <input
              type="checkbox"
              aria-label={`Allow ${agent.name}`}
              checked={draft.has(agent.id)}
              onChange={(event) => {
                const next = new Set(draft);
                if (event.target.checked) next.add(agent.id);
                else next.delete(agent.id);
                setDraft(next);
              }}
            />
            {agent.name}
          </label>
        ))}
        <button type="button" onClick={() => onSave?.(draft)}>Save</button>
      </div>
    );
  },
}));

vi.mock("../api/secrets", () => ({
  secretsApi: {
    list: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    listConfigurations: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: vi.fn(),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ComponentProps<"button"> & { asChild?: boolean; variant?: string; size?: string }) => (
    <button type={type} {...props}>{children}</button>
  ),
}));

// The vendor suite renders PopoverContent as null, which makes the staged
// AgentMultiSelect picker unreachable. Render the popover content inline so
// the bind flow can be exercised end-to-end in jsdom.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ onCheckedChange, checked, ...props }: ComponentProps<"input"> & { onCheckedChange?: (checked: boolean) => void }) => (
    <input
      type="checkbox"
      {...props}
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock("@/components/AgentIconPicker", () => ({
  AgentIcon: () => <span aria-hidden="true" />,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div aria-hidden="true" />,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const act = reactAct as unknown as (fn: () => Promise<unknown>) => Promise<void>;

const translatedLabels: Record<string, string> = {
  "area.settings-company.company-skills.bindToAgents": "Bind to agents",
  "area.settings-company.company-skills.boundTo": "Bound to",
  "common.save": "Save",
  "common.cancel": "Cancel",
};

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const label = translatedLabels[key];
      if (label) return label;
      if (key.endsWith(".selectedShort")) return `${values?.count ?? 0} selected`;
      if (key.endsWith(".noneSelected")) return "None selected";
      if (key.endsWith(".allowAria")) return `Allow ${values?.name ?? ""}`;
      return key;
    },
  }),
}));

const dummyAgents = [
  {
    id: "agent-1",
    name: "BBQ Director",
    adapterType: "claude",
    supportsSkills: true,
    required: false,
    icon: null,
    paused: false,
    urlKey: "bbq-director",
  },
  {
    id: "agent-2",
    name: "BBQ Operator",
    adapterType: "codex",
    supportsSkills: true,
    required: false,
    icon: null,
    paused: false,
    urlKey: "bbq-operator",
  },
];

const ENV_KEY = "KIE_API_KEY";
function envKey() {
  return ENV_KEY;
}

function kieBinding(secretId: string) {
  return { type: "secret_ref", secretId } as const;
}

function agentConfig(id: string, name: string, env: Record<string, unknown> = {}) {
  return {
    id,
    companyId: "comp-1",
    name,
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: null,
    adapterType: "codex",
    adapterConfig: { env },
    runtimeConfig: {},
    permissions: {},
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function buttonsNamed(node: ParentNode, label: string): HTMLButtonElement[] {
  return Array.from(node.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  );
}

async function click(node: HTMLButtonElement) {
  await act(async () => {
    node.click();
  });
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setValue?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForElement<T extends Element>(get: () => T | null, label: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const element = get();
    if (element) return element;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillRequiredKeysSection secret_ref binding (OPE-8104)", () => {
  it("binds KIE_API_KEY to a selected agent as a secret reference via agentsApi.update", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(secretsApi.list).mockResolvedValue([
      { id: "sec-kie", name: "kie.ai — media connector key", key: "kie_ai_api_key", status: "active" } as any,
    ]);
    vi.mocked(agentsApi.listConfigurations).mockResolvedValue([
      agentConfig("agent-1", "BBQ Director"),
      agentConfig("agent-2", "BBQ Operator"),
    ] as any);
    vi.mocked(agentsApi.get).mockImplementation(async (id: string) => ({
      ...agentConfig(id, id === "agent-1" ? "BBQ Director" : "BBQ Operator"),
    }) as any);
    vi.mocked(agentsApi.update).mockResolvedValue({ ok: true } as any);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SkillRequiredKeysSection
            companyId="comp-1"
            requiredEnv={["KIE_API_KEY"]}
            attachAgents={dummyAgents}
          />
        </QueryClientProvider>,
      );
    });

    const node = container as ParentNode;
    await waitForElement(
      () => node.querySelector('[data-testid="required-env-KIE_API_KEY"]'),
      "required environment section",
    );
    expect(node.querySelector('[data-testid="required-env-KIE_API_KEY"]')).not.toBeNull();

    // 1. Select the existing secret (never exposes its value).
    const secretSelect = await waitForElement(
      () => node.querySelector('[data-testid="select-secret-KIE_API_KEY"]') as HTMLSelectElement | null,
      "secret selector",
    );
    await waitForElement(
      () => secretSelect.querySelector('option[value="sec-kie"]'),
      "secret option",
    );
    await selectValue(secretSelect, "sec-kie");
    await waitForElement(
      () => buttonsNamed(node, "Bind to agents")[0] ?? null,
      "bind trigger after selecting secret",
    );

    // 2. Open the staged agent picker and pick BBQ Operator (agent-2).
    const bindTrigger = await waitForElement(
      () => buttonsNamed(node, "Bind to agents")[0] ?? null,
      "bind trigger",
    );
    await click(bindTrigger);

    const operatorCheckbox = await waitForElement(
      () => Array.from(node.querySelectorAll('input[type="checkbox"]')).find((box) =>
        box.getAttribute("aria-label")?.includes("BBQ Operator"),
      ) as HTMLInputElement | null,
      "operator checkbox",
    );
    expect(operatorCheckbox.checked).toBe(false);
    await act(async () => {
      operatorCheckbox.click();
    });
    expect(operatorCheckbox.checked).toBe(true);

    // 3. Save the staged selection.
    const saveBtn = buttonsNamed(node, "Save")[0];
    expect(saveBtn).toBeDefined();
    await click(saveBtn);

    // 4. The binding is a secret_ref to the selected secret only —
    //    no raw secret value is ever written into adapterConfig.
    expect(agentsApi.update).toHaveBeenCalledTimes(1);
    expect(agentsApi.update).toHaveBeenCalledWith(
      "agent-2",
      {
        adapterConfig: {
          env: {
            [envKey()]: kieBinding("sec-kie"),
          },
        },
        replaceAdapterConfig: true,
      },
      "comp-1",
    );
    const updateCall = vi.mocked(agentsApi.update).mock.calls[0]![1] as {
      adapterConfig: { env: Record<string, unknown> };
    };
    expect(JSON.stringify(updateCall.adapterConfig)).not.toMatch(/secret-token|kie-value/i);
  });

  it("unbinds KIE_API_KEY when a previously bound agent is deselected and saved", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(secretsApi.list).mockResolvedValue([
      { id: "sec-kie", name: "kie.ai — media connector key", key: "kie_ai_api_key", status: "active" } as any,
    ]);
    // agent-1 arrives already bound to sec-kie; agent-2 is unbound.
    vi.mocked(agentsApi.listConfigurations).mockResolvedValue([
      agentConfig("agent-1", "BBQ Director", {
        [envKey()]: kieBinding("sec-kie"),
      }),
      agentConfig("agent-2", "BBQ Operator"),
    ] as any);
    vi.mocked(agentsApi.get).mockImplementation(async (id: string) => ({
      ...agentConfig(
        id,
        id === "agent-1" ? "BBQ Director" : "BBQ Operator",
        id === "agent-1"
          ? { [envKey()]: kieBinding("sec-kie") }
          : {},
      ),
    }) as any);
    vi.mocked(agentsApi.update).mockResolvedValue({ ok: true } as any);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SkillRequiredKeysSection
            companyId="comp-1"
            requiredEnv={["KIE_API_KEY"]}
            attachAgents={dummyAgents}
          />
        </QueryClientProvider>,
      );
    });

    const node = container as ParentNode;

    // Pre-bound secret is preselected.
    const secretSelect = await waitForElement(
      () => node.querySelector('[data-testid="select-secret-KIE_API_KEY"]') as HTMLSelectElement | null,
      "secret selector",
    );
    await waitForElement(
      () => secretSelect.querySelector('option[value="sec-kie"]'),
      "pre-bound secret option",
    );
    await waitForElement(
      () => secretSelect.value === "sec-kie" ? secretSelect : null,
      "preselected secret reference",
    );
    expect(secretSelect.value).toBe("sec-kie");

    // The bound agent shows as bound.
    await waitForElement(
      () => (node.textContent?.includes("Bound to") ? (node as Element) : null),
      "bound-agent indicator",
    );

    // Deselect the bound agent and save.
    const bindTrigger = await waitForElement(
      () => buttonsNamed(node, "Bind to agents")[0] ?? null,
      "unbind bind trigger",
    );
    await click(bindTrigger);
    const directorCheckbox = await waitForElement(
      () => Array.from(node.querySelectorAll('input[type="checkbox"]')).find((box) =>
        box.getAttribute("aria-label")?.includes("BBQ Director"),
      ) as HTMLInputElement | null,
      "director checkbox",
    );
    await act(async () => {
      directorCheckbox.click();
    });
    expect(directorCheckbox.checked).toBe(false);
    await click(buttonsNamed(node, "Save")[0]!);

    expect(agentsApi.update).toHaveBeenCalledWith(
      "agent-1",
      {
        adapterConfig: {
          env: {},
        },
        replaceAdapterConfig: true,
      },
      "comp-1",
    );
  });
});
