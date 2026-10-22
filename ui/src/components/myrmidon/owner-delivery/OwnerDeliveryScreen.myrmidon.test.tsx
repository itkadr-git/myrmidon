// @vitest-environment jsdom
// myrmidon(1.6.5-OWNER-DM-FILTER): view-tier tests of the owner Telegram
// delivery screen. The screen renders part A's frozen contract as plain props,
// so this tier needs no react-query.
//
// Checked: the stored mode is the checked card, picking another card is only a
// draft until Save, Save hands the picked mode to the caller, an in-flight save
// disables the button, a failure is surfaced, and a missing settings object
// shows the loading notice.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerDeliveryScreenView } from "./OwnerDeliveryScreen";
import type { OwnerDeliverySettings } from "./ownerDeliveryApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORED_ALL: OwnerDeliverySettings = { mode: "all" };

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderView(props: {
  settings: OwnerDeliverySettings | null | undefined;
  onSave: (settings: OwnerDeliverySettings) => void;
  pending?: boolean;
  error?: string | null;
}): void {
  root = createRoot(container);
  act(() => {
    root!.render(
      <OwnerDeliveryScreenView
        settings={props.settings}
        onSave={props.onSave}
        pending={props.pending ?? false}
        error={props.error ?? null}
      />,
    );
  });
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

describe("myrmidon(1.6.5-OWNER-DM-FILTER) owner delivery screen", () => {
  it("checks the stored mode and names it as the current one", () => {
    renderView({ settings: STORED_ALL, onSave: vi.fn() });
    expect(card("All cards").getAttribute("aria-checked")).toBe("true");
    expect(card("Owner decisions only").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("[data-testid=myrmidon-owner-delivery-current]")?.textContent).toContain(
      "Current mode: All cards",
    );
  });

  it("picks a mode without saving it, and hands it over on Save", () => {
    const onSave = vi.fn();
    renderView({ settings: STORED_ALL, onSave });
    act(() => card("Owner decisions only").click());
    expect(onSave).not.toHaveBeenCalled();
    expect(card("Owner decisions only").getAttribute("aria-checked")).toBe("true");
    act(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ mode: "owner_decisions_only" });
  });

  it("keeps the default mode selected before any pick", () => {
    const onSave = vi.fn();
    renderView({ settings: { mode: "owner_decisions_only" }, onSave });
    act(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ mode: "owner_decisions_only" });
  });

  it("offers the bot-message mode and selects it when nothing is stored", () => {
    const onSave = vi.fn();
    renderView({ settings: { mode: "via_bot" }, onSave });
    expect(card("Message from the bot").getAttribute("aria-checked")).toBe("true");
    act(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ mode: "via_bot" });
  });

  it("disables Save while the save is in flight", () => {
    renderView({ settings: STORED_ALL, onSave: vi.fn(), pending: true });
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toContain("Saving");
  });

  it("surfaces a save failure", () => {
    renderView({ settings: STORED_ALL, onSave: vi.fn(), error: "Saving failed" });
    expect(container.querySelector("[data-testid=myrmidon-owner-delivery-error]")?.textContent).toContain(
      "Saving failed",
    );
  });

  it("shows the loading notice while the settings are unknown", () => {
    renderView({ settings: undefined, onSave: vi.fn() });
    expect(container.querySelector("[data-testid=myrmidon-owner-delivery-loading]")).not.toBeNull();
    expect(container.querySelectorAll("[role=radio]").length).toBe(0);
  });
});