/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputFeedbackButtons } from "./OutputFeedbackButtons";

describe("OutputFeedbackButtons terms link rendering", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders the operator terms link in the prompt dialog when termsUrl is provided", async () => {
    root = createRoot(container);
    const onVote = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root?.render(
        <OutputFeedbackButtons
          sharingPreference="prompt"
          termsUrl="https://operator.example.org/feedback-terms"
          onVote={onVote}
        />,
      );
    });

    const upButton = container.querySelector("svg.lucide-thumbs-up")?.closest("button");
    expect(upButton).not.toBeNull();

    await act(async () => {
      upButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const termsLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href="https://operator.example.org/feedback-terms"]',
    );
    expect(termsLink).not.toBeNull();
    expect(termsLink?.getAttribute("target")).toBe("_blank");
    expect(termsLink?.getAttribute("rel")).toContain("noreferrer");
    expect(termsLink?.textContent).toContain("Read data terms");
  });

  it("omits the terms link in the prompt dialog when termsUrl is null or empty", async () => {
    root = createRoot(container);
    const onVote = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root?.render(
        <OutputFeedbackButtons
          sharingPreference="prompt"
          termsUrl={null}
          onVote={onVote}
        />,
      );
    });

    const upButton = container.querySelector("svg.lucide-thumbs-up")?.closest("button");
    expect(upButton).not.toBeNull();

    await act(async () => {
      upButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const termsLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href*="terms"], a[href*="tos"]',
    );
    expect(termsLink).toBeNull();
  });
});
