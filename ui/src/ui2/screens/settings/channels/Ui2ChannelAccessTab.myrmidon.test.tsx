// @vitest-environment jsdom
// myrmidon(UI2-CHANNELS): Tests for the Channel access tab (OPE-10143).
// Verifies GET-driven rendering of the access mode and the allowlist, PATCH
// mode change, add/revoke/restore requests, error handling without white
// screen, and the env-locked (overridden) mode surface.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2ChannelAccessTabContainer } from "./Ui2ChannelAccessTabContainer";
import { canSubmitAccessDraft, EMPTY_ACCESS_DRAFT } from "./Ui2ChannelAccessTab";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import { ApiError } from "@/api/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsMock = vi.hoisted(() => ({
  read: vi.fn(),
  setAccessMode: vi.fn(),
}));
const allowlistMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  restore: vi.fn(),
}));
const endpointsMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("./ui2ChannelAccessTabApi", () => ({
  channelSettingsApi: settingsMock,
  channelSettingsQueryKey: ["myrmidon", "channel-settings"],
  channelAllowlistApi: allowlistMock,
  channelAllowlistQueryKey: (companyId: string) => ["myrmidon", "channel-allowlist", companyId],
  chatEndpointsApi: endpointsMock,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

const COMPANY_ID = "company-1";

function settingsView(overrides: Record<string, unknown> = {}) {
  return {
    channelAccessMode: {
      value: "allowlist",
      source: "ui",
      default: "sponsor",
      envName: "MYRMIDON_CHANNEL_ACCESS_MODE",
      overridden: false,
      ...overrides,
    },
  };
}

function allowedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    companyId: COMPANY_ID,
    provider: "telegram",
    externalId: "100200300",
    handle: "alice",
    displayName: null,
    scope: "company",
    endpointId: null,
    boardUserId: null,
    status: "active",
    addedBy: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  currentQueryClient = queryClient;
  settingsMock.read.mockReset().mockResolvedValue(settingsView());
  settingsMock.setAccessMode.mockReset();
  allowlistMock.list.mockReset().mockResolvedValue({ allowedUsers: [] });
  allowlistMock.create.mockReset();
  allowlistMock.revoke.mockReset();
  allowlistMock.restore.mockReset();
  endpointsMock.list.mockReset().mockResolvedValue([
    {
      id: "endpoint-1",
      provider: "telegram",
      botLabel: "Ops bot",
      providerAccountLabel: null,
    },
  ]);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  queryClient.clear();
  currentQueryClient = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  flushSync(() => {});
}

async function waitForSelector(selector: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.querySelector(selector)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`waitForSelector: ${selector} not found within ${timeoutMs}ms`);
}

let currentQueryClient: QueryClient | null = null;

async function invalidateAllowlist(): Promise<void> {
  if (!currentQueryClient) throw new Error("no query client");
  await act(async () => {
    await currentQueryClient!.invalidateQueries({
      queryKey: ["myrmidon", "channel-allowlist", COMPANY_ID],
    });
  });
  await settle();
}

async function renderTab(): Promise<void> {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Ui2I18nProvider initialLocale="en">
          <Ui2ChannelAccessTabContainer />
        </Ui2I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function inputByTestId(id: string): HTMLInputElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
}

function selectByTestId(id: string): HTMLSelectElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement;
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function selectOption(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Ui2ChannelAccessTab (OPE-10143)", () => {
  it("renders the access mode and the allowlist rows from GET", async () => {
    allowlistMock.list.mockResolvedValue({
      allowedUsers: [
        allowedRow(),
        allowedRow({
          id: "row-2",
          provider: "slack",
          externalId: "U77",
          handle: null,
          scope: "endpoint",
          endpointId: "endpoint-1",
          status: "revoked",
        }),
      ],
    });

    await renderTab();

    expect(settingsMock.read).toHaveBeenCalled();
    expect(allowlistMock.list).toHaveBeenCalledWith(COMPANY_ID);
    expect(selectByTestId("ui2-channel-access-mode").value).toBe("allowlist");
    expect(selectByTestId("ui2-channel-access-mode").disabled).toBe(false);
    expect(container.querySelectorAll("[data-testid='ui2-channel-access-list'] li")).toHaveLength(2);
    // active row offers revoke, revoked row offers restore
    expect(container.querySelector("[data-testid='ui2-channel-access-revoke-row-1']")).not.toBeNull();
    expect(container.querySelector("[data-testid='ui2-channel-access-restore-row-2']")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='ui2-channel-access-row-row-2-revoked']"),
    ).not.toBeNull();
  });

  it("PATCHes the new access mode on change", async () => {
    settingsMock.setAccessMode.mockResolvedValue(settingsView({ value: "sponsor" }));

    await renderTab();
    await selectOption(selectByTestId("ui2-channel-access-mode"), "sponsor");
    await settle();

    expect(settingsMock.setAccessMode).toHaveBeenCalledWith("sponsor");
  });

  it("renders the env-locked mode as read-only with the override hint", async () => {
    settingsMock.read.mockResolvedValue(
      settingsView({ value: "allowlist", source: "env", overridden: true }),
    );

    await renderTab();

    const modeSelect = selectByTestId("ui2-channel-access-mode");
    expect(modeSelect.disabled).toBe(true);
    expect(container.querySelector("[data-testid='ui2-channel-access-mode-hint']")?.textContent).toContain(
      "MYRMIDON_CHANNEL_ACCESS_MODE",
    );
  });

  it("adds a company-scope sender: trims the id and strips @ from the handle", async () => {
    allowlistMock.create.mockResolvedValue({ allowedUser: allowedRow() });

    await renderTab();

    const addBtn = container.querySelector<HTMLButtonElement>("[data-testid='ui2-channel-access-add']");
    expect(addBtn?.disabled).toBe(true);

    await typeInto(inputByTestId("ui2-channel-access-external-id"), " 100200300 ");
    await typeInto(inputByTestId("ui2-channel-access-handle"), "@alice");
    expect(addBtn?.disabled).toBe(false);

    await click("[data-testid='ui2-channel-access-add']");
    await settle();

    expect(allowlistMock.create).toHaveBeenCalledWith(COMPANY_ID, {
      provider: "telegram",
      externalId: "100200300",
      handle: "alice",
      scope: "company",
      endpointId: null,
    });
    // draft reset after submit
    expect(inputByTestId("ui2-channel-access-external-id").value).toBe("");
  });

  it("adds an endpoint-scope sender with the selected bot endpoint", async () => {
    allowlistMock.create.mockResolvedValue({ allowedUser: allowedRow() });

    await renderTab();
    await selectOption(selectByTestId("ui2-channel-access-scope"), "endpoint");

    const endpointSelect = selectByTestId("ui2-channel-access-endpoint");
    expect(endpointSelect).not.toBeNull();
    expect(endpointSelect.value).toBe("endpoint-1");

    await typeInto(inputByTestId("ui2-channel-access-external-id"), "U77");
    await click("[data-testid='ui2-channel-access-add']");
    await settle();

    expect(allowlistMock.create).toHaveBeenCalledWith(COMPANY_ID, {
      provider: "telegram",
      externalId: "U77",
      handle: null,
      scope: "endpoint",
      endpointId: "endpoint-1",
    });
  });

  it("revokes and restores an allowlist row", async () => {
    allowlistMock.list.mockResolvedValue({ allowedUsers: [allowedRow()] });
    allowlistMock.revoke.mockResolvedValue({ allowedUser: allowedRow({ status: "revoked" }) });
    allowlistMock.restore.mockResolvedValue({ allowedUser: allowedRow() });

    await renderTab();
    await click("[data-testid='ui2-channel-access-revoke-row-1']");
    await settle();
    expect(allowlistMock.revoke).toHaveBeenCalledWith(COMPANY_ID, "row-1");

    allowlistMock.list.mockResolvedValue({
      allowedUsers: [allowedRow({ status: "revoked" })],
    });
    await invalidateAllowlist();
    await waitForSelector("[data-testid='ui2-channel-access-restore-row-1']");
    await click("[data-testid='ui2-channel-access-restore-row-1']");
    await settle();
    expect(allowlistMock.restore).toHaveBeenCalledWith(COMPANY_ID, "row-1");
  });

  it("surfaces an API action error without white screen", async () => {
    await renderTab();

    allowlistMock.create.mockRejectedValue(
      new ApiError("externalId must be a channel user id", 422, { error: "invalid" }),
    );

    await typeInto(inputByTestId("ui2-channel-access-external-id"), "bad id with spaces!");
    await click("[data-testid='ui2-channel-access-add']");
    await settle();

    const errorEl = container.querySelector("[data-testid='ui2-channel-access-error']");
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("externalId must be a channel user id");
    // The tab is still mounted — no white screen
    expect(container.querySelector("[data-testid='ui2-channel-access-tab']")).not.toBeNull();
  });

  it("surfaces a GET load error with retry, then renders after refetch", async () => {
    settingsMock.read.mockRejectedValue(new Error("Network connection error"));

    await renderTab();

    const errorState = container.querySelector("[data-testid='ui2-channel-access-load-error']");
    expect(errorState).not.toBeNull();
    expect(errorState?.textContent).toContain("Network connection error");

    settingsMock.read.mockResolvedValue(settingsView());
    await click(".ui2-error-state-retry");
    await settle();

    expect(settingsMock.read).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='ui2-channel-access-tab']")).not.toBeNull();
  });

  it("keeps the submit gate honest for the draft helper", () => {
    expect(canSubmitAccessDraft({ ...EMPTY_ACCESS_DRAFT, externalId: "  " })).toBe(false);
    expect(canSubmitAccessDraft({ ...EMPTY_ACCESS_DRAFT, externalId: "100200300" })).toBe(true);
    expect(
      canSubmitAccessDraft({ ...EMPTY_ACCESS_DRAFT, externalId: "U77", scope: "endpoint", endpointId: "" }),
    ).toBe(false);
    expect(
      canSubmitAccessDraft({
        ...EMPTY_ACCESS_DRAFT,
        externalId: "U77",
        scope: "endpoint",
        endpointId: "endpoint-1",
      }),
    ).toBe(true);
  });
});
