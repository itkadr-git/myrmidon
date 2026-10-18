// myrmidon(LICENSING): the "Licensing" section of Instance → General.
// Two halves for the installation owner (instance admin; the server answers
// 403 to anyone else and the panel then renders nothing):
//   1. what a client sends: the installation id and a one-click "copy license
//      request" (MYRQ1 blob) built by the server;
//   2. what the owner does: paste a client's request (or type an id), pick
//      modules and a term, and get a signed license to copy or download. The
//      issuer key stays on the server; this panel never sees it.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";
import {
  LICENSE_MODULES,
  licensingApi,
  licensingIssuedQueryKey,
  licensingStatusQueryKey,
  type IssuedLicense,
} from "./licensingApi";

function formatExpiry(seconds: number | null, neverLabel: string): string {
  if (seconds === null) return neverLabel;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function ModuleChecks({
  selected,
  onChange,
  idPrefix,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {LICENSE_MODULES.map((module) => (
        <label key={module} className="flex items-center gap-1.5 text-sm" htmlFor={`${idPrefix}-${module}`}>
          <input
            id={`${idPrefix}-${module}`}
            type="checkbox"
            data-testid={`${idPrefix}-${module}`}
            checked={selected.includes(module)}
            onChange={(event) =>
              onChange(event.target.checked ? [...selected, module] : selected.filter((m) => m !== module))
            }
          />
          <span className="font-mono">{module}</span>
        </label>
      ))}
    </div>
  );
}

export function LicensingSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [requestModules, setRequestModules] = useState<string[]>([...LICENSE_MODULES]);
  const [copied, setCopied] = useState<"request" | "license" | null>(null);

  const [pasted, setPasted] = useState("");
  const [manualId, setManualId] = useState("");
  const [issueModules, setIssueModules] = useState<string[]>([]);
  const [days, setDays] = useState("365");
  const [noExpiry, setNoExpiry] = useState(false);
  const [client, setClient] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedLicense | null>(null);

  const statusQuery = useQuery({
    queryKey: [...licensingStatusQueryKey, requestModules.join(",")],
    queryFn: () => licensingApi.status(requestModules),
    retry: false,
  });
  const issuedQuery = useQuery({
    queryKey: licensingIssuedQueryKey,
    queryFn: () => licensingApi.issued(),
    retry: false,
    enabled: statusQuery.isSuccess,
  });

  const parseMutation = useMutation({
    mutationFn: (text: string) => licensingApi.parseRequest(text),
    onSuccess: (parsed) => {
      setFormError(null);
      setManualId(parsed.instanceId);
      if (parsed.modules.length > 0) setIssueModules(parsed.modules);
    },
    onError: () => setFormError(t("licensing.notARequest")),
  });

  const issueMutation = useMutation({
    mutationFn: () =>
      licensingApi.issue({
        ...(pasted.trim() ? { request: pasted.trim() } : { instanceId: manualId.trim() }),
        modules: issueModules,
        days: noExpiry ? null : Number(days),
        watermark: client.trim() ? client.trim() : null,
      }),
    onSuccess: (result) => {
      setFormError(null);
      setIssued(result);
      void queryClient.invalidateQueries({ queryKey: licensingIssuedQueryKey });
    },
    onError: (error: unknown) => {
      setIssued(null);
      if (error instanceof ApiError && error.status === 409) setFormError(t("licensing.issuerNotConfigured"));
      else if (error instanceof ApiError && error.status === 422) setFormError(t("licensing.notARequest"));
      else setFormError(t("licensing.issueFailed"));
    },
  });

  const status = statusQuery.data;
  const daysValid = noExpiry || (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650);
  const hasTarget = pasted.trim().length > 0 || manualId.trim().length > 0;
  const canIssue = hasTarget && issueModules.length > 0 && daysValid && !!status?.issuerConfigured;

  const downloadHref = useMemo(
    () => (issued ? `data:text/plain;charset=utf-8,${encodeURIComponent(issued.license + "\n")}` : null),
    [issued],
  );

  async function copy(text: string, kind: "request" | "license") {
    try {
      await copyTextToClipboard(text);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  }

  // Not an instance admin (403) or the API is unavailable: show nothing.
  if (statusQuery.isError) return null;
  if (!status) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="licensing-loading">
        {t("licensing.loading")}
      </p>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="licensing-panel">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("licensing.title")}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t("licensing.description")}</p>

      <div className="space-y-2">
        <p className="text-sm">
          <span className="font-medium">{t("licensing.installId")}</span>{" "}
          <span className="font-mono" data-testid="licensing-install-id">
            {status.installId}
          </span>
        </p>
        {status.source !== "machine-id" && (
          <p className="text-xs text-destructive" data-testid="licensing-source-warning">
            {status.source === "env" ? t("licensing.sourceEnv") : t("licensing.sourceGenerated")}
          </p>
        )}
        <div className="space-y-1">
          <Label>{t("licensing.requestModules")}</Label>
          <ModuleChecks selected={requestModules} onChange={setRequestModules} idPrefix="licensing-req" />
        </div>
        <Textarea
          readOnly
          rows={2}
          className="font-mono text-xs"
          value={status.request}
          data-testid="licensing-request-text"
          aria-label={t("licensing.requestLabel")}
        />
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copy(status.request, "request")}
            data-testid="licensing-copy-request"
          >
            {t("licensing.copyRequest")}
          </Button>
          {copied === "request" && <span className="text-xs text-muted-foreground">{t("licensing.copied")}</span>}
        </div>
      </div>

      <div className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-medium">{t("licensing.issueTitle")}</h4>
        {!status.issuerConfigured && (
          <p className="text-sm text-destructive" data-testid="licensing-issuer-missing">
            {t("licensing.issuerNotConfigured")}
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="licensing-paste">{t("licensing.pasteLabel")}</Label>
          <Textarea
            id="licensing-paste"
            rows={2}
            className="font-mono text-xs"
            placeholder="MYRQ1.…"
            value={pasted}
            data-testid="licensing-paste"
            onChange={(event) => {
              const value = event.target.value;
              setPasted(value);
              setFormError(null);
              if (value.trim()) parseMutation.mutate(value.trim());
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="licensing-manual-id">{t("licensing.manualId")}</Label>
          <Input
            id="licensing-manual-id"
            className="font-mono"
            placeholder="myr-…"
            value={manualId}
            data-testid="licensing-manual-id"
            onChange={(event) => {
              setManualId(event.target.value);
              setPasted("");
            }}
          />
        </div>
        <div className="space-y-1">
          <Label>{t("licensing.modules")}</Label>
          <ModuleChecks selected={issueModules} onChange={setIssueModules} idPrefix="licensing-issue" />
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="licensing-days">{t("licensing.days")}</Label>
            <Input
              id="licensing-days"
              className="w-28"
              inputMode="numeric"
              value={days}
              disabled={noExpiry}
              data-testid="licensing-days"
              onChange={(event) => setDays(event.target.value)}
            />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm">
            <input
              type="checkbox"
              checked={noExpiry}
              data-testid="licensing-no-expiry"
              onChange={(event) => setNoExpiry(event.target.checked)}
            />
            {t("licensing.noExpiry")}
          </label>
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="licensing-client">{t("licensing.client")}</Label>
            <Input
              id="licensing-client"
              maxLength={80}
              value={client}
              data-testid="licensing-client"
              onChange={(event) => setClient(event.target.value)}
            />
          </div>
        </div>
        {formError && (
          <p className="text-sm text-destructive" data-testid="licensing-error">
            {formError}
          </p>
        )}
        <Button
          size="sm"
          disabled={!canIssue || issueMutation.isPending}
          onClick={() => issueMutation.mutate()}
          data-testid="licensing-issue"
        >
          {issueMutation.isPending ? t("licensing.issuing") : t("licensing.issue")}
        </Button>

        {issued && (
          <div className="space-y-2" data-testid="licensing-result">
            <Label>{t("licensing.resultLabel")}</Label>
            <Textarea readOnly rows={4} className="font-mono text-xs" value={issued.license} data-testid="licensing-license-text" />
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" onClick={() => void copy(issued.license, "license")} data-testid="licensing-copy-license">
                {t("licensing.copyLicense")}
              </Button>
              {downloadHref && (
                <a
                  href={downloadHref}
                  download="license.key"
                  className="text-sm underline underline-offset-2"
                  data-testid="licensing-download"
                >
                  {t("licensing.download")}
                </a>
              )}
              {copied === "license" && <span className="text-xs text-muted-foreground">{t("licensing.copied")}</span>}
            </div>
            <p className="text-xs text-muted-foreground">{t("licensing.installHint")}</p>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-medium">{t("licensing.issuedTitle")}</h4>
        {(issuedQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="licensing-issued-empty">
            {t("licensing.issuedEmpty")}
          </p>
        ) : (
          <ul className="space-y-1" data-testid="licensing-issued-list">
            {(issuedQuery.data ?? []).map((row) => (
              <li key={row.id} className="rounded-md border px-3 py-2 text-xs" data-testid="licensing-issued-row">
                <span className="font-mono">{row.instanceId}</span> · {row.modules.join(", ")} ·{" "}
                {t("licensing.until", { date: formatExpiry(row.expires, t("licensing.noExpiry")) })}
                {row.watermark ? ` · ${row.watermark}` : ""} · {row.issuedAt.slice(0, 10)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
