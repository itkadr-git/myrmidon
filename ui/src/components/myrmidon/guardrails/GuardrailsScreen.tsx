// myrmidon(1.7-GRD-MODES): the "Guardrails" settings screen — the view tier.
// Layout and local interaction state only; the react-query wiring lives in
// GuardrailsScreenContainer.tsx so tests can drive both tiers separately
// (the same split the Autonomy and WIP limit screens use).
//
// Three levels, one closed list of rules (secret / pii / injection) and one
// closed list of modes (flag / mask / block). A cell left on "inherit"
// removes the override, so the row stays minimal and the next level down
// applies. The company row is the last override level; below it the shipped
// default is flag-only. The per-agent "effective" column is resolved by the
// server (GET .../resolve) so the UI shows the true precedence chain and its
// source, not a client-side guess.
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GUARDRAIL_RULES,
  AGENT_ROLES,
  type GuardrailModesSettings,
  type GuardrailRule,
  type GuardrailMode,
  type ResolvedGuardrailMode,
} from "@paperclipai/shared";

export interface GuardrailsAgentRow {
  agentId: string;
  name: string;
}

const INHERIT = "__inherit__";

function modeOptionLabel(t: (key: string) => string, mode: GuardrailMode): string {
  return t(`guardrails.mode.${mode}`);
}

function ruleLabel(t: (key: string) => string, rule: GuardrailRule): string {
  return t(`guardrails.rule.${rule}`);
}

function sourceLabel(t: (key: string) => string, source: ResolvedGuardrailMode["source"]): string {
  return t(`guardrails.source.${source}`);
}

export function GuardrailsScreenView({
  settings,
  agents,
  resolved,
  onSave,
  pending,
  error,
}: {
  settings: GuardrailModesSettings | null | undefined;
  agents: GuardrailsAgentRow[];
  /** server-resolved effective modes per agentId (from GET .../resolve) */
  resolved: Record<string, ResolvedGuardrailMode[]>;
  onSave: (settings: GuardrailModesSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [companyDraft, setCompanyDraft] = useState<Partial<Record<GuardrailRule, string | null>> | null>(null);
  const [casteDraft, setCasteDraft] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<Record<string, Partial<Record<GuardrailRule, string | null>>> | null>(null);
  const [casteNameDraft, setCasteNameDraft] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const currentCompany: Partial<Record<GuardrailRule, string>> = {};
  for (const rule of GUARDRAIL_RULES) {
    const drafted = companyDraft?.[rule];
    const stored = settings?.company?.[rule];
    currentCompany[rule] = drafted !== undefined ? drafted : stored ?? INHERIT;
  }
  const activeCaste = casteDraft ?? "";
  const currentCasteRules: Partial<Record<GuardrailRule, string>> = {};
  for (const rule of GUARDRAIL_RULES) {
    const drafted = agentDraft?.[activeCaste]?.[rule];
    const stored = activeCaste ? settings?.castes?.[activeCaste]?.[rule] : undefined;
    currentCasteRules[rule] = drafted !== undefined ? drafted : stored ?? INHERIT;
  }

  const castes = Array.from(
    new Set([...AGENT_ROLES, ...Object.keys(settings?.castes ?? {})]),
  ).sort();

  const dirty =
    companyDraft !== null ||
    agentDraft !== null ||
    (casteDraft !== null && casteDraft !== "") ||
    false;

  const save = () => {
    if (!settings) return;
    const company: GuardrailModesSettings["company"] = { ...settings.company };
    for (const rule of GUARDRAIL_RULES) {
      const value = currentCompany[rule];
      if (value === INHERIT) delete company[rule];
      else company[rule] = value as GuardrailMode;
    }
    const castesNext: GuardrailModesSettings["castes"] = { ...settings.castes };
    for (const caste of Object.keys(castesNext)) {
      for (const rule of GUARDRAIL_RULES) {
        const value =
          caste === activeCaste
            ? currentCasteRules[rule]
            : castesNext[caste]?.[rule];
        if (caste === activeCaste) {
          const rules = { ...(castesNext[caste] ?? {}) };
          if (value === INHERIT) delete rules[rule];
          else rules[rule] = value as GuardrailMode;
          if (Object.keys(rules).length === 0) delete castesNext[caste];
          else castesNext[caste] = rules;
        }
      }
    }
    const agentsNext: GuardrailModesSettings["agents"] = { ...settings.agents };
    for (const agent of agents) {
      const drafts = agentDraft?.[agent.agentId] ?? {};
      const rules = { ...(agentsNext[agent.agentId] ?? {}) };
      for (const rule of GUARDRAIL_RULES) {
        const value = drafts[rule] !== undefined ? drafts[rule] : rules[rule];
        if (value === INHERIT) delete rules[rule];
        else if (value !== undefined) rules[rule] = value as GuardrailMode;
      }
      if (Object.keys(rules).length === 0) delete agentsNext[agent.agentId];
      else agentsNext[agent.agentId] = rules;
    }
    setSaveError(null);
    onSave({ company, castes: castesNext, agents: agentsNext });
  };

  const shownError = saveError ?? error;

  return (
    <section className="space-y-4" data-testid="myrmidon-guardrails">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("guardrails.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("guardrails.intro")}</p>
      </div>

      {shownError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="myrmidon-guardrails-error"
          role="alert"
        >
          {shownError}
        </div>
      ) : null}

      {settings ? (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("guardrails.companyTitle")}</h3>
            <div className="grid gap-2 sm:grid-cols-3" data-testid="guardrails-company-row">
              {GUARDRAIL_RULES.map((rule) => (
                <div key={rule} className="space-y-1">
                  <Label htmlFor={`guardrail-company-${rule}`}>{ruleLabel(t, rule)}</Label>
                  <Select
                    value={currentCompany[rule]}
                    onValueChange={(value) => setCompanyDraft({ ...(companyDraft ?? {}), [rule]: value })}
                  >
                    <SelectTrigger id={`guardrail-company-${rule}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>{t("guardrails.inherit")}</SelectItem>
                      <SelectItem value="flag">{modeOptionLabel(t, "flag")}</SelectItem>
                      <SelectItem value="mask">{modeOptionLabel(t, "mask")}</SelectItem>
                      <SelectItem value="block">{modeOptionLabel(t, "block")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("guardrails.companyHint")}</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("guardrails.casteTitle")}</h3>
            <div className="flex items-center gap-2">
              <Input
                list="guardrails-caste-options"
                placeholder={t("guardrails.castePlaceholder")}
                className="max-w-xs"
                value={casteNameDraft}
                onChange={(event) => {
                  setCasteNameDraft(event.target.value);
                  setCasteDraft(event.target.value.trim());
                }}
                aria-label={t("guardrails.castePlaceholder")}
              />
              <datalist id="guardrails-caste-options">
                {castes.map((caste) => (
                  <option key={caste} value={caste} />
                ))}
              </datalist>
            </div>
            {activeCaste ? (
              <div className="grid gap-2 sm:grid-cols-3" data-testid="guardrails-caste-row">
                {GUARDRAIL_RULES.map((rule) => (
                  <div key={rule} className="space-y-1">
                    <Label htmlFor={`guardrail-caste-${rule}`}>{ruleLabel(t, rule)}</Label>
                    <Select
                      value={currentCasteRules[rule]}
                      onValueChange={(value) =>
                        setAgentDraft({
                          ...(agentDraft ?? {}),
                          [activeCaste]: { ...(agentDraft?.[activeCaste] ?? {}), [rule]: value },
                        })
                      }
                    >
                      <SelectTrigger id={`guardrail-caste-${rule}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>{t("guardrails.inherit")}</SelectItem>
                        <SelectItem value="flag">{modeOptionLabel(t, "flag")}</SelectItem>
                        <SelectItem value="mask">{modeOptionLabel(t, "mask")}</SelectItem>
                        <SelectItem value="block">{modeOptionLabel(t, "block")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="guardrails-caste-none">
                {t("guardrails.casteHint")}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("guardrails.agentsTitle")}</h3>
            {agents.length > 0 ? (
              <table className="w-full text-sm" data-testid="guardrails-agent-table">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-4 font-medium">{t("guardrails.colAgent")}</th>
                    {GUARDRAIL_RULES.map((rule) => (
                      <th key={rule} className="py-1 pr-4 font-medium">{ruleLabel(t, rule)}</th>
                    ))}
                    <th className="py-1 pr-4 font-medium">{t("guardrails.colEffective")}</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => {
                    const resolvedRules = resolved[agent.agentId] ?? [];
                    return (
                      <tr key={agent.agentId} className="border-t border-border">
                        <td className="py-1.5 pr-4">{agent.name}</td>
                        {GUARDRAIL_RULES.map((rule) => {
                          const drafts = agentDraft?.[agent.agentId] ?? {};
                          const stored = settings.agents?.[agent.agentId]?.[rule];
                          const value = drafts[rule] !== undefined ? drafts[rule] : stored ?? INHERIT;
                          return (
                            <td key={rule} className="py-1.5 pr-4">
                              <Select
                                value={value}
                                onValueChange={(next) =>
                                  setAgentDraft({
                                    ...(agentDraft ?? {}),
                                    [agent.agentId]: {
                                      ...(agentDraft?.[agent.agentId] ?? {}),
                                      [rule]: next,
                                    },
                                  })
                                }
                              >
                                <SelectTrigger
                                  className="w-32"
                                  aria-label={`${ruleLabel(t, rule)} — ${agent.name}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={INHERIT}>{t("guardrails.inherit")}</SelectItem>
                                  <SelectItem value="flag">{modeOptionLabel(t, "flag")}</SelectItem>
                                  <SelectItem value="mask">{modeOptionLabel(t, "mask")}</SelectItem>
                                  <SelectItem value="block">{modeOptionLabel(t, "block")}</SelectItem>
                                </SelectContent>
                              </Select>
                            </td>
                          );
                        })}
                        <td className="py-1.5 pr-4 text-xs text-muted-foreground">
                          <span data-testid={`guardrails-effective-${agent.agentId}`}>
                            {resolvedRules
                              .map(
                                (entry) =>
                                  `${ruleLabel(t, entry.rule)}: ${modeOptionLabel(t, entry.mode)} (${sourceLabel(t, entry.source)})`,
                              )
                              .join("; ") || "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="guardrails-no-agents">
                {t("guardrails.noAgents")}
              </p>
            )}
          </div>

          <div>
            <Button type="button" size="sm" disabled={pending} onClick={save}>
              {pending ? t("guardrails.saving") : t("guardrails.save")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-guardrails-loading">
          {t("guardrails.loading")}
        </p>
      )}
    </section>
  );
}
