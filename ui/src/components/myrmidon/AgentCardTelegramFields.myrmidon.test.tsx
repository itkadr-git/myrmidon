// @vitest-environment jsdom
//
// myrmidon(1.6.5 OPE-6318 part D): the "Telegram" section of the agent card —
// the alias list, the name-default note an empty list shows, the invalid/duplicate
// add guards and the datalist of the company's existing groups.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentCardTelegramFieldsView,
  type AgentCardTelegramFieldsViewProps,
} from "./AgentCardTelegramFields";

// The i18n mock hands the key back and carries named interpolation arguments
// so the default-alias note can be asserted.
const mockT = vi.hoisted(() => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(",")}` : key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

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
  act(() => {
    root.unmount();
  });
  container.remove();
});

function baseProps(
  overrides: Partial<AgentCardTelegramFieldsViewProps> = {},
): AgentCardTelegramFieldsViewProps {
  return {
    aliases: [],
    defaultAlias: "five",
    group: "",
    groupOptions: [],
    draftAlias: "",
    aliasError: null,
    canAdd: false,
    saving: false,
    canSave: false,
    error: null,
    savedNote: null,
    onDraftChange: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onGroupChange: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
}

function render(props: AgentCardTelegramFieldsViewProps) {
  act(() => {
    root.render(
      <TooltipProvider>
        <AgentCardTelegramFieldsView {...props} />
      </TooltipProvider>,
    );
  });
}

describe("AgentCardTelegramFieldsView", () => {
  it("an empty alias list shows the computed name default", () => {
    render(baseProps());
    const note = container.querySelector("[data-testid='myrmidon-agent-telegram-default']");
    expect(note?.textContent).toContain("telegramCard.defaultAliasNote:five");
    expect(container.querySelector("[data-testid='myrmidon-agent-telegram-group-input']")).toBeTruthy();
  });

  it("a name with no usable default warns instead", () => {
    render(baseProps({ defaultAlias: "" }));
    const note = container.querySelector("[data-testid='myrmidon-agent-telegram-default']");
    expect(note?.textContent).toContain("telegramCard.noDefaultAliasNote");
  });

  it("lists aliases with a remove control each", () => {
    const onRemove = vi.fn();
    render(baseProps({ aliases: ["boss", "eng"], onRemove }));
    expect(
      container.querySelector("[data-testid='myrmidon-agent-telegram-alias-boss']")?.textContent,
    ).toContain("@boss");
    act(() => {
      (
        container.querySelector(
          "[data-testid='myrmidon-agent-telegram-alias-remove-eng']",
        ) as HTMLButtonElement
      ).click();
    });
    expect(onRemove).toHaveBeenCalledWith("eng");
  });

  it("blocks the add button for an invalid or duplicate draft", () => {
    render(
      baseProps({
        draftAlias: "Eng Five",
        aliasError: "telegramCard.invalidAlias",
        canAdd: false,
      }),
    );
    expect(
      (container.querySelector("[data-testid='myrmidon-agent-telegram-alias-add']") as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    expect(container.querySelector("[data-testid='myrmidon-agent-telegram-alias-error']")).toBeTruthy();
  });

  it("the group input gets a datalist of the company's group titles", () => {
    render(baseProps({ group: "Tooling", groupOptions: ["Board", "Tooling"] }));
    const input = container.querySelector(
      "[data-testid='myrmidon-agent-telegram-group-input']",
    ) as HTMLInputElement;
    expect(input.value).toBe("Tooling");
    expect(input.getAttribute("list")).toBe("myrmidon-telegram-group-options");
    const options = [...container.querySelectorAll("datalist#myrmidon-telegram-group-options option")];
    expect(options.map((option) => option.getAttribute("value"))).toEqual(["Board", "Tooling"]);
  });

  it("saves through the callback only when the section is dirty", () => {
    const onSave = vi.fn();
    render(baseProps({ canSave: false }));
    expect(
      (container.querySelector("[data-testid='myrmidon-agent-telegram-save']") as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    render(baseProps({ canSave: true, onSave }));
    act(() => {
      (
        container.querySelector("[data-testid='myrmidon-agent-telegram-save']") as HTMLButtonElement
      ).click();
    });
    expect(onSave).toHaveBeenCalled();
  });
});
