// @vitest-environment jsdom
// myrmidon(1.6.6 CORPUS E): wire-tier tests for the "Knowledge corpus" screen.
//
// The api module is mocked, so these run the real react-query wiring: the load
// of the stored settings, the gate that hides the screen when the server half
// is not there, the full-object save round-trip, dataset and document actions
// and the trial search.
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CorpusScreen } from "./CorpusScreenContainer";

const breadcrumbs = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));

const corpusApi = vi.hoisted(() => ({
  getSettings: vi.fn(),
  putSettings: vi.fn(),
  listDatasets: vi.fn(),
  createDataset: vi.fn(),
  deleteDataset: vi.fn(),
  listDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  retryDocument: vi.fn(),
  deleteDocument: vi.fn(),
  search: vi.fn(),
}));

vi.mock("./corpusApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./corpusApi")>();
  return { ...actual, corpusApi };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbs.setBreadcrumbs }),
}));

vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// A stored settings object that carries a field this screen does not know:
// saving must write it back untouched (round-trip without loss).
const STORED = {
  enabled: true,
  parsingServiceBaseUrl: "http://parsers.internal:8080",
  embedderModel: "text-embedding-v4",
  limits: { maxUploadMb: 25, maxDocumentsPerDataset: 500, searchTopK: 5 },
  workerPool: 2,
};

const DATASETS = [
  { id: "ds-1", name: "runbooks", documentCount: 2, createdAt: "2026-10-01T08:00:00.000Z" },
];

const DOCUMENTS = [
  {
    id: "doc-ready",
    datasetId: "ds-1",
    filename: "vacation.txt",
    status: "ready",
    sizeBytes: 2048,
    chunkCount: 4,
    error: null,
    createdAt: "2026-10-01T08:05:00.000Z",
    updatedAt: "2026-10-01T08:06:00.000Z",
  },
  {
    id: "doc-failed",
    datasetId: "ds-1",
    filename: "scan.pdf",
    status: "failed",
    sizeBytes: 51200,
    chunkCount: 0,
    error: "parser refused the file",
    createdAt: "2026-10-01T08:07:00.000Z",
    updatedAt: "2026-10-01T08:08:00.000Z",
  },
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(corpusApi)) mock.mockReset();
  corpusApi.getSettings.mockResolvedValue(STORED);
  corpusApi.listDatasets.mockResolvedValue(DATASETS);
  corpusApi.listDocuments.mockResolvedValue(DOCUMENTS);
  corpusApi.putSettings.mockResolvedValue(undefined);
  corpusApi.deleteDataset.mockResolvedValue(undefined);
  corpusApi.retryDocument.mockResolvedValue(undefined);
  corpusApi.deleteDocument.mockResolvedValue(undefined);
  corpusApi.uploadDocument.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** Mounts the screen with a query client and lets the first loads settle. */
async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CorpusScreen />
      </QueryClientProvider>,
    );
  });
}

async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function node<T extends Element = HTMLElement>(testid: string): T {
  const found = container.querySelector<T>(`[data-testid="${testid}"]`);
  expect(found, `expected [data-testid="${testid}"]`).not.toBeNull();
  return found as T;
}

function maybe(testid: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

async function click(testid: string) {
  await act(async () => {
    node(testid).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function type(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(selector);
  expect(field, `expected ${selector}`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  await act(async () => {
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function text(testid: string): string {
  return node(testid).textContent ?? "";
}

describe("myrmidon(1.6.6 CORPUS E) corpus screen wiring", () => {
  it("loads the stored settings, datasets and documents of the first dataset", async () => {
    await render();
    await settle();

    expect(corpusApi.getSettings).toHaveBeenCalledWith("c-1");
    expect(corpusApi.listDatasets).toHaveBeenCalledWith("c-1");
    expect(corpusApi.listDocuments).toHaveBeenCalledWith("c-1", "ds-1");

    expect(maybe("myrmidon-corpus-unavailable")).toBeNull();
    expect(text("myrmidon-corpus-screen")).toContain("corpus.title");
    const url = container.querySelector<HTMLInputElement>("#myrmidon-corpus-parsing-base-url");
    expect(url?.value).toBe(STORED.parsingServiceBaseUrl);
    // The module is on: no off notice.
    expect(maybe("myrmidon-corpus-module-off")).toBeNull();
    expect(text("myrmidon-corpus-documents")).toContain("vacation.txt");
    expect(text("myrmidon-corpus-documents")).toContain("scan.pdf");
  });

  it("presents the screen as unavailable when the server half is absent", async () => {
    corpusApi.getSettings.mockRejectedValue(new ApiError("module off", 503, null));
    await render();
    await settle();

    expect(node("myrmidon-corpus-unavailable")).toBeTruthy();
    // No form, no actions and — above all — no dataset or document request.
    expect(maybe("myrmidon-corpus-settings")).toBeNull();
    expect(maybe("myrmidon-corpus-datasets")).toBeNull();
    expect(corpusApi.listDatasets).not.toHaveBeenCalled();
    expect(corpusApi.listDocuments).not.toHaveBeenCalled();
  });

  it("saves the whole settings object and reads it back", async () => {
    await render();
    await settle();
    corpusApi.getSettings.mockClear();

    await type("#myrmidon-corpus-embedder-model", "text-embedding-v5");
    await click("myrmidon-corpus-save");
    await settle();

    // The body carries every stored field, including the one the form ignores.
    expect(corpusApi.putSettings).toHaveBeenCalledWith("c-1", {
      ...STORED,
      embedderModel: "text-embedding-v5",
    });
    // Saved state is read back from the server, not assumed.
    expect(corpusApi.getSettings).toHaveBeenCalledWith("c-1");
    expect(text("myrmidon-corpus-saved")).toBe("corpus.saved");
  });

  it("shows the off notice and blocks the pipeline while the module is off", async () => {
    corpusApi.getSettings.mockResolvedValue({ ...STORED, enabled: false });
    await render();
    await settle();

    expect(node("myrmidon-corpus-module-off")).toBeTruthy();
    // Datasets are not read while the module is off, and the switch stays usable.
    expect(corpusApi.listDatasets).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-enabled")).not.toBeNull();
    expect(node<HTMLButtonElement>("myrmidon-corpus-search-submit").disabled).toBe(true);
  });

  it("creates a dataset, opens it and deletes it after a confirmation", async () => {
    corpusApi.createDataset.mockResolvedValue({
      id: "ds-2",
      name: "notes",
      documentCount: 0,
      createdAt: "2026-10-08T09:00:00.000Z",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();

    await type("#myrmidon-corpus-new-dataset", "notes");
    await click("myrmidon-corpus-dataset-create");
    await settle();

    expect(corpusApi.createDataset).toHaveBeenCalledWith("c-1", "notes");
    // The new dataset becomes the open one and its documents are read.
    expect(corpusApi.listDocuments).toHaveBeenCalledWith("c-1", "ds-2");

    corpusApi.listDocuments.mockClear();
    await click("myrmidon-corpus-dataset-delete-ds-1");
    expect(window.confirm).toHaveBeenCalled();
    expect(corpusApi.deleteDataset).toHaveBeenCalledWith("c-1", "ds-1");
  });

  it("does not delete a dataset the operator cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await render();
    await settle();

    await click("myrmidon-corpus-dataset-delete-ds-1");
    expect(corpusApi.deleteDataset).not.toHaveBeenCalled();
  });

  it("uploads a file into the open dataset", async () => {
    await render();
    await settle();

    const input = node<HTMLInputElement>("myrmidon-corpus-upload-input");
    const file = new File(["hello corpus"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(corpusApi.uploadDocument).toHaveBeenCalledWith("c-1", "ds-1", file);
  });

  it("retries a failed document and deletes a document after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await settle();

    await click("myrmidon-corpus-document-retry-doc-failed");
    expect(corpusApi.retryDocument).toHaveBeenCalledWith("c-1", "doc-failed");

    await click("myrmidon-corpus-document-delete-doc-ready");
    expect(corpusApi.deleteDocument).toHaveBeenCalledWith("c-1", "doc-ready");
  });

  it("runs the trial search over the open dataset with the stored top-k", async () => {
    corpusApi.search.mockResolvedValue({
      datasetId: "ds-1",
      query: "vacation",
      hits: [
        {
          documentId: "doc-ready",
          documentFilename: "vacation.txt",
          chunkIndex: 2,
          score: 0.9125,
          text: "28 days",
        },
      ],
      tookMs: 96,
    });
    await render();
    await settle();

    await type("#myrmidon-corpus-search-query", "vacation");
    await click("myrmidon-corpus-search-submit");
    await settle();

    expect(corpusApi.search).toHaveBeenCalledWith("c-1", "ds-1", "vacation", STORED.limits.searchTopK);
    expect(text("myrmidon-corpus-search-results")).toContain("vacation.txt");
    expect(text("myrmidon-corpus-search-results")).toContain("28 days");
  });

  it("surfaces a failing search without dropping the screen", async () => {
    corpusApi.search.mockRejectedValue(new ApiError("search index down", 500, null));
    await render();
    await settle();

    await type("#myrmidon-corpus-search-query", "vacation");
    await click("myrmidon-corpus-search-submit");
    await settle();

    expect(text("myrmidon-corpus-search-error")).toBe("search index down");
    expect(maybe("myrmidon-corpus-screen")).not.toBeNull();
  });

  it("surfaces a failing settings read that is not a missing module", async () => {
    corpusApi.getSettings.mockRejectedValue(new ApiError("database down", 500, null));
    await render();
    await settle();

    expect(text("myrmidon-corpus-load-error")).toBe("database down");
    expect(maybe("myrmidon-corpus-unavailable")).toBeNull();
  });
});