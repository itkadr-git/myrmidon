import { useState } from "react";
import {
  BOT_LSP_MODES,
  isBotLspMode,
  readBotLspCard,
  resolveBotLsp,
  type BotLspCard,
  type BotLspMode,
  type BotLspSettings,
} from "@myrmidon/shared";
import { useTranslation } from "@/i18n";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import { BOT_LSP_MODE_HINTS, BOT_LSP_MODE_LABELS } from "./botLspModes";

/**
 * myrmidon(BOT-LSP-DEFAULTS): the "Language servers" section of a
 * hermes_gateway agent card. Stored as `adapterConfig.lsp = { mode }`; absent
 * means "follow the role" (the instance policy decides by the agent's caste).
 * Saving the card changes the bot's compiled config, which the reconciler
 * applies while the bot is paused — the same path a model change takes.
 */

const selectClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

/** The card value for a picked option: "" = follow the role (block removed). */
export function botLspCardFor(pick: BotLspMode | ""): BotLspCard | undefined {
  return isBotLspMode(pick) ? { mode: pick } : undefined;
}

export function AgentCardLspFields({
  value,
  role,
  settings,
  onChange,
}: {
  value: unknown;
  /** The agent's role (caste key) as currently edited. */
  role: string | null;
  /** The instance policy; null while loading or for a viewer without access (module defaults then). */
  settings: BotLspSettings | null;
  onChange: (next: BotLspCard | undefined) => void;
}) {
  const { t } = useTranslation();
  const card = readBotLspCard({ lsp: value });
  const pinned = card.mode ?? "";
  const byRole = resolveBotLsp(role, {}, settings);
  const inForce = resolveBotLsp(role, { lsp: value }, settings);
  const [expanded, setExpanded] = useState(() => pinned !== "");

  return (
    <CollapsibleSection title={t("area.settings-agent-card.agent-card-lsp-fields.title")} open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3">
        <Field
          label={t("area.settings-agent-card.agent-card-lsp-fields.modeLabel")}
          hint={t("area.settings-agent-card.agent-card-lsp-fields.modeHint")}
        >
          <select
            className={selectClass}
            aria-label={t("area.settings-agent-card.agent-card-lsp-fields.modeLabel")}
            data-testid="agent-lsp-mode"
            value={pinned}
            onChange={(event) => {
              const pick = event.target.value;
              onChange(botLspCardFor(isBotLspMode(pick) ? pick : ""));
            }}
          >
            <option value="">
              {byRole.coding
                ? t("area.settings-agent-card.agent-card-lsp-fields.byRoleWrites", { mode: BOT_LSP_MODE_LABELS[byRole.mode] })
                : t("area.settings-agent-card.agent-card-lsp-fields.byRoleNoWrites", { mode: BOT_LSP_MODE_LABELS[byRole.mode] })}
            </option>
            {BOT_LSP_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {BOT_LSP_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted-foreground" data-testid="agent-lsp-in-force">
          {t("area.settings-agent-card.agent-card-lsp-fields.inForce", {
            mode: BOT_LSP_MODE_LABELS[inForce.mode],
            hint: BOT_LSP_MODE_HINTS[inForce.mode],
          })}
        </p>
      </div>
    </CollapsibleSection>
  );
}
