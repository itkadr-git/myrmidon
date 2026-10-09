// myrmidon(1.7, OPE-4101, SETTINGS-TO-UI E): the System settings tab of the
// instance settings. It shows the behavior keys of the section "system" from
// the part A registry (deploy smoke parameters, tracing windows, Zabbix
// maintenance windows) and a read-only "Deployment" block of infrastructure
// statuses. All writes go through the part A behavior-settings API; a set env
// var is a forced override and the field is shown read-only with a hint.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

interface BehaviorSettingValue {
  key: string;
  envName: string;
  value: unknown;
  source: "ui" | "env" | "default";
  default: unknown;
  scope: string;
  section: string;
  valueType: "boolean" | "string" | "number" | "json";
}

interface DeploymentStatusRow {
  id: string;
  label: string;
  envName: string;
  status: "configured" | "not-configured";
  detail?: string | null;
}

const SYSTEM_KEYS = [
  "system.deploy.enabled",
  "system.deploy.autoRollback",
  "system.deploy.autoUpdate",
  "system.deploy.verifyTimeoutSec",
  "system.deploy.tickSec",
  "system.deploy.stepTimeoutSec",
  "system.deploy.healthPollSec",
  "system.deploy.healthTimeoutSec",
  "system.tracing.windowSec",
  "system.tracing.healthTtlSec",
  "system.tracing.signalIntervalSec",
  "system.zabbix.hostGroups",
  "system.zabbix.maxWindowSec",
] as const;

const LABELS: Record<(typeof SYSTEM_KEYS)[number], string> = {
  "system.deploy.enabled": "Deploy enabled",
  "system.deploy.autoRollback": "Auto rollback",
  "system.deploy.autoUpdate": "Auto update (no confirmation)",
  "system.deploy.verifyTimeoutSec": "Verify timeout, sec",
  "system.deploy.tickSec": "Tick interval, sec",
  "system.deploy.stepTimeoutSec": "Step timeout, sec",
  "system.deploy.healthPollSec": "Health poll interval, sec",
  "system.deploy.healthTimeoutSec": "Health timeout, sec",
  "system.tracing.windowSec": "Tracing window, sec",
  "system.tracing.healthTtlSec": "Tracing health cache TTL, sec",
  "system.tracing.signalIntervalSec": "Tracing signal interval, sec",
  "system.zabbix.hostGroups": "Zabbix host groups",
  "system.zabbix.maxWindowSec": "Zabbix max maintenance window, sec",
};

function behaviorSettingsQueryKey() {
  return ["myrmidon", "behavior-settings", "system"] as const;
}

function deploymentStatusQueryKey() {
  return ["myrmidon", "system", "deployment"] as const;
}

export function SystemSettingsPanel() {
  const queryClient = useQueryClient();
  const [localValues, setLocalValues] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const behaviorQuery = useQuery({
    queryKey: behaviorSettingsQueryKey(),
    queryFn: () => api.get<{ values: BehaviorSettingValue[] }>("/myrmidon/behavior-settings"),
  });

  const deploymentQuery = useQuery({
    queryKey: deploymentStatusQueryKey(),
    queryFn: () => api.get<{ rows: DeploymentStatusRow[] }>("/myrmidon/system/deployment"),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<{ ok: boolean }>("/myrmidon/behavior-settings", patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: behaviorSettingsQueryKey() });
    },
  });

  useEffect(() => {
    if (behaviorQuery.data) {
      const map: Record<string, unknown> = {};
      for (const item of behaviorQuery.data.values) {
        if ((SYSTEM_KEYS as readonly string[]).includes(item.key)) {
          map[item.key] = item.value;
        }
      }
      setLocalValues(map);
    }
  }, [behaviorQuery.data]);

  const systemValues = (behaviorQuery.data?.values ?? []).filter((v) =>
    (SYSTEM_KEYS as readonly string[]).includes(v.key),
  );

  const renderField = (item: BehaviorSettingValue) => {
    const label = LABELS[item.key as (typeof SYSTEM_KEYS)[number]] ?? item.key;
    const isEnv = item.source === "env";
    const value = localValues[item.key] ?? item.value;

    if (item.valueType === "boolean") {
      return (
        <div key={item.key} className="flex items-center justify-between gap-4 py-2">
          <Label htmlFor={item.key} className="text-sm font-normal">
            {label}
            {isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null}
          </Label>
          <ToggleSwitch
            id={item.key}
            checked={value === true}
            disabled={isEnv || savingKey === item.key}
            onCheckedChange={(checked) => {
              setLocalValues((prev) => ({ ...prev, [item.key]: checked }));
              setSavingKey(item.key);
              updateMutation.mutate({ [item.key]: checked }, {
                onSettled: () => setSavingKey(null),
              });
            }}
          />
        </div>
      );
    }

    if (item.valueType === "number") {
      return (
        <div key={item.key} className="flex items-center justify-between gap-4 py-2">
          <Label htmlFor={item.key} className="text-sm font-normal">
            {label}
            {isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null}
          </Label>
          <Input
            id={item.key}
            type="number"
            className="w-28 text-right"
            value={typeof value === "number" ? value : Number(value) || 0}
            disabled={isEnv || savingKey === item.key}
            onChange={(e) => {
              const next = Number(e.target.value);
              setLocalValues((prev) => ({ ...prev, [item.key]: next }));
            }}
            onBlur={() => {
              if (value !== item.value) {
                setSavingKey(item.key);
                updateMutation.mutate({ [item.key]: value }, {
                  onSettled: () => setSavingKey(null),
                });
              }
            }}
          />
        </div>
      );
    }

    // json / string
    const displayValue = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return (
      <div key={item.key} className="flex items-center justify-between gap-4 py-2">
        <Label htmlFor={item.key} className="text-sm font-normal">
          {label}
          {isEnv ? <span className="ml-2 text-xs text-muted-foreground">(env override)</span> : null}
        </Label>
        <Input
          id={item.key}
          className="w-56 text-right"
          value={displayValue}
          disabled={isEnv || savingKey === item.key}
          onChange={(e) => {
            setLocalValues((prev) => ({ ...prev, [item.key]: e.target.value }));
          }}
          onBlur={() => {
            if (value !== item.value) {
              const next = item.key === "system.zabbix.hostGroups"
                ? String(value).split(",").map((s) => s.trim()).filter(Boolean)
                : value;
              setSavingKey(item.key);
              updateMutation.mutate({ [item.key]: next }, {
                onSettled: () => setSavingKey(null),
              });
            }
          }}
        />
      </div>
    );
  };

  const deployKeys = systemValues.filter((v) => v.key.startsWith("system.deploy."));
  const tracingKeys = systemValues.filter((v) => v.key.startsWith("system.tracing."));
  const zabbixKeys = systemValues.filter((v) => v.key.startsWith("system.zabbix."));

  const deploymentRows = deploymentQuery.data?.rows ?? [];

  return (
    <section className="space-y-6" data-testid="myrmidon-system-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">System</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Deploy smoke parameters, tracing windows, Zabbix maintenance windows, and the read-only
          deployment status. Changes apply without a restart; an env var set on the host overrides
          the UI value.
        </p>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Deploy</h3>
        <div className="divide-y rounded-md border px-3">{deployKeys.map(renderField)}</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Tracing</h3>
        <div className="divide-y rounded-md border px-3">{tracingKeys.map(renderField)}</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Monitoring (Zabbix)</h3>
        <div className="divide-y rounded-md border px-3">{zabbixKeys.map(renderField)}</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Deployment (read-only)</h3>
        <div className="divide-y rounded-md border px-3">
          {deploymentRows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-4 py-2">
              <div className="text-sm">
                <span className="font-normal">{row.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">{row.envName}</span>
              </div>
              <div className="text-sm">
                <span
                  className={
                    row.status === "configured"
                      ? "text-green-600 dark:text-green-400"
                      : "text-muted-foreground"
                  }
                >
                  {row.status === "configured" ? "Configured" : "Not configured"}
                </span>
                {row.detail ? (
                  <span className="ml-2 text-xs text-muted-foreground">{row.detail}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
