// myrmidon(1.6.6 CORPUS E): client-tier tests for corpusApi.
//
// The server half of the module (part C) is not merged yet, so the transport is
// mocked and the assertions are on the requests themselves: the frozen paths,
// the full-object PUT body, the multipart upload and the search body.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORPUS_PENDING_STATUSES,
  corpusApi,
  corpusDatasetsQueryKey,
  corpusDocumentsQueryKey,
  corpusSettingsQueryKey,
  hasPendingDocuments,
  type CorpusDocument,
  type CorpusSettings,
} from "./corpusApi";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/api/client", () => ({ api: apiMock }));

const COMPANY = "c-1";
const BASE = "/myrmidon/companies/c-1/corpus";

const SETTINGS: CorpusSettings = {
  enabled: true,
  parsingServiceBaseUrl: "http://parsers.internal:8080",
  embedderModel: "text-embedding-v4",
  limits: { maxUploadMb: 25, maxDocumentsPerDataset: 500, searchTopK: 5 },
};

beforeEach(() => {
  apiMock.get.mockReset().mockResolvedValue(undefined);
  apiMock.post.mockReset().mockResolvedValue(undefined);
  apiMock.postForm.mockReset().mockResolvedValue(undefined);
  apiMock.put.mockReset().mockResolvedValue(undefined);
  apiMock.delete.mockReset().mockResolvedValue(undefined);
});

describe("myrmidon(1.6.6 CORPUS E) corpus api", () => {
  it("reads the settings block from the frozen route", async () => {
    apiMock.get.mockResolvedValue(SETTINGS);
    await expect(corpusApi.getSettings(COMPANY)).resolves.toEqual(SETTINGS);
    expect(apiMock.get).toHaveBeenCalledWith(`${BASE}/settings`);
  });

  it("writes the whole settings object back", async () => {
    // Full-object PUT: fields the screen does not know about must survive a save.
    const withExtra = { ...SETTINGS, workerPool: 2 };
    await corpusApi.putSettings(COMPANY, withExtra);
    expect(apiMock.put).toHaveBeenCalledWith(`${BASE}/settings`, withExtra);
  });

  it("lists, creates and deletes datasets", async () => {
    await corpusApi.listDatasets(COMPANY);
    expect(apiMock.get).toHaveBeenCalledWith(`${BASE}/datasets`);

    await corpusApi.createDataset(COMPANY, "runbooks");
    expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/datasets`, { name: "runbooks" });

    await corpusApi.deleteDataset(COMPANY, "ds-1");
    expect(apiMock.delete).toHaveBeenCalledWith(`${BASE}/datasets/ds-1`);
  });

  it("escapes ids that carry path separators", async () => {
    await corpusApi.listDocuments(COMPANY, "ds/1");
    expect(apiMock.get).toHaveBeenCalledWith(`${BASE}/datasets/ds%2F1/documents`);
    await corpusApi.search(COMPANY, "ds/1", "q", 3);
    expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/datasets/ds%2F1/search`, { query: "q", topK: 3 });
  });

  it("uploads a file as multipart with the dataset id", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await corpusApi.uploadDocument(COMPANY, "ds-1", file);
    expect(apiMock.postForm).toHaveBeenCalledTimes(1);
    const [path, body] = apiMock.postForm.mock.calls[0] as [string, FormData];
    expect(path).toBe(`${BASE}/documents`);
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("datasetId")).toBe("ds-1");
    expect(body.get("file")).toBe(file);
  });

  it("retries and deletes a document", async () => {
    await corpusApi.retryDocument(COMPANY, "doc-1");
    expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/documents/doc-1/retry`, {});
    await corpusApi.deleteDocument(COMPANY, "doc-1");
    expect(apiMock.delete).toHaveBeenCalledWith(`${BASE}/documents/doc-1`);
  });

  it("searches a dataset with the query and the chunk count", async () => {
    await corpusApi.search(COMPANY, "ds-1", "how do we release?", 5);
    expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/datasets/ds-1/search`, {
      query: "how do we release?",
      topK: 5,
    });
  });

  it("polls only while a document is still moving", () => {
    const doc = (status: CorpusDocument["status"]): CorpusDocument => ({
      id: `doc-${status}`,
      datasetId: "ds-1",
      filename: `${status}.txt`,
      status,
      sizeBytes: 10,
      chunkCount: 0,
      error: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    });

    expect(CORPUS_PENDING_STATUSES).toEqual(["queued", "parsing", "embedding"]);
    expect(hasPendingDocuments(undefined)).toBe(false);
    expect(hasPendingDocuments([])).toBe(false);
    expect(hasPendingDocuments([doc("ready"), doc("failed")])).toBe(false);
    expect(hasPendingDocuments([doc("ready"), doc("embedding")])).toBe(true);
    expect(hasPendingDocuments([doc("queued")])).toBe(true);
  });

  it("keys every cache entry by company (and dataset)", () => {
    expect(corpusSettingsQueryKey(COMPANY)).toEqual(["myrmidon", "corpus", "settings", COMPANY]);
    expect(corpusDatasetsQueryKey(COMPANY)).toEqual(["myrmidon", "corpus", "datasets", COMPANY]);
    expect(corpusDocumentsQueryKey(COMPANY, "ds-1")).toEqual([
      "myrmidon",
      "corpus",
      "documents",
      COMPANY,
      "ds-1",
    ]);
  });
});