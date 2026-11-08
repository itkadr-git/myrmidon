// @vitest-environment jsdom
//
// myrmidon(OPE-11232, OPE-11233): the run-priority panel and the shared bot
// mount panel of Instance → General render from the RU/EN catalogs. With the
// RU locale no English wording and no raw catalog key may reach the screen.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { i18n } from "@/i18n";
import { RunPrioritySettingsPanel } from "./RunPrioritySettingsPanel";
import { SharedMountSettingsPanel } from "./SharedMountSettingsPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./licensingApi", () => ({ useIsInstanceAdmin: () => true }));

const RUN_PRIORITY_VIEW = {
  source: "settings" as const,
  settings: {
    enabled: true,
    roleWeights: { review: 90, release: 80, lead: 70, engineer: 50, docs: 30 },
    issuePriorityWeights: { critical: 100, high: 80, medium: 60, low: 40, none: 20 },
    defaultRoleWeight: 10,
    releaseBonus: 200,
    currentRelease: "1.6.6",
    agingStepMinutes: 30,
    agingStepWeight: 5,
    agingMaxBonus: 500,
    starvationLimitMinutes: 90,
    starvationTopWeight: 10_000,
    pheromoneWeight: 15,
  },
};

const GENERAL_SETTINGS = {
  sharedMount: { enabled: true, hostPath: "/srv/bot-shared", writable: false, allowedBots: [] },
};

let root: Root | null = null;
let container: HTMLDivElement;

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function renderPanel(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {element}
      </QueryClientProvider>,
    );
  });
  await settle();
  return container;
}

function typeInto(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`missing ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: Element | null) {
  if (!element) throw new Error("missing element");
  act(() => {
    (element as HTMLElement).click();
  });
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === text) ?? null;
}

function labelTexts(): string[] {
  return Array.from(container.querySelectorAll("label")).map((label) => label.textContent ?? "");
}

/** Latin words left on the screen, minus the abbreviations a Russian UI keeps. */
function latinWords(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []).filter((word) => !["ID", "UUID"].includes(word));
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  vi.spyOn(api, "get").mockResolvedValue(RUN_PRIORITY_VIEW as never);
  vi.spyOn(instanceSettingsApi, "getGeneral").mockResolvedValue(GENERAL_SETTINGS as never);
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = null;
  await i18n.changeLanguage("en");
});

describe("run priority panel locales", () => {
  it("shows the Russian title and Russian field captions with the RU locale", async () => {
    await i18n.changeLanguage("ru");
    await renderPanel(<RunPrioritySettingsPanel />);
    expect(container.querySelector("h2")?.textContent).toBe("Приоритет очереди прогонов");
    expect(container.textContent).toContain("Источник: сохранено здесь.");
    const labels = labelTexts();
    expect(labels).toContain("Включено");
    expect(labels).toContain("Вес роли «ревью»");
    expect(labels).toContain("Вес задач с приоритетом «критический»");
    expect(labels).toContain("Вес остальных ролей");
    expect(labels).toContain("Вес при долгом ожидании");
    expect(labels).toContain("Текущий релиз");
    expect(buttonWithText("Сохранить приоритет очереди")).toBeTruthy();
    // no English wording, no raw field names, no raw catalog keys
    expect(latinWords(container.textContent ?? "")).toEqual([]);
    expect(container.textContent).not.toContain("area.settings-");
  });

  it("keeps the English wording with the EN locale", async () => {
    await i18n.changeLanguage("en");
    await renderPanel(<RunPrioritySettingsPanel />);
    expect(container.querySelector("h2")?.textContent).toBe("Run queue priority");
    const labels = labelTexts();
    expect(labels).toContain("review role weight");
    expect(labels).toContain("critical issue weight");
    expect(labels).toContain("Current release");
    expect(buttonWithText("Save queue priority")).toBeTruthy();
    expect(container.textContent).not.toContain("area.settings-");
  });

  it("reports an invalid weight in Russian, naming the field by its caption", async () => {
    await i18n.changeLanguage("ru");
    await renderPanel(<RunPrioritySettingsPanel />);
    typeInto("#queue-role-review", "abc");
    click(buttonWithText("Сохранить приоритет очереди"));
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Вес роли «ревью»: введите целое число от 0 до 1000.",
    );
    typeInto("#queue-starvationLimitMinutes", "240");
    typeInto("#queue-role-review", "90");
    click(buttonWithText("Сохранить приоритет очереди"));
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Предел ожидания (минуты): введите целое число от 0 до 239.",
    );
  });
});

describe("shared bot mount panel locales", () => {
  it("shows the Russian title, captions and buttons with the RU locale", async () => {
    await i18n.changeLanguage("ru");
    await renderPanel(<SharedMountSettingsPanel />);
    expect(container.querySelector("h2")?.textContent).toBe("Общий каталог ботов");
    const labels = labelTexts();
    expect(labels).toContain("Включено");
    expect(labels).toContain("Запись разрешена ботам");
    expect(labels).toContain("Разрешённые ID ботов (через запятую; пусто — разрешены все)");
    expect(labels).toContain("Каталог на хосте (пусто — общий подкаталог в корне томов ботов)");
    expect(labels.some((text) => text.startsWith("Подтверждаю:"))).toBe(true);
    expect(buttonWithText("Сохранить общий каталог")).toBeTruthy();
    expect(latinWords(container.textContent ?? "")).toEqual([]);
    expect(container.textContent).not.toContain("area.settings-");
  });

  it("keeps the English wording with the EN locale", async () => {
    await i18n.changeLanguage("en");
    await renderPanel(<SharedMountSettingsPanel />);
    expect(container.querySelector("h2")?.textContent).toBe("Shared bot mount");
    expect(labelTexts()).toContain("Writable by bots");
    expect(buttonWithText("Save shared mount")).toBeTruthy();
    expect(container.textContent).not.toContain("area.settings-");
  });

  it("explains a malformed bot ID in Russian and does not send the patch", async () => {
    await i18n.changeLanguage("ru");
    const update = vi.spyOn(instanceSettingsApi, "updateGeneral").mockResolvedValue(GENERAL_SETTINGS as never);
    await renderPanel(<SharedMountSettingsPanel />);
    typeInto("#shared-mount-bots", "not-a-uuid");
    const confirm = container.querySelector<HTMLInputElement>("label:last-of-type input[type='checkbox']");
    click(confirm);
    click(buttonWithText("Сохранить общий каталог"));
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Введите нормализованный абсолютный путь на хосте и UUID ботов через запятую.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("still lets an administrator keep the stored host path (no host path restriction in this change)", async () => {
    await i18n.changeLanguage("ru");
    const update = vi.spyOn(instanceSettingsApi, "updateGeneral").mockResolvedValue(GENERAL_SETTINGS as never);
    await renderPanel(<SharedMountSettingsPanel />);
    expect(container.querySelector<HTMLInputElement>("#shared-mount-path")?.value).toBe("/srv/bot-shared");
    expect(container.querySelector<HTMLInputElement>("#shared-mount-path")?.disabled).toBe(false);
    typeInto("#shared-mount-path", "/srv/other-shared");
    click(container.querySelector<HTMLInputElement>("label:last-of-type input[type='checkbox']"));
    click(buttonWithText("Сохранить общий каталог"));
    await settle();
    // react-query passes its mutation context as a second argument; the patch is the first
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toEqual({
      sharedMount: { enabled: true, hostPath: "/srv/other-shared", writable: false, allowedBots: [] },
    });
  });
});
