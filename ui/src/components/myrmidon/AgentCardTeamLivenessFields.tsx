import { useState } from "react";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import type { TeamLivenessSettings } from "@paperclipai/shared";
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

const OPTIONS: Array<{ value: TeamLivenessCardChoice; label: string }> = [
  { value: "inherit", label: "Follow the instance settings" },
  { value: "on", label: "On for this agent" },
  { value: "off", label: "Off for this agent" },
];

const SWITCHES: Array<{ key: TeamLivenessSwitchKey; label: string; hint: string }> = [
  {
    key: "autoResume",
    label: "Auto-resume",
    hint: "the board resumes this agent after a failed run, with backoff",
  },
  {
    key: "runStall",
    label: "Run liveness by progress",
    hint: "a run of this agent that stops recording progress is interrupted and its task returns to the queue",
  },
  {
    key: "idlePickup",
    label: "Wake on ready work",
    hint: "the board wakes this agent while it is idle with a ready task",
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
  const block = readTeamLivenessBlock(value);
  const overriding = TEAM_LIVENESS_SWITCH_KEYS.some((key) => teamLivenessChoice(block, key) !== "inherit");
  const [expanded, setExpanded] = useState(() => overriding);

  const instanceValue = (key: TeamLivenessSwitchKey): string => {
    if (!settings) return "unknown";
    const enabled = {
      autoResume: settings.autoResumeEnabled,
      runStall: settings.runStallEnabled,
      idlePickup: settings.idlePickupEnabled,
    }[key];
    return enabled ? "on" : "off";
  };

  return (
    <CollapsibleSection title="Team liveness" open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3">
        {SWITCHES.map(({ key, label, hint }) => (
          <Field
            key={key}
            label={label}
            hint={`Which layer decides that ${hint}. The instance settings say ${instanceValue(key)} right now.`}
          >
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
              {OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <p className="text-xs text-muted-foreground">
          Changes apply on the agent's next pass, without a restart. The wake budget and the wake throttle are
          company-wide and stay on the instance settings page.
        </p>
      </div>
    </CollapsibleSection>
  );
}