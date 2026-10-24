// @vitest-environment jsdom
//
// myrmidon(1.7-DEBATE-ASYM-B): the «Discuss» button of a caste's task — the
// run it starts, the result caption it shows (verdict, stop reason, rounds,
// tokens, cost, the result document) and the refusal it surfaces when the
// caste's debates are switched off.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { DebateTaskButtonView, isCasteDisabled, verdictCaption } from "./DebateTaskButton";
import type { DebateRunView } from "./debateApi";

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
  flushSync(() => root.unmount());
  container.remove();
});

const run: DebateRunView = {
  issueId: "20000000-0000-4000-8000-000000000002",
  casteKey: "marketing",
  documentKey: "debate-result",
  costRecorded: true,
  outcome: {
    completed: true,
    stopReason: "agreement",
    stopDetail: "the critic signalled agreement in round 1; the exchange stopped early",
    roundsRun: 1,
    roundsPlanned: 3,
    tokensUsed: 4200,
    tokenCeiling: 50000,
    judgeVerdict: "VERDICT: prioritize the local partnerships channel.",
    casteKey: "marketing",
    customPrompts: ["critic"],
    roles: {
      generator: { model: "qwen-plus-free", family: "qwen" },
      critic: { model: "glm-4-flash-free", family: "zhipu" },
      judge: { model: "deepseek-chat-free", family: "deepseek" },
    },
    cost: { totalCents: 12 },
  },
};

function render(props: Partial<Parameters<typeof DebateTaskButtonView>[0]> = {}) {
  const onRun = vi.fn();
  flushSync(() => {
    root.render(
      <DebateTaskButtonView
        pending={false}
        result={null}
        error={null}
        disabledReason={null}
        onRun={onRun}
        {...props}
      />,
    );
  });
  return { onRun };
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe("myrmidon(1.7-DEBATE-ASYM-B): the discuss button", () => {
  it("offers the action and starts the debate", () => {
    const { onRun } = render();
    const button = byTestId("debate-task-button") as HTMLButtonElement;
    expect(button.textContent).toContain("Discuss");
    flushSync(() => button.click());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("shows the running state while the debate is in flight", () => {
    render({ pending: true });
    const button = byTestId("debate-task-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Discussing");
  });

  it("shows the result of the run: verdict, stop, rounds, tokens, cost and the document", () => {
    render({ result: run });
    expect(byTestId("debate-task-verdict")?.textContent).toBe("prioritize the local partnerships channel.");
    expect(byTestId("debate-task-stop")?.textContent).toBe("agreement");
    const result = byTestId("debate-task-result") as HTMLElement;
    expect(result.textContent).toContain("1/3");
    expect(result.textContent).toContain("4200/50000");
    expect(result.textContent).toContain("$0.12");
    expect(result.textContent).toContain("marketing");
    expect(result.textContent).toContain("custom guidance");
    expect(result.textContent).toContain("debate-result");
  });

  it("surfaces a refusal instead of silently doing nothing", () => {
    render({ error: "the debate gateway is not configured" });
    expect(byTestId("debate-task-error")?.textContent).toContain("not configured");
  });

  it("disables itself and says where the switch is when the caste is off", () => {
    render({ disabledReason: "debates are switched off for caste \"marketing\"" });
    expect((byTestId("debate-task-button") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("debate-task-disabled")?.textContent).toContain("Debates per caste");
  });

  it("disables itself when no company is selected", () => {
    render({ disabled: true });
    expect((byTestId("debate-task-button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): the caption helpers", () => {
  it("takes the first line of the verdict, without the VERDICT prefix", () => {
    expect(verdictCaption("VERDICT: ship it\n\nbecause ...")).toBe("ship it");
    expect(verdictCaption("\n\n  plain line  ")).toBe("plain line");
    expect(verdictCaption(null)).toBe("—");
    expect(verdictCaption("   ")).toBe("—");
    expect(verdictCaption("x".repeat(300))).toHaveLength(200);
  });

  it("recognizes the switched-off-caste refusal by its code", () => {
    expect(isCasteDisabled(new ApiError("nope", 422, { code: "debate_caste_disabled" }))).toBe(true);
    expect(isCasteDisabled(new ApiError("nope", 422, { code: "debate_config_rejected" }))).toBe(false);
    expect(isCasteDisabled(new Error("nope"))).toBe(false);
  });
});