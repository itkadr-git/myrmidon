import { useState } from "react";
import { i18n, useTranslation } from "@/i18n";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import type { TeamLivenessSettings } from "@myrmidon/shared";
import {
  TEAM_LIVENESS_SWITCH_KEYS,
  readTeamLivenessBlock,
  setTeamLivenessChoice,
  teamLivenessChoice,
  type TeamLivenessCardChoice,
  type TeamLivenessSwitchKey,
} from "./teamLivenessConfig";

/**
 * myrmidon(TEAM-LIVENESS-SETTINGS): the "Team liveness" section of an agent
 * card — one switch per automatic behaviour.
 *
 * Each switch is three-state: "Follow the instance settings" (the card says
 * nothing), "On" or "Off" (this agent overrides the instance value). The card
 * carries no numbers: the wake budget and the wake throttle are company-wide
 * ceilings an agent must not raise. The instance values are shown in each hint,
 * so the operator sees what "follow" currently means.
 */

// Lazy: the language must be read at render time, not frozen at import.
const options = (): Array<{ value: TeamLivenessCardChoice; label: string }> => [
  { value: "inherit", label: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.optionInherit") },
  { value: "on", label: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.optionOn") },
  { value: "off", label: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.optionOff") },
];

const switches = (
  instanceValue: (key: TeamLivenessSwitchKey) => string,
): Array<{ key: TeamLivenessSwitchKey; label: string; hint: string }> => [
  {
    key: "autoResume",
    label: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.autoResumeLabel"),
    hint: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.autoResumeHint", { value: instanceValue("autoResume") }),
  },
  {
    key: "runStall",
    label: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.runStallLabel"),
    hint: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.runStallHint", { value: instanceValue("runStall") }),
  },
  {
    key: "idlePickup",
    label: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.idlePickupLabel"),
    hint: i18n.t("area.settings-agent-card.agent-card-team-liveness-fields.idlePickupHint", { value: instanceValue("idlePickup") }),
  },
];

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm";

export function AgentCardTeamLivenessFields({
  value,
  onChange,
  settings,
}: {
  value: unknown;
  onChange: (next: Record<string, unknown> | undefined) => void;
  /** The instance values in force; `null` when they could not be loaded. */
  settings: TeamLivenessSettings | null;
}) {
  const { t } = useTranslation();
  const block = readTeamLivenessBlock(value);
  const overriding = TEAM_LIVENESS_SWITCH_KEYS.some((key) => teamLivenessChoice(block, key) !== "inherit");
  const [expanded, setExpanded] = useState(() => overriding);

  const instanceValue = (key: TeamLivenessSwitchKey): string => {
    if (!settings) return t("area.settings-agent-card.agent-card-team-liveness-fields.valueUnknown");
    const enabled = {
      autoResume: settings.autoResumeEnabled,
      runStall: settings.runStallEnabled,
      idlePickup: settings.idlePickupEnabled,
    }[key];
    return enabled ? t("area.settings-agent-card.agent-card-team-liveness-fields.valueOn") : t("area.settings-agent-card.agent-card-team-liveness-fields.valueOff");
  };

  return (
    <CollapsibleSection title={t("area.settings-agent-card.agent-card-team-liveness-fields.title")} open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3">
        {switches(instanceValue).map(({ key, label, hint }) => (
          <Field key={key} label={label} hint={hint}>
            <select
              className={selectClass}
              aria-label={label}
              data-testid={`team-liveness-card-${key}`}
              value={teamLivenessChoice(block, key)}
              onChange={(event) =>
                onChange(
                  setTeamLivenessChoice(block, key, event.target.value as TeamLivenessCardChoice),
                )
              }
            >
              {options().map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <p className="text-xs text-muted-foreground">
          {t("area.settings-agent-card.agent-card-team-liveness-fields.note")}
        </p>
      </div>
    </CollapsibleSection>
  );
}