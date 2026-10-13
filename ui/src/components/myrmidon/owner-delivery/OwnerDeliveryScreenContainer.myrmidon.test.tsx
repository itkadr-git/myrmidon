// @vitest-environment jsdom
// myrmidon(1.6.5-OWNER-DM-FILTER): wire-tier tests of the owner Telegram
// delivery screen — against a mocked API module, since part A of the feature is
// not merged yet and the mocks stand in for the frozen contract
// (GET/PATCH /api/myrmidon/owner-delivery, default `owner_decisions_only`).
//
// Checked: the settings GET drives the rendered mode, the default mode is
// rendered as a stored value, picking the other mode and saving PATCHes that
// mode and refetches, and failing GET/PATCH calls show the error state.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { OwnerDeliveryScreen } from "./OwnerDeliveryScreenContainer";
import type { OwnerDeliverySettings } from "./ownerDeliveryApi";

const ownerDeliveryApiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("./ownerDeliveryApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ownerDeliveryApi")>()),
  ownerDeliveryApi: ownerDeliveryApiMock,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORED_ALL: OwnerDeliverySettings = { mode: "all" };

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  ownerDeliveryApiMock.getSettings.mockReset().mockResolvedValue(STORED_ALL);
  ownerDeliveryApiMock.updateSettings.mockReset().mockResolvedValue(STORED_ALL);
});

afterEach(() => {
  act(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <OwnerDeliveryScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function card(title: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((element) =>
    element.textContent?.includes(title),
  );
  if (!found) throw new Error(`no radio card "${title}"`);
  return found;
}

function saveButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("[data-testid=myrmidon-owner-delivery-save]");
  if (!found) throw new Error("no Save button");
  return found;
}

describe("myrmidon(1.6.5-OWNER-DM-FILTER) container", () => {
  it("renders the mode the settings GET returned", async () => {
    await renderScreen();
    expect(ownerDeliveryApiMock.getSettings).toHaveBeenCalledTimes(1);
    expect(card("All cards").getAttribute("aria-checked")).toBe("true");
  });

  it("renders the default mode when the API reports it as stored", async () => {
    // What an empty or broken response turns into is the client tier's job
    // (ownerDeliveryApi.myrmidon.test.tsx); here the API module is mocked.
    ownerDeliveryApiMock.getSettings.mockReset().mockResolvedValue({ mode: "owner_decisions_only" });
    await renderScreen();
    expect(card("Owner decisions only").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-testid=myrmidon-owner-delivery-current]")?.textContent).toContain(
      "Current mode: Owner decisions only",
    );
  });

  it("PATCHes the picked mode on save and refetches", async () => {
    await renderScreen();
    await act(async () => card("Owner decisions only").click());
    await act(async () => saveButton().click());
    await settle();
    expect(ownerDeliveryApiMock.updateSettings).toHaveBeenCalledWith({ mode: "owner_decisions_only" });
    expect(ownerDeliveryApiMock.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a failing save", async () => {
    ownerDeliveryApiMock.updateSettings.mockReset().mockRejectedValue(new ApiError("Saving failed", 403, {}));
    await renderScreen();
    await act(async () => saveButton().click());
    await settle();
    expect(container.querySelector("[data-testid=myrmidon-owner-delivery-error]")?.textContent).toContain(
      "Saving failed",
    );
  });

  it("shows the error state when the GET fails", async () => {
    ownerDeliveryApiMock.getSettings.mockReset().mockRejectedValue(new ApiError("Not found", 404, {}));
    await renderScreen();
    expect(container.querySelector("[data-testid=myrmidon-owner-delivery-error]")?.textContent).toContain(
      "Not found",
    );
  });
});