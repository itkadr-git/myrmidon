// myrmidon(LICENSING): the "Licenses" screen of the instance settings, the
// client side of closed-module licensing (instance admin; anyone else gets
// 403 from the server and the panel renders nothing):
//   1. the installation id and a one-click "copy license request" (MYRQ1,
//      the closed modules of this installation);
//   2. what each closed module decides about the current license — computed
//      by the server from the same source the modules read;
//   3. installing a license: paste the MYR1 line or load license.key; the
//      server checks it and writes it where the modules read it.
import { useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";
import {
  LICENSE_MODULES,
  formatLicenseDate,
  licensingApi,
  licensingStatusQueryKey,
  type LicensingStatus,
  type ModuleLicenseStatus,
} from "./licensingApi";

const STATE_TONE: Record<ModuleLicenseStatus["state"], string> = {
  valid: "text-green-700 dark:text-green-400",
  expiring: "text-amber-700 dark:text-amber-400",
  expired: "text-destructive",
  wrong_instance: "text-destructive",
  missing: "text-destructive",
  not_granted: "text-destructive",
  bad_signature: "text-destructive",
  invalid: "text-destructive",
};

const SAVE_ERROR_KEYS: Record<string, string> = {
  license_bad_format: "licensing.saveError.badFormat",
  license_bad_payload: "licensing.saveError.badPayload",
  license_bad_signature: "licensing.saveError.badSignature",
  license_unsupported_rev: "licensing.saveError.unsupportedRev",
  license_instance_mismatch: "licensing.saveError.instanceMismatch",
  license_expired: "licensing.saveError.expired",
  license_feature_not_granted: "licensing.saveError.noCore",
  license_env_override: "licensing.saveError.envOverride",
  license_path_unwritable: "licensing.saveError.unwritable",
};

function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: unknown } | null;
  return body && typeof body.code === "string" ? body.code : null;
}

function mismatchIds(error: unknown): { licenseId: string; boardId: string } | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.body as { details?: { licenseInstanceId?: unknown; boardInstanceId?: unknown } } | null)?.details;
  if (typeof details?.licenseInstanceId === "string" && typeof details?.boardInstanceId === "string") {
    return { licenseId: details.licenseInstanceId, boardId: details.boardInstanceId };
  }
  return null;
}

type Translate = ReturnType<typeof useTranslation>["t"];

export function moduleStateLabel(t: Translate, status: ModuleLicenseStatus): string {
  if (status.state === "valid") {
    return status.expires === null
      ? t("licensing.state.validForever")
      : t("licensing.state.validUntil", { date: formatLicenseDate(status.expires) });
  }
  if (status.state === "expiring" && status.expires !== null) {
    return t("licensing.state.expiring", { date: formatLicenseDate(status.expires) });
  }
  if (status.state === "wrong_instance" && status.licenseInstanceId && status.boardInstanceId) {
    return t("licensing.state.wrongInstanceIds", {
      licenseId: status.licenseInstanceId,
      boardId: status.boardInstanceId,
    });
  }
  return t(`licensing.state.${status.state}`);
}

export function LicensingSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [requestModules, setRequestModules] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [licenseText, setLicenseText] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const statusQuery = useQuery({
    queryKey: [...licensingStatusQueryKey, requestModules?.join(",") ?? ""],
    queryFn: () => licensingApi.status(requestModules ?? undefined),
    retry: false,
  });

  const saveMutation = useMutation({
    mutationFn: (value: string) => licensingApi.saveLicense(value),
    onSuccess: (next: LicensingStatus) => {
      setSaveError(null);
      setSaved(true);
      setLicenseText("");
      queryClient.setQueryData([...licensingStatusQueryKey, requestModules?.join(",") ?? ""], next);
      void queryClient.invalidateQueries({ queryKey: licensingStatusQueryKey });
    },
    onError: (error: unknown) => {
      setSaved(false);
      const code = errorCode(error);
      const key = code ? SAVE_ERROR_KEYS[code] : undefined;
      if (code === "license_path_unwritable") {
        setSaveError(t("licensing.saveError.unwritable", { path: statusQuery.data?.license.path ?? "" }));
      } else if (code === "license_instance_mismatch" && mismatchIds(error)) {
        setSaveError(t("licensing.saveError.instanceMismatchIds", mismatchIds(error) ?? {}));
      } else {
        setSaveError(key ? t(key) : t("licensing.saveError.generic"));
      }
    },
  });

  // Not an instance admin (403) or the API is unavailable: show nothing.
  if (statusQuery.isError) return null;
  const status = statusQuery.data;
  if (!status) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="licensing-loading">
        {t("licensing.loading")}
      </p>
    );
  }

  const selectedModules =
    requestModules ?? (status.installedModules.length > 0 ? status.installedModules : [...LICENSE_MODULES]);

  async function copyRequest(text: string) {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function toggleModule(module: string, on: boolean) {
    const next = on ? [...new Set([...selectedModules, module])] : selectedModules.filter((m) => m !== module);
    if (next.length === 0) return; // a request names at least one module
    setCopied(false);
    setRequestModules(next);
  }

  function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSaved(false);
    setSaveError(null);
    void file.text().then(
      (text) => setLicenseText(text.trim()),
      () => setSaveError(t("licensing.saveError.fileUnreadable")),
    );
  }

  const envOverride = status.license.envOverride;

  return (
    <section className="space-y-5 rounded-lg border p-4" data-testid="licensing-panel">
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
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-medium">{t("licensing.statusTitle")}</h4>
        <ul className="space-y-1" data-testid="licensing-modules">
          {status.modules.map((m) => (
            <li
              key={m.module}
              className="flex flex-wrap items-baseline gap-x-3 text-sm"
              data-testid={`licensing-module-${m.module}`}
              data-state={m.state}
            >
              <span className="font-mono">{m.module}</span>
              <span className={STATE_TONE[m.state]} data-testid={`licensing-module-state-${m.module}`}>
                {moduleStateLabel(t, m)}
              </span>
              {!m.installed && <span className="text-xs text-muted-foreground">{t("licensing.notInstalled")}</span>}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground" data-testid="licensing-path">
          {envOverride
            ? t("licensing.sourceIsEnv")
            : t("licensing.licensePath", { path: status.license.path })}
        </p>
        {status.license.share === "container-only" && !envOverride && (
          <p className="text-xs text-destructive" data-testid="licensing-share-warning">
            {t("licensing.notShared", { path: status.license.path })}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-medium">{t("licensing.requestTitle")}</h4>
        <p className="text-xs text-muted-foreground">{t("licensing.requestHint")}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {LICENSE_MODULES.map((module) => (
            <label key={module} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`licensing-req-${module}`}
                checked={selectedModules.includes(module)}
                onChange={(event) => toggleModule(module, event.target.checked)}
              />
              <span className="font-mono">{module}</span>
            </label>
          ))}
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
            onClick={() => void copyRequest(status.request)}
            data-testid="licensing-copy-request"
          >
            {t("licensing.copyRequest")}
          </Button>
          {copied && <span className="text-xs text-muted-foreground">{t("licensing.copied")}</span>}
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-sm font-medium">{t("licensing.installTitle")}</h4>
        {envOverride ? (
          <p className="text-sm text-muted-foreground" data-testid="licensing-env-override">
            {t("licensing.saveError.envOverride")}
          </p>
        ) : (
          <>
            <Label htmlFor="licensing-license-input">{t("licensing.pasteLicense")}</Label>
            <Textarea
              id="licensing-license-input"
              rows={3}
              className="font-mono text-xs"
              placeholder="MYR1.…"
              value={licenseText}
              data-testid="licensing-license-input"
              onChange={(event) => {
                setLicenseText(event.target.value);
                setSaveError(null);
                setSaved(false);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="cursor-pointer text-sm underline underline-offset-2">
                {t("licensing.loadFile")}
                <input
                  type="file"
                  accept=".key,.txt,text/plain"
                  className="sr-only"
                  data-testid="licensing-license-file"
                  onChange={loadFile}
                />
              </label>
              <Button
                size="sm"
                disabled={!licenseText.trim() || saveMutation.isPending}
                onClick={() => saveMutation.mutate(licenseText.trim())}
                data-testid="licensing-save"
              >
                {saveMutation.isPending ? t("licensing.saving") : t("licensing.save")}
              </Button>
            </div>
            {saveError && (
              <p className="text-sm text-destructive" data-testid="licensing-save-error">
                {saveError}
              </p>
            )}
            {saved && (
              <p className="text-sm text-green-700 dark:text-green-400" data-testid="licensing-saved">
                {t("licensing.saved")}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
