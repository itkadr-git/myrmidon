// @vitest-environment jsdom
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): view-tier tests for the model-group
// rules editor — the whole-table PUT body on save, and the sanitized error
// line when the save fails.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyModelGroupRulesView } from "@myrmidon/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ModelGroupRulesSection } from "./ModelGroupRulesSection";
import { modelGroupRulesApi } from "./modelGroupRulesApi";

vi.mock("./modelGroupRulesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modelGroupRulesApi")>()),
  modelGroupRulesApi: {
    get: vi.fn(),
    save: vi.fn(),
  },
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: {
      get: (path: string) => mockCastesGet(path),
    },
  };
});

const mockCastesGet = (path: string) =>
  path.endsWith("/castes")
    ? Promise.resolve({
        castes: [{ key: "engineer", nameEn: "Engineer", nameRu: "Инженер" }],
      })
    : Promise.resolve({ castes: [] });

const mockedGet = vi.mocked(modelGroupRulesApi.get);
const mockedSave = vi.mocked(modelGroupRulesApi.save);

const COMPANY_ID = "company-1";

function getResponse(overrides: Partial<CompanyModelGroupRulesView> = {}): CompanyModelGroupRulesView {
  return {
    rules: [],
    availableGroups: ["strong", "economy"],
    ...overrides,
  };
}

describe("myrmidon(1.8 MODEL-BY-STEP, OPE-12997) model group rules editor", () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockedGet.mockResolvedValue(getResponse());
    mockedSave.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
      root = null;
    });
    container.remove();
  });

  function render() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <ModelGroupRulesSection companyId={COMPANY_ID} />
        </QueryClientProvider>,
      );
    });
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      });
    }
  }


  function selectFor(scope: string, stepClass: string): HTMLSelectElement {
    const el = container.querySelector<HTMLSelectElement>(
      `[data-testid="myrmidon-model-group-rule-${scope}-${stepClass}"]`,
    );
    expect(el, `select for ${scope}/${stepClass}`).toBeTruthy();
    return el as HTMLSelectElement;
  }

  it("saves the whole table as one PUT body", async () => {
    mockedSave.mockResolvedValue(
      getResponse({ rules: [{ stepClass: "review", modelGroup: "strong", casteKey: null }] }),
    );
    render();
    await settle();

    const select = selectFor("company", "review");
    await act(async () => {
      select.value = "strong";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-model-group-rules-save"]',
    );
    expect(button).toBeTruthy();
    await act(async () => {
      (button as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith(COMPANY_ID, {
      rules: [{ stepClass: "review", modelGroup: "strong", casteKey: null }],
    });
    expect(container.textContent).toContain("Model group rules saved.");
  });

  it("renders a sanitized error when the save fails", async () => {
    render();
    await settle();

    const select = selectFor("company", "review");
    await act(async () => {
      select.value = "economy";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    mockedSave.mockRejectedValue(new Error("failed api_key=sk-secret-value-12345 upstream"));
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-model-group-rules-save"]',
    );
    await act(async () => {
      (button as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const errorLine = container.querySelector('[data-testid="myrmidon-model-group-rules-error"]');
    expect(errorLine).toBeTruthy();
    expect(errorLine?.textContent).toContain("<redacted>");
    expect(container.textContent).not.toContain("sk-secret-value-12345");
  });

  it("shows the catalog-unavailable notice when no groups exist", async () => {
    mockedGet.mockResolvedValue(getResponse({ availableGroups: [] }));
    render();
    await settle();

    expect(container.textContent).toContain("The model group catalog is unavailable");
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="myrmidon-model-group-rules-save"]',
    );
    expect(button?.disabled).toBe(true);
  });

  it("renders caste rows from the company castes", async () => {
    render();
    await act(async () => {
      queryClient.setQueryData(["myrmidon", "castes", COMPANY_ID], {
        castes: [{ key: "engineer", nameEn: "Engineer", nameRu: "Инженер" }],
      });
      await Promise.resolve();
    });
    await settle();

    expect(selectFor("engineer", "review")).toBeTruthy();
    expect(selectFor("company", "background")).toBeTruthy();
  });
});
