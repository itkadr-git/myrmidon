// Vendor-name gate (myrmidon 1.7 REBRAND-F): the mode of the build-time gate
// and the ratchet baseline, on Instance → General.
//
// The gate keeps the vendor's name out of the built interface and out of the
// server's answers, where the rebrand allows it only in LICENSE, the
// third-party notices and the "based on … (MIT)" line of About. Saving here
// takes effect on the next read and the next CI run — no restart.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanSearch } from "lucide-react";
import type { VendorNameCheckMode, VendorNameCheckPatch } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  describeVendorNameCheckMode,
  describeVendorNameCheckSource,
  vendorNameCheckApi,
  vendorNameCheckQueryKey,
  type VendorNameCheckView,
  type VendorNameScan,
} from "./vendorNameCheckApi";

const MODES: Array<{ value: VendorNameCheckMode; title: string; description: string }> = [
  {
    value: "ratchet",
    title: "Ratchet",
    description:
      "The count of visible vendor-name mentions in the built interface and in the recorded server answers may not grow above the baseline. A new mention fails CI, a mention that is already there does not.",
  },
  {
    value: "strict",
    title: "Strict",
    description:
      "Any visible mention outside the policy's exceptions fails the check. This is the mode of the repository once the interface strings (REBRAND A) and the server texts (REBRAND B) have been renamed.",
  },
];

function ScanSummary({ scan }: { scan: VendorNameScan }) {
  if (!scan.available) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="vendor-name-scan">
        The gate does not run from this installation: {scan.reason}. The setting above still applies — CI runs
        the same script from the repository.
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="vendor-name-scan">
      <p className="text-xs text-muted-foreground">
        This build: {scan.totals.visible} visible mention(s), {scan.totals.identifier} identifier spelling(s)
        in {scan.targets.length} target(s) — mode {describeVendorNameCheckMode(scan.mode)} (
        {scan.modeSource === "policy" ? "from the policy file" : describeVendorNameCheckSource(scan.modeSource as never)}).
      </p>
      <ul className="space-y-1 text-xs">
        {scan.targets.map((target) => (
          <li key={target.name} className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{target.name}</span>
            <span
              className={
                target.status === "violation" ? "text-destructive" : "text-muted-foreground"
              }
            >
              {target.visible} visible / {target.identifier} identifier — baseline {target.baseline} (
              {target.status})
            </span>
            {target.detail.slice(0, 3).map((row) => (
              <span key={`${row.file}:${row.line}`} className="text-muted-foreground">
                {row.file}:{row.line}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VendorNameCheckSettingsPanelView({
  view,
  onSave,
  onRefresh,
  pending,
  refreshing,
  error,
}: {
  view: VendorNameCheckView | null | undefined;
  onSave: (patch: VendorNameCheckPatch) => void;
  onRefresh: () => void;
  pending: boolean;
  refreshing: boolean;
  error: string | null;
}) {
  const [modeDraft, setModeDraft] = useState<VendorNameCheckMode | null>(null);
  const [baselineDraft, setBaselineDraft] = useState<string | null>(null);
  const mode = modeDraft ?? view?.settings.mode ?? null;
  const baseline = baselineDraft ?? (view ? String(view.settings.baseline) : null);
  const parsedBaseline = baseline === null ? null : Number(baseline.trim());
  const baselineValid =
    parsedBaseline !== null && Number.isInteger(parsedBaseline) && parsedBaseline >= 0 && parsedBaseline <= 100000;
  const dirty =
    view != null &&
    ((modeDraft !== null && modeDraft !== view.settings.mode) ||
      (baselineDraft !== null && baselineValid && parsedBaseline !== view.settings.baseline));

  return (
    <section className="space-y-4" data-testid="myrmidon-vendor-name-check">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Vendor name in the build</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The rebrand keeps the vendor's name out of the built interface and out of the server's answers: it
          stays in the LICENSE, the third-party notices and the "based on … (MIT)" line of About. CI runs the
          gate on the built bundle and on recorded responses; the mode and the baseline below decide how strict
          it is. Saving takes effect on the next read — no server restart.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="space-y-4">
          <RadioCardGroup
            ariaLabel="Vendor name check mode"
            value={mode ?? "ratchet"}
            onValueChange={(value) => setModeDraft(value as VendorNameCheckMode)}
            options={MODES.map(({ value, title, description }) => ({
              value,
              title,
              description,
              accessibleLabel: `Vendor name check mode: ${title}`,
            }))}
          />

          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span className="block">Ratchet baseline (visible mentions allowed)</span>
              <Input
                aria-label="Ratchet baseline"
                inputMode="numeric"
                className="w-32"
                value={baseline ?? ""}
                onChange={(event) => setBaselineDraft(event.target.value)}
              />
            </label>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                disabled={pending || !dirty || !baselineValid}
                onClick={() => {
                  const patch: VendorNameCheckPatch = {};
                  if (modeDraft !== null && modeDraft !== view.settings.mode) patch.mode = modeDraft;
                  if (
                    baselineValid &&
                    baselineDraft !== null &&
                    parsedBaseline !== view.settings.baseline
                  ) {
                    patch.baseline = parsedBaseline;
                  }
                  onSave(patch);
                }}
              >
                {pending ? "Saving..." : "Save vendor name check"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
                {refreshing ? "Checking..." : "Check the build again"}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="vendor-name-check-mode-source">
              Mode: {describeVendorNameCheckSource(view.sources.mode)}
            </span>
            <span data-testid="vendor-name-check-baseline-source">
              Baseline: {describeVendorNameCheckSource(view.sources.baseline)}
            </span>
          </div>

          <ScanSummary scan={view.scan} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the vendor name check...</p>
      )}
    </section>
  );
}

export function VendorNameCheckSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: vendorNameCheckQueryKey,
    queryFn: () => vendorNameCheckApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: vendorNameCheckApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the vendor name check failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: vendorNameCheckQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the vendor name check."}
      </div>
    );
  }

  return (
    <VendorNameCheckSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      onRefresh={() => void queryClient.invalidateQueries({ queryKey: vendorNameCheckQueryKey })}
      pending={save.isPending}
      refreshing={query.isFetching}
      error={error}
    />
  );
}