import { useEffect, useMemo, useState } from "react";
import type { AgentPermissions, TrustPreset } from "@paperclipai/shared";
import { Lock, ShieldAlert } from "lucide-react";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { Field, CollapsibleSection } from "./agent-config-primitives";
import {
  buildPermissionsForTrustPreset,
  clearSingleLowTrustBoundaryTarget,
  getLowTrustBoundary,
  getSingleLowTrustBoundaryTarget,
  getTrustPreset,
  isCeLowTrustBoundaryEditable,
  lowTrustBoundaryHasScope,
  setSingleLowTrustBoundaryTarget,
  summarizeLowTrustBoundaryTarget,
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
  type LowTrustBoundaryTarget,
} from "../lib/trust-policy-ui";
import { cn } from "../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatCount(value: readonly unknown[] | undefined, format: (count: number) => string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return format(count);
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", value === "-" && "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export interface LowTrustBoundaryCandidate {
  id: string;
  label: string;
}

type LowTrustBoundaryTargetType = LowTrustBoundaryTarget["type"];

function boundaryTargetLabel(type: LowTrustBoundaryTargetType, t: TFunction): string {
  switch (type) {
    case "project":
      return t("area.access-secrets-1.trust-preset-section.boundaryProject");
    case "root_issue":
      return t("area.access-secrets-1.trust-preset-section.boundaryRootIssue");
    default:
      return t("area.access-secrets-1.trust-preset-section.boundaryIssue");
  }
}

export function TrustPresetSection({
  permissions,
  onChange,
  disabled,
  companyId,
  projectCandidates = [],
  issueCandidates = [],
  candidatesLoading,
  allowSingleIssue = true,
}: {
  permissions: Partial<AgentPermissions> | null | undefined;
  onChange: (permissions: Partial<AgentPermissions>) => void;
  disabled?: boolean;
  companyId?: string | null;
  projectCandidates?: LowTrustBoundaryCandidate[];
  issueCandidates?: LowTrustBoundaryCandidate[];
  candidatesLoading?: boolean;
  allowSingleIssue?: boolean;
}) {
  const { t } = useTranslation();
  const [policyOpen, setPolicyOpen] = useState(false);
  const preset = getTrustPreset(permissions);
  const boundary = getLowTrustBoundary(permissions);
  const boundaryTarget = getSingleLowTrustBoundaryTarget(boundary);
  const [targetType, setTargetType] = useState<LowTrustBoundaryTargetType>(boundaryTarget?.type ?? "project");
  const lowTrust = preset === "low_trust_review";
  const hasScope = lowTrustBoundaryHasScope(boundary);
  const boundaryEditable = isCeLowTrustBoundaryEditable(boundary);
  const policy = permissions?.authorizationPolicy ?? null;
  const managedPermissions = useMemo(
    () => buildPermissionsForTrustPreset(permissions, preset),
    [permissions, preset],
  );

  useEffect(() => {
    if (boundaryTarget) setTargetType(boundaryTarget.type);
  }, [boundaryTarget?.type]);

  function handlePresetChange(value: string) {
    const nextPreset: TrustPreset = value === "low_trust_review" ? "low_trust_review" : "standard";
    onChange(buildPermissionsForTrustPreset(permissions, nextPreset));
  }

  function handleBoundaryTargetChange(targetId: string) {
    if (!companyId || !targetId) return;
    onChange(setSingleLowTrustBoundaryTarget(permissions, companyId, { type: targetType, id: targetId }));
  }

  function handleClearBoundary() {
    onChange(clearSingleLowTrustBoundaryTarget(permissions));
  }

  const targetCandidates = targetType === "project" ? projectCandidates : issueCandidates;
  const boundaryValue = boundaryTarget?.type === targetType ? boundaryTarget.id : "";

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{t("area.access-secrets-1.trust-preset-section.heading")}</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field label={t("area.access-secrets-1.trust-preset-section.presetLabel")} hint={t("area.access-secrets-1.trust-preset-section.presetHint")}>
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value)}
            disabled={disabled}
          >
            <option value="standard">{TRUST_PRESET_LABELS.standard}</option>
            <option value="low_trust_review">{TRUST_PRESET_LABELS.low_trust_review}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{TRUST_PRESET_DESCRIPTIONS[preset]}</p>

        {lowTrust ? (
          <div
            role={hasScope ? "status" : "alert"}
            aria-live="polite"
            className={cn(
              "rounded-md border px-3 py-2.5 text-sm flex gap-2",
              hasScope
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {hasScope ? (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="font-medium">
                  {hasScope ? t("area.access-secrets-1.trust-preset-section.containmentActive") : t("area.access-secrets-1.trust-preset-section.containmentNotConfigured")}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope ? t("area.access-secrets-1.trust-preset-section.containmentActiveText") : t("area.access-secrets-1.trust-preset-section.containmentMissingText")}
                </p>
              </div>
              {boundaryEditable ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground space-y-3">
                  <div className="grid gap-3 sm:grid-cols-(--gtc-12)">
                    <Field label={t("area.access-secrets-1.trust-preset-section.boundaryType")}>
                      <select
                        className={inputClass}
                        value={targetType}
                        onChange={(event) => setTargetType(event.target.value as LowTrustBoundaryTargetType)}
                        disabled={disabled}
                      >
                        <option value="project">{t("area.access-secrets-1.trust-preset-section.boundaryProject")}</option>
                        <option value="root_issue">{t("area.access-secrets-1.trust-preset-section.boundaryRootIssue")}</option>
                        {allowSingleIssue && <option value="issue">{t("area.access-secrets-1.trust-preset-section.boundaryIssue")}</option>}
                      </select>
                    </Field>
                    <Field label={boundaryTargetLabel(targetType, t)}>
                      <select
                        className={inputClass}
                        value={boundaryValue}
                        onChange={(event) => handleBoundaryTargetChange(event.target.value)}
                        disabled={disabled || !companyId || candidatesLoading || targetCandidates.length === 0}
                      >
                        <option value="">
                          {candidatesLoading
                            ? t("common.loading")
                            : targetCandidates.length === 0
                              ? targetType === "project"
                                ? t("area.access-secrets-1.trust-preset-section.noProjectsAvailable")
                                : t("area.access-secrets-1.trust-preset-section.noIssuesAvailable")
                              : t("area.access-secrets-1.trust-preset-section.selectBoundary")}
                        </option>
                        {targetCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t("area.access-secrets-1.trust-preset-section.ceOneBoundary")}
                    </p>
                    {boundaryTarget ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={handleClearBoundary}
                        disabled={disabled}
                      >
                        {t("area.access-secrets-1.trust-preset-section.clearBoundary")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground">
                  <p className="text-sm font-medium">{t("area.access-secrets-1.trust-preset-section.managedByEe")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("area.access-secrets-1.trust-preset-section.managedByEeText", { summary: summarizeLowTrustBoundaryTarget(boundary).toLowerCase() })}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("area.access-secrets-1.trust-preset-section.wantMore")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://paperclip.ing/ee"
                  target="_blank"
                  rel="noreferrer"
                >
                  {/* myrmidon(DB1): DEBRAND 1.6.6-a — vendor-store name in visible CTA. */}
                  {t("area.access-secrets-1.trust-preset-section.getEe")}
                </a>
              </p>
              <CollapsibleSection
                title={t("area.access-secrets-1.trust-preset-section.viewPolicy")}
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowPreset")} value={t("area.access-secrets-1.trust-preset-section.presetValue")} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowRawOutput")} value={t("area.access-secrets-1.trust-preset-section.rawOutputValue")} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowProjects")} value={formatCount(boundary?.projectIds, (count) => t("area.access-secrets-1.trust-preset-section.projectsCount", { count }))} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowRootIssue")} value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowExplicitIssues")} value={formatCount(boundary?.issueIds, (count) => t("area.access-secrets-1.trust-preset-section.issuesCount", { count }))} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowAllowedAgents")} value={formatCount(boundary?.allowedAgentIds, (count) => t("area.access-secrets-1.trust-preset-section.agentsCount", { count }))} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowAllowedTools")} value={boundary?.allowedToolClasses?.join(" · ") || "-"} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowAllowedSecrets")} value={formatCount(boundary?.allowedSecretBindingIds, (count) => t("area.access-secrets-1.trust-preset-section.bindingsCount", { count }))} />
                  <PolicyRow label={t("area.access-secrets-1.trust-preset-section.rowPromotionTarget")} value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"} />
                  <PolicyRow
                    label={t("area.access-secrets-1.trust-preset-section.rowEeFields")}
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? t("area.access-secrets-1.trust-preset-section.customFieldsPreserved")
                      : "-"}
                  />
                </div>
              </CollapsibleSection>
            </div>
          </div>
        ) : null}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">
            {t("area.access-secrets-1.trust-preset-section.advancedNote")}
          </p>
        )}
      </div>
    </div>
  );
}
