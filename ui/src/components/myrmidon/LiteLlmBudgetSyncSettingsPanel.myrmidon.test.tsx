// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiteLlmBudgetSyncSettingsPanelView } from "./LiteLlmBudgetSyncSettingsPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const settings = {
  enabled: false, signalOnly: true, limits: [], sweepIntervalSec: 30,
  storedSweepIntervalSec: null, sweepIntervalSource: "default" as const,
  sweepIntervalEnvName: "MYRMIDON_LITELLM_BUDGET_SYNC_INTERVAL_SEC",
};
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
function render(view: Parameters<typeof LiteLlmBudgetSyncSettingsPanelView>[0]["view"] = settings, onSave = vi.fn()) {
  flushSync(() => root.render(<LiteLlmBudgetSyncSettingsPanelView view={view} onSave={onSave} pending={false} error={null} />));
  return onSave;
}
function saveButton() { return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save projection settings"))!; }
describe("LiteLLM projection settings", () => {
  it("saves the three projection fields independently of enforcement mode", () => {
    const onSave = render();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    flushSync(() => (container.querySelector('[data-testid="litellm-sync-enabled"]') as HTMLElement).click());
    flushSync(() => (container.querySelector('[data-testid="litellm-sync-signal-only"]') as HTMLElement).click());
    flushSync(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ enabled: true, signalOnly: false, sweepIntervalSec: null, limits: [] });
  });
  it("keeps the stored interval when an environment override is in force", () => {
    const onSave = render({ ...settings, sweepIntervalSec: 60, storedSweepIntervalSec: 45, sweepIntervalSource: "env" });
    expect((container.querySelector("#litellm-sync-interval") as HTMLInputElement).disabled).toBe(true);
    flushSync(() => (container.querySelector('[data-testid="litellm-sync-enabled"]') as HTMLElement).click());
    flushSync(() => saveButton().click());
    expect(onSave).toHaveBeenCalledWith({ enabled: true, signalOnly: true, sweepIntervalSec: 45, limits: [] });
  });
});
