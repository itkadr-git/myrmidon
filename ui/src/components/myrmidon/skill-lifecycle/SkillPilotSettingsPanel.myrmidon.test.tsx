// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillPilotSettingsPanelView } from "./SkillPilotSettingsPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
describe("skill lifecycle pilot settings", () => {
  it("shows the source and saves an empty list to disable candidate delivery", () => {
    const onSave = vi.fn();
    flushSync(() => root.render(<SkillPilotSettingsPanelView view={{ agentIds: ["agent-a"], source: "env" }} onSave={onSave} pending={false} error={null} />));
    expect(container.textContent).toContain("Source: env");
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save pilot agents"))!;
    flushSync(() => save.click());
    expect(onSave).toHaveBeenCalledWith([]);
  });
});
