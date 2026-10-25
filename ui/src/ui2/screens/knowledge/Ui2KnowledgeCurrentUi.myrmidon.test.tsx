// @vitest-environment jsdom
// myrmidon(1.6.6 KNOWLEDGE, OPE-9222): the Knowledge screen of the current
// interface. The HTTP client is mocked at the REST boundary, so the test runs
// the real UI2 reader, the real knowledge api client and the real router:
// list, search, page with backlinks and in-page links under `/wiki`.
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2KnowledgeCurrentUi } from "./Ui2KnowledgeCurrentUi";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const breadcrumbs = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
const lang = vi.hoisted(() => ({ language: "ru" }));

vi.mock("@/api/client", () => ({ api: http }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c-1", selectedCompany: { id: "c-1", issuePrefix: "OPE" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbs.setBreadcrumbs }),
}));
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: lang.language },
  }),
}));

const ITEMS = [
  {
    id: "i-1",
    slug: "intro",
    folderPath: "ops",
    title: "Intro page",
    status: "published",
    currentRevisionNumber: 1,
    updatedAt: "2026-10-20T10:00:00.000Z",
    parentSlug: null,
    reviewDueAt: null,
  },
  {
    id: "i-2",
    slug: "other",
    folderPath: "ops",
    title: "Other page",
    status: "published",
    currentRevisionNumber: 1,
    updatedAt: "2026-10-20T10:00:00.000Z",
    parentSlug: null,
    reviewDueAt: null,
  },
];

const REVISION = {
  id: "r-1",
  itemId: "i-1",
  revisionNumber: 1,
  status: "approved",
  content: "Hello body, see [[other]].",
  createdAt: "2026-10-20T10:00:00.000Z",
  sources: [],
};

function route(url: string): unknown {
  if (url.includes("/search?")) {
    return { query: "intro", items: [{ itemId: "i-1", slug: "intro", folderPath: "ops", title: "Intro page" }] };
  }
  if (url.endsWith("/backlinks")) {
    return {
      backlinks: [
        { sourceItemId: "i-2", sourceSlug: "other", sourceTitle: "Other page", targetSlug: "intro", resolved: true },
      ],
    };
  }
  if (url.endsWith("/revisions")) return { revisions: [REVISION] };
  if (url.includes("/knowledge/items/")) return { item: ITEMS[0] };
  if (url.includes("/knowledge/items")) return { items: ITEMS };
  throw new Error(`unexpected GET ${url}`);
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  http.get.mockReset();
  http.get.mockImplementation(async (url: string) => route(url));
  breadcrumbs.setBreadcrumbs.mockReset();
  lang.language = "ru";
  try {
    window.localStorage.removeItem("myrmidon.ui2.locale");
  } catch {
    // storage may be unavailable
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

async function settle() {
  for (let round = 0; round < 15; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(path: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/:companyPrefix/wiki" element={<Ui2KnowledgeCurrentUi />} />
            <Route path="/:companyPrefix/wiki/:spaceKey/:slug" element={<Ui2KnowledgeCurrentUi />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

describe("Ui2KnowledgeCurrentUi (current UI, OPE-9222)", () => {
  it("lists the pages of the knowledge module at /wiki, in the interface language", async () => {
    await render("/OPE/wiki");
    const text = container.textContent ?? "";
    expect(text).toContain("Intro page");
    expect(text).toContain("Other page");
    expect(text).toContain("Знания");
    expect(http.get).toHaveBeenCalledWith(expect.stringContaining("/myrmidon/companies/c-1/knowledge/items"));
    expect(breadcrumbs.setBreadcrumbs).toHaveBeenCalledWith([{ label: "ui2.nav.knowledge" }]);
  });

  it("opens a page at /wiki/:spaceKey/:slug with its body and backlinks", async () => {
    await render("/OPE/wiki/ops/intro");
    const text = container.textContent ?? "";
    expect(text).toContain("Hello body, see");
    expect(http.get).toHaveBeenCalledWith(expect.stringContaining("/knowledge/items/ops%2Fintro/backlinks"));
    const backlink = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Other page");
    expect(backlink?.getAttribute("href")).toBe("/OPE/wiki/ops/other");
    const inline = container.querySelector(".ui2-knowledge-link");
    expect(inline?.getAttribute("href")?.startsWith("/OPE/wiki/")).toBe(true);
  });

  it("navigates to a page from the tree through a /wiki route", async () => {
    await render("/OPE/wiki");
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Other page");
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe("/OPE/wiki/ops/other");
  });

  it("searches through the REST search endpoint and links hits under /OPE/wiki", async () => {
    await render("/OPE/wiki");
    const input = container.querySelector<HTMLInputElement>("input.ui2-knowledge-search-input");
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "intro");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(http.get).toHaveBeenCalledWith(expect.stringContaining("/knowledge/search?q=intro"));
    const hit = container.querySelector<HTMLAnchorElement>("a.ui2-knowledge-search-hit-title");
    expect(hit?.getAttribute("href")).toBe("/OPE/wiki/ops/intro");
  });

  it("falls back to English texts for an unsupported language", async () => {
    lang.language = "de";
    await render("/OPE/wiki");
    expect(container.textContent).toContain("Knowledge");
  });
});
