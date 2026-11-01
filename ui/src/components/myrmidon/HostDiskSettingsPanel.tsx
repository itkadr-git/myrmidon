// Host disk usage (BOT-DISK E): the threshold and the live numbers of the disk
// the server's data lives on, editable while it runs. Saving applies at once
// — the sweep re-reads the threshold on every measurement, no restart.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { hostDiskApi, hostDiskQueryKey, type HostDiskView } from "./hostDiskApi";

// myrmidon(OPE-8950): visible strings live in area.settings-bots-host-2.host-disk-settings-panel.*
type Translate = (key: string, options?: Record<string, unknown>) => string;

function formatGrowth(bytesPerHour: number | null): string {
  if (bytesPerHour === null) return i18n.t("area.settings-bots-host-2.host-disk-settings-panel.growthUnknown");
  const gbPerHour = bytesPerHour / (1024 * 1024 * 1024);
  if (gbPerHour >= 1) return i18n.t("area.settings-bots-host-2.host-disk-settings-panel.growthGbPerHour", { value: gbPerHour.toFixed(1) });
  if (gbPerHour > 0) return i18n.t("area.settings-bots-host-2.host-disk-settings-panel.growthMbPerHour", { value: (gbPerHour * 1024).toFixed(0) });
  if (gbPerHour === 0) return i18n.t("area.settings-bots-host-2.host-disk-settings-panel.growthStable");
  return i18n.t("area.settings-bots-host-2.host-disk-settings-panel.growthNegative", { value: gbPerHour.toFixed(1) });
}

export function HostDiskSettingsPanel() {
  const { t } = useTranslation() as { t: Translate };
  const queryClient = useQueryClient();
  const { data: view } = useQuery({
    queryKey: hostDiskQueryKey,
    queryFn: hostDiskApi.get,
  });
  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view && draft === "") setDraft(String(view.threshold.usageThresholdPercent));
  }, [view, draft]);

  const save = useMutation({
    mutationFn: () => hostDiskApi.update({ usageThresholdPercent: Number(draft) }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: hostDiskQueryKey });
    },
    onError: () => setError(t("area.settings-bots-host-2.host-disk-settings-panel.saveFailed")),
  });

  const submit = () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      setError(t("area.settings-bots-host-2.host-disk-settings-panel.thresholdInvalid"));
      return;
    }
    save.mutate();
  };

  const status = view?.status;
  const overThreshold = status?.overThreshold ?? false;

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="host-disk-panel">
      <div className="flex items-center gap-2">
        <HardDrive className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("area.settings-bots-host-2.host-disk-settings-panel.title")}</h3>
        {overThreshold && (
          <span className="rounded bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-600" data-testid="host-disk-over">
            {t("area.settings-bots-host-2.host-disk-settings-panel.overThreshold")}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="host-disk-threshold">{t("area.settings-bots-host-2.host-disk-settings-panel.thresholdLabel")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="host-disk-threshold"
            inputMode="numeric"
            className="w-24"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            data-testid="host-disk-threshold-input"
          />
          <Button size="sm" onClick={submit} disabled={save.isPending || draft === ""}>
            {save.isPending ? t("area.settings-bots-host-2.host-disk-settings-panel.saving") : t("common.save")}
          </Button>
          {view && view.threshold.sources.usageThresholdPercent !== "settings" && (
            <span className="text-xs text-muted-foreground">
              {view.threshold.sources.usageThresholdPercent === "env"
                ? t("area.settings-bots-host-2.host-disk-settings-panel.sourceEnv")
                : t("area.settings-bots-host-2.host-disk-settings-panel.sourceDefault")}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-bots-host-2.host-disk-settings-panel.hint")}
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {save.isSuccess && !error && <p className="text-xs text-green-600">{t("area.settings-bots-host-2.host-disk-settings-panel.saved")}</p>}
      </div>

      {status && (
        <div className="space-y-1 text-sm" data-testid="host-disk-status">
          {status.usage.usedPercent !== null ? (
            <>
              <p>
                <span className="font-medium">{status.usage.usedPercent}%</span> {t("area.settings-bots-host-2.host-disk-settings-panel.used")}
                {status.usage.totalGb !== null && ` ${t("area.settings-bots-host-2.host-disk-settings-panel.usageDetail", { used: status.usage.usedGb, total: status.usage.totalGb, free: status.usage.freeGb })}`}
              </p>
              <p className="text-muted-foreground">{t("area.settings-bots-host-2.host-disk-settings-panel.growth", { value: formatGrowth(status.usage.growthBytesPerHour) })}</p>
              {status.consumers.length > 0 && (
                <div>
                  <p className="font-medium">{t("area.settings-bots-host-2.host-disk-settings-panel.consumers")}</p>
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {status.consumers.map((consumer) => (
                      <li key={consumer.path}>
                        {t("area.settings-bots-host-2.host-disk-settings-panel.consumerRow", { path: consumer.path, size: consumer.sizeGb })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">{t("area.settings-bots-host-2.host-disk-settings-panel.noMeasurement")}</p>
          )}
        </div>
      )}
    </section>
  );
}

export type { HostDiskView };
