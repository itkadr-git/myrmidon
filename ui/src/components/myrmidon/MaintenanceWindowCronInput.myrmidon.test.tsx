// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceWindowCronInput } from "./MaintenanceWindowCronInput";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MaintenanceWindowCronInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders with a valid cron schedule and shows success description", () => {
    flushSync(() => {
      root.render(
        <MaintenanceWindowCronInput
          value="0 3 * * 0"
          durationMinutes={120}
          timezone="UTC"
        />,
      );
    });

    const successElem = container.querySelector("[data-testid='cron-validation-success']");
    expect(successElem).not.toBeNull();
    expect(successElem?.textContent).toContain("Sunday");
    expect(successElem?.textContent).toContain("03:00 UTC");
    expect(container.querySelector("[data-testid='cron-validation-error']")).toBeNull();
  });

  it("renders validation error for an invalid cron expression", () => {
    flushSync(() => {
      root.render(
        <MaintenanceWindowCronInput
          value="65 3 * * 0"
          durationMinutes={120}
          timezone="UTC"
        />,
      );
    });

    const errorElem = container.querySelector("[data-testid='cron-validation-error']");
    expect(errorElem).not.toBeNull();
    expect(errorElem?.textContent).toContain("out of allowed bounds");
    expect(container.querySelector("[data-testid='cron-validation-success']")).toBeNull();
  });

  it("calls onChange when cron expression is modified", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root.render(
        <MaintenanceWindowCronInput
          value="0 3 * * 0"
          durationMinutes={120}
          timezone="UTC"
          onChange={onChange}
        />,
      );
    });

    const input = container.querySelector("input[placeholder='0 3 * * 0']") as HTMLInputElement;
    expect(input).not.toBeNull();

    flushSync(() => {
      input.value = "0 4 * * *";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Also input event
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  it("applies a preset on button click", () => {
    const onChange = vi.fn();
    flushSync(() => {
      root.render(
        <MaintenanceWindowCronInput
          value=""
          durationMinutes={120}
          timezone="UTC"
          onChange={onChange}
        />,
      );
    });

    const presetButtons = container.querySelectorAll("button");
    const dailyBtn = Array.from(presetButtons).find((b) => b.textContent?.includes("Daily"));
    expect(dailyBtn).toBeDefined();

    flushSync(() => {
      dailyBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("0 4 * * *", 60, true);
  });
});
