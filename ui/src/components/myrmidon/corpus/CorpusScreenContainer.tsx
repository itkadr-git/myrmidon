// myrmidon(1.6.6 CORPUS E): wire tier of the "Knowledge corpus" screen. Owns the
// react-query state (settings, datasets, documents, trial search) and the error
// surface; the layout lives in CorpusScreen.tsx.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { CorpusScreenView } from "./CorpusScreen";
import {
  corpusApi,
  corpusDatasetsQueryKey,
  corpusDocumentsQueryKey,
  corpusSettingsQueryKey,
  hasPendingDocuments,
  type CorpusSearchResult,
  type CorpusSettings,
} from "./corpusApi";
import { CORPUS_POLL_INTERVAL_MS } from "./corpusConfig";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/**
 * A server that does not serve the corpus routes at all answers 404 (routes
 * absent), 501 (module compiled out) or 503 (module off); all three mean "the
 * module is not available here", which is not a failure of the screen.
 */
function moduleMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501 || error.status === 503);
}

export function CorpusScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteDatasetError, setDeleteDatasetError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [deleteDocumentError, setDeleteDocumentError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<CorpusSearchResult | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("corpus.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const settingsQuery = useQuery({
    queryKey: corpusSettingsQueryKey(companyId),
    queryFn: () => corpusApi.getSettings(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });
  const settings = settingsQuery.data;
  // The route is served only while the module runs, so its presence is the gate.
  const moduleUnavailable = settingsQuery.isError && moduleMissing(settingsQuery.error);
  const loadError = settingsQuery.isError && !moduleUnavailable ? readable(settingsQuery.error) : null;

  const datasetsQuery = useQuery({
    queryKey: corpusDatasetsQueryKey(companyId),
    queryFn: () => corpusApi.listDatasets(companyId),
    enabled: companyId.length > 0 && settings?.enabled === true,
    retry: false,
  });
  const datasets = datasetsQuery.data;

  // Keep a dataset open: the first one after a load, and never a deleted one.
  useEffect(() => {
    if (!datasets) return;
    const known = datasets.some((dataset) => dataset.id === selectedDatasetId);
    if (!known) {
      setSelectedDatasetId(datasets.length > 0 && datasets[0] ? datasets[0].id : null);
      setSearchResult(null);
    }
  }, [datasets, selectedDatasetId]);

  const documentsQuery = useQuery({
    queryKey: corpusDocumentsQueryKey(companyId, selectedDatasetId ?? ""),
    queryFn: () => corpusApi.listDocuments(companyId, selectedDatasetId ?? ""),
    enabled: companyId.length > 0 && selectedDatasetId !== null && settings?.enabled === true,
    retry: false,
    // Parsing and embedding move in the background: while a document is not
    // terminal the list refreshes itself, so `ready` appears without a reload.
    refetchInterval: (query) =>
      hasPendingDocuments(query.state.data) ? CORPUS_POLL_INTERVAL_MS : false,
  });

  const save = useMutation({
    mutationFn: (next: CorpusSettings) => corpusApi.putSettings(companyId, next),
    onMutate: () => {
      setSaveError(null);
      setSaved(false);
    },
    onSuccess: async () => {
      setSaveError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: corpusSettingsQueryKey(companyId) });
    },
    onError: (error) => setSaveError(readable(error)),
  });

  const createDataset = useMutation({
    mutationFn: (name: string) => corpusApi.createDataset(companyId, name),
    onMutate: () => setCreateError(null),
    onSuccess: async (dataset) => {
      setCreateError(null);
      setSelectedDatasetId(dataset.id);
      await queryClient.invalidateQueries({ queryKey: corpusDatasetsQueryKey(companyId) });
    },
    onError: (error) => setCreateError(readable(error)),
  });

  const deleteDataset = useMutation({
    mutationFn: (datasetId: string) => corpusApi.deleteDataset(companyId, datasetId),
    onMutate: () => setDeleteDatasetError(null),
    onSuccess: async () => {
      setDeleteDatasetError(null);
      await queryClient.invalidateQueries({ queryKey: corpusDatasetsQueryKey(companyId) });
    },
    onError: (error) => setDeleteDatasetError(readable(error)),
  });

  const upload = useMutation({
    mutationFn: (file: File) => corpusApi.uploadDocument(companyId, selectedDatasetId ?? "", file),
    onMutate: () => setUploadError(null),
    onSuccess: async () => {
      setUploadError(null);
      await queryClient.invalidateQueries({
        queryKey: corpusDocumentsQueryKey(companyId, selectedDatasetId ?? ""),
      });
    },
    onError: (error) => setUploadError(readable(error)),
  });

  const retry = useMutation({
    mutationFn: (documentId: string) => corpusApi.retryDocument(companyId, documentId),
    onMutate: () => setRetryError(null),
    onSuccess: async () => {
      setRetryError(null);
      await queryClient.invalidateQueries({
        queryKey: corpusDocumentsQueryKey(companyId, selectedDatasetId ?? ""),
      });
    },
    onError: (error) => setRetryError(readable(error)),
  });

  const deleteDocument = useMutation({
    mutationFn: (documentId: string) => corpusApi.deleteDocument(companyId, documentId),
    onMutate: () => setDeleteDocumentError(null),
    onSuccess: async () => {
      setDeleteDocumentError(null);
      await queryClient.invalidateQueries({
        queryKey: corpusDocumentsQueryKey(companyId, selectedDatasetId ?? ""),
      });
    },
    onError: (error) => setDeleteDocumentError(readable(error)),
  });

  const search = useMutation({
    mutationFn: (query: string) =>
      corpusApi.search(companyId, selectedDatasetId ?? "", query, settings?.limits.searchTopK ?? 5),
    onMutate: () => {
      setSearchError(null);
      setSearchResult(null);
    },
    onSuccess: (result) => setSearchResult(result),
    onError: (error) => setSearchError(readable(error)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-corpus-no-company">
        {t("corpus.noCompany")}
      </p>
    );
  }

  return (
    <CorpusScreenView
      settings={settings}
      loadError={loadError}
      moduleUnavailable={moduleUnavailable}
      onSave={(next) => save.mutate(next)}
      savePending={save.isPending}
      saveError={saveError}
      saved={saved}
      datasets={datasets}
      datasetsError={datasetsQuery.isError ? readable(datasetsQuery.error) : datasetsError}
      selectedDatasetId={selectedDatasetId}
      onSelectDataset={(datasetId) => {
        setSelectedDatasetId(datasetId);
        setSearchResult(null);
        setSearchError(null);
      }}
      onCreateDataset={(name) => createDataset.mutate(name)}
      createPending={createDataset.isPending}
      createError={createError}
      onDeleteDataset={(datasetId) => deleteDataset.mutate(datasetId)}
      deleteDatasetPendingId={deleteDataset.isPending ? (deleteDataset.variables ?? null) : null}
      deleteDatasetError={deleteDatasetError}
      documents={documentsQuery.data}
      documentsError={documentsQuery.isError ? readable(documentsQuery.error) : null}
      onUploadDocument={(file) => upload.mutate(file)}
      uploadPending={upload.isPending}
      uploadError={uploadError}
      onRetryDocument={(documentId) => retry.mutate(documentId)}
      retryPendingId={retry.isPending ? (retry.variables ?? null) : null}
      retryError={retryError}
      onDeleteDocument={(documentId) => deleteDocument.mutate(documentId)}
      deleteDocumentPendingId={deleteDocument.isPending ? (deleteDocument.variables ?? null) : null}
      deleteDocumentError={deleteDocumentError}
      searchResult={searchResult}
      searchPending={search.isPending}
      searchError={searchError}
      onSearch={(query) => search.mutate(query)}
    />
  );
}