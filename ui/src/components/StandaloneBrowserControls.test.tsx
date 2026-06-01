// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { StandaloneBrowserControls } from "./StandaloneBrowserControls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("StandaloneBrowserControls", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });

  afterEach(() => {
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows refresh, share, and open-in-browser controls in mobile standalone mode", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <ToastProvider>
            <StandaloneBrowserControls mobile />
          </ToastProvider>
        </TooltipProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[aria-label="Refresh"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Share"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Open in Browser"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
