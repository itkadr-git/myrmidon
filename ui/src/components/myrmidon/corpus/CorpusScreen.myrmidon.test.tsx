// @vitest-environment jsdom
// myrmidon(1.6.6 CORPUS E): the "Knowledge corpus" screen — pure helpers and
// the view tier, no network.
//
// Guard tests: the module-off notice and the unavailable state, the settings
// draft round-trip (unknown keys preserved, bounds refused before the request),
// dataset and document actions, and the trial search output with the document
// link a hit carries.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CorpusScreenView, type CorpusScreenViewProps } from "./CorpusScreen";
import type { CorpusDataset, CorpusDocument, CorpusSearchResult, CorpusSettings } from "./corpusApi";
import {
  CORPUS_POLL_INTERVAL_MS,
  datasetNameValid,
  documentAnchorHref,
  draftFromSettings,
  formatBytes,
  isTerminalStatus,
  parseBoundedInt,
  parsingBaseUrlValid,
  scoreText,
  settingsFromDraft,
  statusLabelKey,
} from "./corpusConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

const SETTINGS: CorpusSettings = {
  enabled: true,
  parsingServiceBaseUrl: "http://parsers.internal:8080",
  embedderModel: "text-embedding-v4",
  limits: { maxUploadMb: 25, maxDocumentsPerDataset: 500, searchTopK: 5 },
};

const OFF_SETTINGS: CorpusSettings = { ...SETTINGS, enabled: false };

const DATASETS: CorpusDataset[] = [
  { id: "ds-1", name: "Regulations", documentCount: 2, createdAt: "2026-10-01T10:00:00.000Z" },
  { id: "ds-2", name: "Contracts", documentCount: 0, createdAt: "2026-10-02T10:00:00.000Z" },
];

const DOCUMENTS: CorpusDocument[] = [
  {
    id: "doc-ready",
    datasetId: "ds-1",
    filename: "vacation.txt",
    status: "ready",
    sizeBytes: 2048,
    chunkCount: 4,
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:01:00.000Z",
  },
  {
    id: "doc-failed",
    datasetId: "ds-1",
    filename: "scan.pdf",
    status: "failed",
    sizeBytes: 1024 * 1024,
    chunkCount: 0,
    error: "parsing service refused the file",
    createdAt: "2026-10-03T11:00:00.000Z",
    updatedAt: "2026-10-03T11:02:00.000Z",
  },
];

const SEARCH_RESULT: CorpusSearchResult = {
  datasetId: "ds-1",
  query: "vacation",
  hits: [
    { documentId: "doc-ready", documentFilename: "vacation.txt", chunkIndex: 2, score: 0.9125, text: "28 days" },
  ],
  tookMs: 96,
};

/** Every prop at its neutral value; a test overrides only what it drives. */
function buildProps(overrides: Partial<CorpusScreenViewProps> = {}): CorpusScreenViewProps {
  return {
    settings: SETTINGS,
    loadError: null,
    moduleUnavailable: false,
    onSave: vi.fn(),
    savePending: false,
    saveError: null,
    saved: false,
    datasets: DATASETS,
    datasetsError: null,
    selectedDatasetId: "ds-1",
    onSelectDataset: vi.fn(),
    onCreateDataset: vi.fn(),
    createPending: false,
    createError: null,
    onDeleteDataset: vi.fn(),
    deleteDatasetPendingId: null,
    deleteDatasetError: null,
    documents: DOCUMENTS,
    documentsError: null,
    onUploadDocument: vi.fn(),
    uploadPending: false,
    uploadError: null,
    onRetryDocument: vi.fn(),
    retryPendingId: null,
    retryError: null,
    onDeleteDocument: vi.fn(),
    deleteDocumentPendingId: null,
    deleteDocumentError: null,
    searchResult: null,
    searchPending: false,
    searchError: null,
    onSearch: vi.fn(),
    ...overrides,
  };
}

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
  vi.restoreAllMocks();
});

function render(overrides: Partial<CorpusScreenViewProps> = {}) {
  const props = buildProps(overrides);
  act(() => root.render(<CorpusScreenView {...props} />));
  return props;
}

function setInput(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(testid: string) {
  const node = container.querySelector(`[data-testid="${testid}"]`)!;
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return node as HTMLButtonElement;
}

function testidPresent(testid: string): boolean {
  return container.querySelector(`[data-testid="${testid}"]`) !== null;
}

describe("corpusConfig", () => {
  it("bounds integers against the settings contract", () => {
    expect(parseBoundedInt("25", 1, 200)).toEqual({ ok: true, value: 25 });
    expect(parseBoundedInt("0", 1, 200).ok).toBe(false);
    expect(parseBoundedInt("201", 1, 200).ok).toBe(false);
    expect(parseBoundedInt("", 1, 200).ok).toBe(false);
    expect(parseBoundedInt("2.5", 1, 200).ok).toBe(false);
  });

  it("accepts an empty parsing address or an absolute http(s) URL only", () => {
    expect(parsingBaseUrlValid("")).toBe(true);
    expect(parsingBaseUrlValid("  ")).toBe(true);
    expect(parsingBaseUrlValid("http://parsers.internal:8080")).toBe(true);
    expect(parsingBaseUrlValid("https://parsers.internal/base")).toBe(true);
    expect(parsingBaseUrlValid("parsers.internal:8080")).toBe(false);
    expect(parsingBaseUrlValid("ftp://parsers.internal")).toBe(false);
  });

  it("validates a dataset name", () => {
    expect(datasetNameValid("Regulations")).toBe(true);
    expect(datasetNameValid("   ")).toBe(false);
    expect(datasetNameValid("x".repeat(65))).toBe(false);
  });

  it("round-trips settings through the draft without dropping foreign keys", () => {
    const draft = draftFromSettings(SETTINGS);
    expect(draft).toEqual({
      enabled: true,
      parsingServiceBaseUrl: "http://parsers.internal:8080",
      embedderModel: "text-embedding-v4",
      maxUploadMb: "25",
      maxDocuments: "500",
      searchTopK: "5",
    });

    // The PUT is full-object: a key this screen does not own must survive.
    const base = { ...SETTINGS, workerPool: { size: 3 }, limits: { ...SETTINGS.limits, refillPerMin: 10 } };
    const saved = settingsFromDraft(draft, base);
    expect(saved).not.toBeNull();
    expect(saved).toEqual(base);
  });

  it("saves edited values and refuses an out-of-bounds draft", () => {
    const edited = settingsFromDraft(
      { ...draftFromSettings(SETTINGS), maxUploadMb: "50", searchTopK: "9", enabled: false },
      SETTINGS,
    );
    expect(edited).toEqual({
      ...SETTINGS,
      enabled: false,
      limits: { maxUploadMb: 50, maxDocumentsPerDataset: 500, searchTopK: 9 },
    });

    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), maxUploadMb: "0" }, SETTINGS)).toBeNull();
    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), searchTopK: "999" }, SETTINGS)).toBeNull();
    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), parsingServiceBaseUrl: "nope" }, SETTINGS)).toBeNull();
    expect(settingsFromDraft({ ...draftFromSettings(SETTINGS), embedderModel: "  " }, SETTINGS)).toBeNull();
  });

  it("labels statuses, ends the pipeline at ready/failed and splits byte units", () => {
    expect(statusLabelKey("embedding")).toBe("corpus.documents.status.embedding");
    expect(isTerminalStatus("ready")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("parsing")).toBe(false);
    expect(formatBytes(512)).toEqual({ value: "512", unitKey: "corpus.units.bytes" });
    expect(formatBytes(2048)).toEqual({ value: "2", unitKey: "corpus.units.kb" });
    expect(formatBytes(1024 * 1024)).toEqual({ value: "1.0", unitKey: "corpus.units.mb" });
    expect(CORPUS_POLL_INTERVAL_MS).toBe(4000);
    expect(scoreText(0.9126)).toBe("0.913");
    expect(documentAnchorHref("doc-1")).toBe("#corpus-document-doc-1");
  });
});

describe("CorpusScreenView", () => {
  it("renders the settings the server sent and saves an edit", () => {
    const props = render();
    expect(testidPresent("myrmidon-corpus-screen")).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-enabled")!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-parsing-base-url")!.value).toBe(
      SETTINGS.parsingServiceBaseUrl,
    );
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-embedder-model")!.value).toBe(SETTINGS.embedderModel);
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-max-upload-mb")!.value).toBe("25");
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-max-documents")!.value).toBe("500");
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-search-top-k")!.value).toBe("5");

    setInput("myrmidon-corpus-embedder-model", "text-embedding-v4-latest");
    setInput("myrmidon-corpus-max-upload-mb", "50");
    click("myrmidon-corpus-save");

    expect(props.onSave).toHaveBeenCalledWith({
      ...SETTINGS,
      embedderModel: "text-embedding-v4-latest",
      limits: { maxUploadMb: 50, maxDocumentsPerDataset: 500, searchTopK: 5 },
    });
  });

  it("blocks the save while a field violates the contract", () => {
    const props = render();
    setInput("myrmidon-corpus-max-upload-mb", "0");
    expect(testidPresent("myrmidon-corpus-max-upload-mb-error")).toBe(true);
    expect(click("myrmidon-corpus-save").disabled).toBe(true);
    click("myrmidon-corpus-save");
    expect(props.onSave).not.toHaveBeenCalled();

    setInput("myrmidon-corpus-parsing-base-url", "parsers.internal");
    expect(testidPresent("myrmidon-corpus-parsing-base-url-error")).toBe(true);
    expect(click("myrmidon-corpus-save").disabled).toBe(true);
  });

  it("shows an unavailable state when the module is not served here", () => {
    render({ moduleUnavailable: true, settings: undefined });
    expect(testidPresent("myrmidon-corpus-unavailable")).toBe(true);
    expect(testidPresent("myrmidon-corpus-settings")).toBe(false);
    expect(testidPresent("myrmidon-corpus-datasets")).toBe(false);
  });

  it("keeps the screen reachable with the module off, and stops the pipeline actions", () => {
    render({ settings: OFF_SETTINGS });
    expect(testidPresent("myrmidon-corpus-module-off")).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#myrmidon-corpus-enabled")!.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('[data-testid="myrmidon-corpus-upload-input"]')!.disabled).toBe(true);
    expect(click("myrmidon-corpus-document-retry-doc-failed").disabled).toBe(true);
    expect(click("myrmidon-corpus-search-submit").disabled).toBe(true);

    // Turning the switch back on is the way out, so the form stays usable.
    setInput("myrmidon-corpus-embedder-model", "text-embedding-v4");
    expect(click("myrmidon-corpus-save").disabled).toBe(false);
  });

  it("creates a dataset only with a name and deletes one after a confirmation", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = render();
    expect(click("myrmidon-corpus-dataset-create").disabled).toBe(true);
    setInput("myrmidon-corpus-new-dataset", "Handbook");
    click("myrmidon-corpus-dataset-create");
    expect(props.onCreateDataset).toHaveBeenCalledWith("Handbook");

    click("myrmidon-corpus-dataset-delete-ds-1");
    expect(confirmSpy).toHaveBeenCalled();
    expect(props.onDeleteDataset).toHaveBeenCalledWith("ds-1");

    confirmSpy.mockReturnValue(false);
    click("myrmidon-corpus-dataset-delete-ds-2");
    expect(props.onDeleteDataset).toHaveBeenCalledTimes(1);
  });

  it("renders the document list with its statuses and uploads a chosen file", () => {
    const props = render();
    expect(testidPresent("myrmidon-corpus-document-doc-ready")).toBe(true);
    expect(container.querySelector('[data-testid="myrmidon-corpus-document-status-doc-ready"]')!.textContent).toBe(
      "corpus.documents.status.ready",
    );
    expect(container.querySelector('[data-testid="myrmidon-corpus-document-status-doc-failed"]')!.textContent).toBe(
      "corpus.documents.status.failed",
    );
    // Retry belongs to a failed parse only.
    expect(testidPresent("myrmidon-corpus-document-retry-doc-ready")).toBe(false);
    expect(testidPresent("myrmidon-corpus-document-retry-doc-failed")).toBe(true);

    click("myrmidon-corpus-document-retry-doc-failed");
    expect(props.onRetryDocument).toHaveBeenCalledWith("doc-failed");

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const input = container.querySelector<HTMLInputElement>('[data-testid="myrmidon-corpus-upload-input"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onUploadDocument).toHaveBeenCalledWith(file);
  });

  it("says which dataset to pick while none is open", () => {
    render({ selectedDatasetId: null, documents: undefined });
    expect(testidPresent("myrmidon-corpus-documents-no-dataset")).toBe(true);
    expect(testidPresent("myrmidon-corpus-search-no-dataset")).toBe(true);
    expect(click("myrmidon-corpus-search-submit").disabled).toBe(true);
  });

  it("runs the trial search and shows score with a link to the document", () => {
    const props = render();
    expect(click("myrmidon-corpus-search-submit").disabled).toBe(true);
    setInput("myrmidon-corpus-search-query", "  vacation  ");
    click("myrmidon-corpus-search-submit");
    expect(props.onSearch).toHaveBeenCalledWith("vacation");

    render({ searchResult: SEARCH_RESULT });
    expect(testidPresent("myrmidon-corpus-search-results")).toBe(true);
    expect(container.querySelector('[data-testid="myrmidon-corpus-hit-score-0"]')!.textContent).toBe(
      "corpus.searchHitScore",
    );
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="myrmidon-corpus-hit-0"] a')!.getAttribute("href")).toBe(
      "#corpus-document-doc-ready",
    );
    expect(container.textContent).toContain("28 days");
  });

  it("reports an empty search result and a failed search", () => {
    render({
      searchResult: { datasetId: "ds-1", query: "nothing", hits: [], tookMs: 12 },
      searchError: "corpus.searchError",
    });
    expect(testidPresent("myrmidon-corpus-search-empty")).toBe(true);
    expect(testidPresent("myrmidon-corpus-search-error")).toBe(true);
    expect(container.querySelector('[data-testid="myrmidon-corpus-search-results"]')!.textContent).toContain(
      "corpus.searchResults",
    );
  });

  it("surfaces the read and action failures separately", () => {
    render({ datasetsError: "corpus.datasetsError", uploadError: "corpus.uploadError", saveError: "corpus.saveError" });
    expect(testidPresent("myrmidon-corpus-datasets-error")).toBe(true);
    expect(testidPresent("myrmidon-corpus-upload-error")).toBe(true);
    expect(testidPresent("myrmidon-corpus-save-error")).toBe(true);
    expect(testidPresent("myrmidon-corpus-saved")).toBe(false);
    expect(testidPresent("myrmidon-corpus-datasets-empty")).toBe(false);
  });
});