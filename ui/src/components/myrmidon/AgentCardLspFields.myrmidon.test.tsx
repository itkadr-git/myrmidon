// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotLspSettings } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentCardLspFields, botLspCardFor } from "./AgentCardLspFields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(value: unknown, role: string | null, settings: BotLspSettings | null = null, onChange = vi.fn()) {
  act(() => {
    root.render(
      <TooltipProvider>
        <AgentCardLspFields value={value} role={role} settings={settings} onChange={onChange} />
      </TooltipProvider>,
    );
  });
  return onChange;
}

function expand() {
  const header = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Language servers");
  if (header?.getAttribute("aria-expanded") !== "true") act(() => header?.click());
}

function select(): HTMLSelectElement {
  return container.querySelector<HTMLSelectElement>("[data-testid=agent-lsp-mode]")!;
}

function pick(value: string) {
  const el = select();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("myrmidon(BOT-LSP-DEFAULTS) agent card fields", () => {
  it("shows the role's mode when the card pins nothing", () => {
    render(undefined, "engineer");
    expand();
    expect(select().value).toBe("");
    expect(select().options[0]?.textContent).toContain("By role: Limited (writes code)");
    expect(container.querySelector("[data-testid=agent-lsp-in-force]")?.textContent).toContain("In force: Limited");
  });

  it("a non-coding role is off by default, and the instance policy can change that", () => {
    render(undefined, "general");
    expand();
    expect(select().options[0]?.textContent).toContain("By role: Off (does not write code)");
    render(undefined, "general", { codingRoles: ["general"] });
    expect(select().options[0]?.textContent).toContain("By role: Limited (writes code)");
  });

  it("pins a mode on the card and clears the pin back to the role", () => {
    const onChange = render({ mode: "off" }, "engineer");
    expand();
    expect(select().value).toBe("off");
    expect(container.querySelector("[data-testid=agent-lsp-in-force]")?.textContent).toContain("In force: Off");
    pick("limited");
    expect(onChange).toHaveBeenLastCalledWith({ mode: "limited" });
    pick("");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("botLspCardFor maps the picked option to the stored block", () => {
    expect(botLspCardFor("full")).toEqual({ mode: "full" });
    expect(botLspCardFor("")).toBeUndefined();
  });
});
