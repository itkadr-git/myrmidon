// myrmidon(1.6.6 CORPUS E): the "Knowledge corpus" screen — view tier.
// Layout and local draft state only; the react-query wiring lives in
// CorpusScreenContainer.tsx so tests can drive both tiers separately.
import { useRef, useState } from "react";
import { BookOpen, Database, FileText, Search } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CORPUS_MAX_DOCUMENTS_MAX,
  CORPUS_MAX_DOCUMENTS_MIN,
  CORPUS_MAX_UPLOAD_MB_MAX,
  CORPUS_MAX_UPLOAD_MB_MIN,
  CORPUS_SEARCH_TOP_K_MAX,
  CORPUS_SEARCH_TOP_K_MIN,
  type CorpusDataset,
  type CorpusDocument,
  type CorpusSearchResult,
  type CorpusSettings,
} from "./corpusApi";
import {
  CORPUS_DATASET_NAME_MAX,
  CORPUS_POLL_INTERVAL_MS,
  datasetNameValid,
  documentAnchorHref,
  documentAnchorId,
  draftFromSettings,
  formatBytes,
  isTerminalStatus,
  parseBoundedInt,
  parsingBaseUrlValid,
  scoreText,
  settingsFromDraft,
  statusLabelKey,
  timestampText,
  type CorpusSettingsDraft,
} from "./corpusConfig";

/** Badge tone of a parse status. */
function statusVariant(status: CorpusDocument["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ready") return "default";
  if (status === "failed") return "destructive";
  return isTerminalStatus(status) ? "outline" : "secondary";
}

export interface CorpusScreenViewProps {
  settings: CorpusSettings | null | undefined;
  /** Message of a failed settings read; the screen shows it instead of the form. */
  loadError: string | null;
  /** The module is off (or the server half is not deployed): no actions offered. */
  moduleUnavailable: boolean;
  onSave: (settings: CorpusSettings) => void;
  savePending: boolean;
  saveError: string | null;
  /** The last save landed and the settings were read back. */
  saved: boolean;

  datasets: CorpusDataset[] | undefined;
  datasetsError: string | null;
  selectedDatasetId: string | null;
  onSelectDataset: (datasetId: string) => void;
  onCreateDataset: (name: string) => void;
  createPending: boolean;
  createError: string | null;
  onDeleteDataset: (datasetId: string) => void;
  deleteDatasetPendingId: string | null;
  deleteDatasetError: string | null;

  documents: CorpusDocument[] | undefined;
  documentsError: string | null;
  onUploadDocument: (file: File) => void;
  uploadPending: boolean;
  uploadError: string | null;
  onRetryDocument: (documentId: string) => void;
  retryPendingId: string | null;
  retryError: string | null;
  onDeleteDocument: (documentId: string) => void;
  deleteDocumentPendingId: string | null;
  deleteDocumentError: string | null;

  searchResult: CorpusSearchResult | null;
  searchPending: boolean;
  searchError: string | null;
  onSearch: (query: string) => void;
}

export function CorpusScreenView({
  settings,
  loadError,
  moduleUnavailable,
  onSave,
  savePending,
  saveError,
  saved,
  datasets,
  datasetsError,
  selectedDatasetId,
  onSelectDataset,
  onCreateDataset,
  createPending,
  createError,
  onDeleteDataset,
  deleteDatasetPendingId,
  deleteDatasetError,
  documents,
  documentsError,
  onUploadDocument,
  uploadPending,
  uploadError,
  onRetryDocument,
  retryPendingId,
  retryError,
  onDeleteDocument,
  deleteDocumentPendingId,
  deleteDocumentError,
  searchResult,
  searchPending,
  searchError,
  onSearch,
}: CorpusScreenViewProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CorpusSettingsDraft | null>(null);
  const [datasetName, setDatasetName] = useState("");
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const current: CorpusSettingsDraft | null = draft ?? (settings ? draftFromSettings(settings) : null);
  const urlOk = current !== null && parsingBaseUrlValid(current.parsingServiceBaseUrl);
  const modelOk = current !== null && current.embedderModel.trim().length > 0;
  const maxUploadOk =
    current !== null &&
    parseBoundedInt(current.maxUploadMb, CORPUS_MAX_UPLOAD_MB_MIN, CORPUS_MAX_UPLOAD_MB_MAX).ok;
  const maxDocumentsOk =
    current !== null &&
    parseBoundedInt(current.maxDocuments, CORPUS_MAX_DOCUMENTS_MIN, CORPUS_MAX_DOCUMENTS_MAX).ok;
  const topKOk =
    current !== null && parseBoundedInt(current.searchTopK, CORPUS_SEARCH_TOP_K_MIN, CORPUS_SEARCH_TOP_K_MAX).ok;
  const draftOk = current !== null && urlOk && modelOk && maxUploadOk && maxDocumentsOk && topKOk;
  const nameOk = datasetNameValid(datasetName);
  const selectedDataset = (datasets ?? []).find((dataset) => dataset.id === selectedDatasetId) ?? null;
  // Parsing, embedding and search all need the module switch on; the settings
  // form and dataset management stay reachable so the switch can be turned back on.
  const pipelineOn = settings?.enabled === true;

  return (
    <div className="space-y-6" data-testid="myrmidon-corpus-screen">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("corpus.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("corpus.intro")}</p>
      </div>

      {loadError ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-corpus-load-error" role="alert">
          {loadError}
        </p>
      ) : null}

      {moduleUnavailable && !loadError ? (
        <div
          className="rounded-md border border-border bg-muted/40 px-3 py-3 text-sm"
          data-testid="myrmidon-corpus-unavailable"
        >
          <p className="font-medium">{t("corpus.unavailableTitle")}</p>
          <p className="mt-1 text-muted-foreground">{t("corpus.unavailableBody")}</p>
        </div>
      ) : null}

      {!moduleUnavailable && !loadError && current ? (
        <>
          <section className="space-y-4" data-testid="myrmidon-corpus-settings">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{t("corpus.settingsTitle")}</h3>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="myrmidon-corpus-enabled"
                type="checkbox"
                checked={current.enabled}
                onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
              />
              <Label htmlFor="myrmidon-corpus-enabled">{t("corpus.enabledLabel")}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{t("corpus.enabledHint")}</p>

            {!current.enabled ? (
              <p
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                data-testid="myrmidon-corpus-module-off"
              >
                {t("corpus.moduleOffNotice")}
              </p>
            ) : null}

            <div className="space-y-1">
              <Label htmlFor="myrmidon-corpus-parsing-base-url">{t("corpus.parsingBaseUrlLabel")}</Label>
              <Input
                id="myrmidon-corpus-parsing-base-url"
                className="max-w-md"
                placeholder="http://parsing:8080"
                aria-invalid={urlOk ? undefined : true}
                value={current.parsingServiceBaseUrl}
                onChange={(event) => setDraft({ ...current, parsingServiceBaseUrl: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("corpus.parsingBaseUrlHint")}</p>
              {!urlOk ? (
                <p className="text-xs text-destructive" data-testid="myrmidon-corpus-parsing-base-url-error">
                  {t("corpus.parsingBaseUrlError")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="myrmidon-corpus-embedder-model">{t("corpus.embedderModelLabel")}</Label>
              <Input
                id="myrmidon-corpus-embedder-model"
                className="max-w-md"
                aria-invalid={modelOk ? undefined : true}
                value={current.embedderModel}
                onChange={(event) => setDraft({ ...current, embedderModel: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("corpus.embedderModelHint")}</p>
              {!modelOk ? (
                <p className="text-xs text-destructive" data-testid="myrmidon-corpus-embedder-model-error">
                  {t("corpus.embedderModelError")}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="myrmidon-corpus-max-upload-mb">{t("corpus.maxUploadMbLabel")}</Label>
              <Input
                id="myrmidon-corpus-max-upload-mb"
                inputMode="numeric"
                className="max-w-xs"
                aria-invalid={maxUploadOk ? undefined : true}
                value={current.maxUploadMb}
                onChange={(event) => setDraft({ ...current, maxUploadMb: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t("corpus.boundsHint", {
                  min: CORPUS_MAX_UPLOAD_MB_MIN,
                  max: CORPUS_MAX_UPLOAD_MB_MAX,
                })}
              </p>
              {!maxUploadOk ? (
                <p className="text-xs text-destructive" data-testid="myrmidon-corpus-max-upload-mb-error">
                  {t("corpus.boundsError", { min: CORPUS_MAX_UPLOAD_MB_MIN, max: CORPUS_MAX_UPLOAD_MB_MAX })}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="myrmidon-corpus-max-documents">{t("corpus.maxDocumentsLabel")}</Label>
              <Input
                id="myrmidon-corpus-max-documents"
                inputMode="numeric"
                className="max-w-xs"
                aria-invalid={maxDocumentsOk ? undefined : true}
                value={current.maxDocuments}
                onChange={(event) => setDraft({ ...current, maxDocuments: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t("corpus.boundsHint", { min: CORPUS_MAX_DOCUMENTS_MIN, max: CORPUS_MAX_DOCUMENTS_MAX })}
              </p>
              {!maxDocumentsOk ? (
                <p className="text-xs text-destructive" data-testid="myrmidon-corpus-max-documents-error">
                  {t("corpus.boundsError", { min: CORPUS_MAX_DOCUMENTS_MIN, max: CORPUS_MAX_DOCUMENTS_MAX })}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="myrmidon-corpus-search-top-k">{t("corpus.searchTopKLabel")}</Label>
              <Input
                id="myrmidon-corpus-search-top-k"
                inputMode="numeric"
                className="max-w-xs"
                aria-invalid={topKOk ? undefined : true}
                value={current.searchTopK}
                onChange={(event) => setDraft({ ...current, searchTopK: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("corpus.searchTopKHint")}</p>
              {!topKOk ? (
                <p className="text-xs text-destructive" data-testid="myrmidon-corpus-search-top-k-error">
                  {t("corpus.boundsError", { min: CORPUS_SEARCH_TOP_K_MIN, max: CORPUS_SEARCH_TOP_K_MAX })}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                disabled={!draftOk || savePending}
                data-testid="myrmidon-corpus-save"
                onClick={() => {
                  const next = settingsFromDraft(current, settings);
                  if (next) onSave(next);
                }}
              >
                {savePending ? t("corpus.saving") : t("corpus.save")}
              </Button>
              {saved && !saveError ? (
                <span className="text-xs text-muted-foreground" data-testid="myrmidon-corpus-saved">
                  {t("corpus.saved")}
                </span>
              ) : null}
            </div>

            {saveError ? (
              <p className="text-sm text-destructive" data-testid="myrmidon-corpus-save-error" role="alert">
                {saveError}
              </p>
            ) : null}
          </section>

          <section className="space-y-3" data-testid="myrmidon-corpus-datasets">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{t("corpus.datasetsTitle")}</h3>
            </div>

            {datasetsError ? (
              <p className="text-sm text-destructive" data-testid="myrmidon-corpus-datasets-error" role="alert">
                {datasetsError}
              </p>
            ) : null}

            {!datasetsError && (datasets ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="myrmidon-corpus-datasets-empty">
                {t("corpus.datasetsEmpty")}
              </p>
            ) : null}

            <ul className="space-y-1">
              {(datasets ?? []).map((dataset) => (
                <li key={dataset.id} className="flex items-center gap-2" data-testid={`myrmidon-corpus-dataset-${dataset.id}`}>
                  <Button
                    type="button"
                    variant={dataset.id === selectedDatasetId ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => onSelectDataset(dataset.id)}
                  >
                    {dataset.name}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("corpus.datasetsDocuments", { count: dataset.documentCount })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={deleteDatasetPendingId === dataset.id}
                    data-testid={`myrmidon-corpus-dataset-delete-${dataset.id}`}
                    onClick={() => {
                      if (window.confirm(t("corpus.datasetsDeleteConfirm", { name: dataset.name }))) {
                        onDeleteDataset(dataset.id);
                      }
                    }}
                  >
                    {t("corpus.datasetsDelete")}
                  </Button>
                </li>
              ))}
            </ul>

            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="myrmidon-corpus-new-dataset">{t("corpus.datasetsNewLabel")}</Label>
                <Input
                  id="myrmidon-corpus-new-dataset"
                  className="max-w-sm"
                  maxLength={CORPUS_DATASET_NAME_MAX}
                  aria-invalid={datasetName.length > 0 && !nameOk ? true : undefined}
                  value={datasetName}
                  onChange={(event) => setDatasetName(event.target.value)}
                />
              </div>
              <Button
                type="button"
                disabled={!nameOk || createPending}
                data-testid="myrmidon-corpus-dataset-create"
                onClick={() => {
                  onCreateDataset(datasetName.trim());
                  setDatasetName("");
                }}
              >
                {createPending ? t("corpus.datasetsCreating") : t("corpus.datasetsCreate")}
              </Button>
            </div>

            {createError ? (
              <p className="text-sm text-destructive" data-testid="myrmidon-corpus-dataset-create-error" role="alert">
                {createError}
              </p>
            ) : null}
            {deleteDatasetError ? (
              <p className="text-sm text-destructive" data-testid="myrmidon-corpus-dataset-delete-error" role="alert">
                {deleteDatasetError}
              </p>
            ) : null}
          </section>

          <section className="space-y-3" data-testid="myrmidon-corpus-documents">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">
                {selectedDataset ? t("corpus.documentsTitle", { name: selectedDataset.name }) : t("corpus.documentsTitleNoDataset")}
              </h3>
            </div>

            {!selectedDataset ? (
              <p className="text-sm text-muted-foreground" data-testid="myrmidon-corpus-documents-no-dataset">
                {t("corpus.documentsNoDataset")}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInput}
                    id="myrmidon-corpus-upload"
                    type="file"
                    accept=".txt,.md,.markdown,.pdf"
                    disabled={uploadPending || !pipelineOn}
                    data-testid="myrmidon-corpus-upload-input"
                    onChange={(event) => {
                      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
                      if (file) onUploadDocument(file);
                      if (fileInput.current) fileInput.current.value = "";
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {uploadPending
                      ? t("corpus.uploading")
                      : t("corpus.uploadHint", { mb: settings?.limits.maxUploadMb ?? CORPUS_MAX_UPLOAD_MB_MAX })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("corpus.documentsPolling", { seconds: Math.round(CORPUS_POLL_INTERVAL_MS / 1000) })}
                  </span>
                </div>

                {uploadError ? (
                  <p className="text-sm text-destructive" data-testid="myrmidon-corpus-upload-error" role="alert">
                    {uploadError}
                  </p>
                ) : null}
                {documentsError ? (
                  <p className="text-sm text-destructive" data-testid="myrmidon-corpus-documents-error" role="alert">
                    {documentsError}
                  </p>
                ) : null}
                {!documentsError && (documents ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="myrmidon-corpus-documents-empty">
                    {t("corpus.documentsEmpty")}
                  </p>
                ) : null}

                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1">{t("corpus.documentsColumnFile")}</th>
                      <th className="py-1">{t("corpus.documentsColumnStatus")}</th>
                      <th className="py-1">{t("corpus.documentsColumnChunks")}</th>
                      <th className="py-1">{t("corpus.documentsColumnSize")}</th>
                      <th className="py-1">{t("corpus.documentsColumnUpdated")}</th>
                      <th className="py-1">{t("corpus.documentsColumnActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(documents ?? []).map((document) => {
                      const size = formatBytes(document.sizeBytes);
                      return (
                        <tr key={document.id} id={documentAnchorId(document.id)} data-testid={`myrmidon-corpus-document-${document.id}`}>
                          <td className="py-1">{document.filename}</td>
                          <td className="py-1">
                            <Badge variant={statusVariant(document.status)} data-testid={`myrmidon-corpus-document-status-${document.id}`}>
                              {t(statusLabelKey(document.status))}
                            </Badge>
                            {document.error ? (
                              <span className="ml-2 text-xs text-destructive">{document.error}</span>
                            ) : null}
                          </td>
                          <td className="py-1">{document.chunkCount}</td>
                          <td className="py-1">
                            {size.value} {t(size.unitKey)}
                          </td>
                          <td className="py-1">{timestampText(document.updatedAt)}</td>
                          <td className="flex items-center gap-2 py-1">
                            {document.status === "failed" ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                disabled={retryPendingId === document.id || !pipelineOn}
                                data-testid={`myrmidon-corpus-document-retry-${document.id}`}
                                onClick={() => onRetryDocument(document.id)}
                              >
                                {retryPendingId === document.id ? t("corpus.retrying") : t("corpus.retry")}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={deleteDocumentPendingId === document.id}
                              data-testid={`myrmidon-corpus-document-delete-${document.id}`}
                              onClick={() => {
                                if (window.confirm(t("corpus.documentsDeleteConfirm", { name: document.filename }))) {
                                  onDeleteDocument(document.id);
                                }
                              }}
                            >
                              {t("corpus.documentsDelete")}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {retryError ? (
                  <p className="text-sm text-destructive" data-testid="myrmidon-corpus-document-retry-error" role="alert">
                    {retryError}
                  </p>
                ) : null}
                {deleteDocumentError ? (
                  <p className="text-sm text-destructive" data-testid="myrmidon-corpus-document-delete-error" role="alert">
                    {deleteDocumentError}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section className="space-y-3" data-testid="myrmidon-corpus-search">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{t("corpus.searchTitle")}</h3>
            </div>
            <p className="text-xs text-muted-foreground">{t("corpus.searchHint")}</p>

            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="myrmidon-corpus-search-query">{t("corpus.searchQueryLabel")}</Label>
                <Input
                  id="myrmidon-corpus-search-query"
                  className="max-w-md"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button
                type="button"
                disabled={!selectedDataset || !pipelineOn || query.trim().length === 0 || searchPending}
                data-testid="myrmidon-corpus-search-submit"
                onClick={() => onSearch(query.trim())}
              >
                {searchPending ? t("corpus.searchRunning") : t("corpus.searchSubmit")}
              </Button>
            </div>

            {!selectedDataset ? (
              <p className="text-sm text-muted-foreground" data-testid="myrmidon-corpus-search-no-dataset">
                {t("corpus.searchNoDataset")}
              </p>
            ) : null}
            {searchError ? (
              <p className="text-sm text-destructive" data-testid="myrmidon-corpus-search-error" role="alert">
                {searchError}
              </p>
            ) : null}

            {searchResult ? (
              <div className="space-y-2" data-testid="myrmidon-corpus-search-results">
                <p className="text-xs text-muted-foreground">
                  {t("corpus.searchResults", { count: searchResult.hits.length })}
                  {searchResult.tookMs !== null ? ` ${t("corpus.searchTook", { ms: searchResult.tookMs })}` : ""}
                </p>
                {searchResult.hits.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="myrmidon-corpus-search-empty">
                    {t("corpus.searchEmpty")}
                  </p>
                ) : null}
                <ul className="space-y-2">
                  {searchResult.hits.map((hit, index) => (
                    <li
                      key={`${hit.documentId}:${hit.chunkIndex}`}
                      className="rounded-md border border-border px-3 py-2"
                      data-testid={`myrmidon-corpus-hit-${index}`}
                    >
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <a className="underline" href={documentAnchorHref(hit.documentId)}>
                          {hit.documentFilename}
                        </a>
                        <span>{t("corpus.searchHitChunk", { index: hit.chunkIndex })}</span>
                        <span data-testid={`myrmidon-corpus-hit-score-${index}`}>
                          {t("corpus.searchHitScore", { score: scoreText(hit.score) })}
                        </span>
                      </div>
                      <p className="mt-1 text-sm whitespace-pre-wrap">{hit.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}