// ui/src/ui2/screens/settings/channels/Ui2ChannelAccessTab.tsx
//
// myrmidon(UI2-CHANNELS): Channel access tab in Settings → Channels (OPE-10143,
// screen 2.15 «Каналы и доступ», ia-v2 §2.3 item 13). Read-only view tier:
// layout and local draft state only — the react-query wiring (allowlist CRUD,
// the instance channel access mode, the bot endpoint list and the error
// surface) lives in Ui2ChannelAccessTabContainer.tsx. All user-visible strings
// come from the ui2 catalogs via useUi2I18n; no raw values, no hex (DESIGN.md
// token rule).
import { useMemo, useState } from "react";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2Section } from "../../../components/ui2Primitives";
import type { ChannelAllowedUser } from "./ui2ChannelAccessTabApi";

export interface Ui2ChannelEndpointOption {
  id: string;
  name: string;
}

export interface Ui2ChannelAllowlistDraft {
  provider: string;
  externalId: string;
  handle: string;
  scope: "company" | "endpoint";
  endpointId: string;
}

export const UI2_CHANNEL_PROVIDERS = ["telegram", "slack", "discord", "agentmail"] as const;

export const UI2_CHANNEL_ACCESS_MODES = ["sponsor", "allowlist"] as const;
export type Ui2ChannelAccessMode = (typeof UI2_CHANNEL_ACCESS_MODES)[number];

export const EMPTY_ACCESS_DRAFT: Ui2ChannelAllowlistDraft = {
  provider: "telegram",
  externalId: "",
  handle: "",
  scope: "company",
  endpointId: "",
};

export function canSubmitAccessDraft(draft: Ui2ChannelAllowlistDraft): boolean {
  return (
    draft.externalId.trim().length > 0 &&
    (draft.scope === "company" || draft.endpointId.trim().length > 0)
  );
}

export function endpointNameFromOptions(
  options: Ui2ChannelEndpointOption[],
): (endpointId: string | null) => string | null {
  const map = new Map(options.map((option) => [option.id, option.name]));
  return (endpointId: string | null) => (endpointId ? (map.get(endpointId) ?? endpointId) : null);
}

export interface Ui2ChannelAccessTabProps {
  accessMode: Ui2ChannelAccessMode;
  modeLocked: boolean;
  onSaveMode: (mode: Ui2ChannelAccessMode) => void;
  allowedUsers: ChannelAllowedUser[];
  endpoints: Ui2ChannelEndpointOption[];
  onAdd: (input: {
    provider: string;
    externalId: string;
    handle: string | null;
    scope: "company" | "endpoint";
    endpointId: string | null;
  }) => void;
  onRevoke: (id: string) => void;
  onRestore: (id: string) => void;
  pending: boolean;
  error: string | null;
}

export function Ui2ChannelAccessTabView({
  accessMode,
  modeLocked,
  onSaveMode,
  allowedUsers,
  endpoints,
  onAdd,
  onRevoke,
  onRestore,
  pending,
  error,
}: Ui2ChannelAccessTabProps) {
  const { t } = useUi2I18n();
  const [draft, setDraft] = useState<Ui2ChannelAllowlistDraft>(EMPTY_ACCESS_DRAFT);
  const endpointName = useMemo(() => endpointNameFromOptions(endpoints), [endpoints]);
  const canAdd = canSubmitAccessDraft(draft);

  const add = () => {
    if (!canAdd) return;
    onAdd({
      provider: draft.provider,
      externalId: draft.externalId.trim(),
      handle: draft.handle.trim() ? draft.handle.trim().replace(/^@+/, "") : null,
      scope: draft.scope,
      endpointId: draft.scope === "endpoint" ? draft.endpointId : null,
    });
    setDraft(EMPTY_ACCESS_DRAFT);
  };

  return (
    <div
      className="ui2-channel-access-tab max-w-3xl space-y-6"
      data-testid="ui2-channel-access-tab"
    >
      <Ui2Section title={t("ui2.settings.channels.access.modeTitle")}>
        <p className="text-sm text-muted-foreground">
          {t("ui2.settings.channels.access.modeSubtitle")}
        </p>
        {error ? (
          <div
            className="ui2-channel-access-error mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
            data-testid="ui2-channel-access-error"
          >
            {error}
          </div>
        ) : null}

        <div className="space-y-1">
          <label htmlFor="ui2-channel-access-mode" className="text-sm font-medium">
            {t("ui2.settings.channels.access.modeLabel")}
          </label>
          <select
            id="ui2-channel-access-mode"
            value={accessMode}
            disabled={modeLocked}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "sponsor" || value === "allowlist") onSaveMode(value);
            }}
            data-testid="ui2-channel-access-mode"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            {UI2_CHANNEL_ACCESS_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === "sponsor"
                  ? t("ui2.settings.channels.access.modeSponsor")
                  : t("ui2.settings.channels.access.modeAllowlist")}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground" data-testid="ui2-channel-access-mode-hint">
            {modeLocked
              ? t("ui2.settings.channels.access.modeOverridden")
              : t("ui2.settings.channels.access.modeHint")}
          </p>
        </div>
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.channels.access.listTitle")}>
        {allowedUsers.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="ui2-channel-access-list-empty">
            {t("ui2.settings.channels.access.listEmpty")}
          </p>
        ) : (
          <ul className="ui2-channel-access-list space-y-1" data-testid="ui2-channel-access-list">
            {allowedUsers.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-2 text-sm"
                data-testid={`ui2-channel-access-row-${row.id}`}
              >
                <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                  {row.provider}
                </span>
                <span className="font-mono">{row.externalId}</span>
                {row.handle ? (
                  <span className="text-muted-foreground">@{row.handle}</span>
                ) : null}
                <span className="text-muted-foreground">
                  {row.scope === "company"
                    ? t("ui2.settings.channels.access.scopeCompany")
                    : `${t("ui2.settings.channels.access.scopeEndpoint")}: ${endpointName(row.endpointId) ?? row.endpointId}`}
                </span>
                {row.status === "revoked" ? (
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                    data-testid={`ui2-channel-access-row-${row.id}-revoked`}
                  >
                    {t("ui2.settings.channels.access.revokedBadge")}
                  </span>
                ) : null}
                {row.status === "active" ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onRevoke(row.id)}
                    data-testid={`ui2-channel-access-revoke-${row.id}`}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("ui2.settings.channels.access.revoke")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onRestore(row.id)}
                    data-testid={`ui2-channel-access-restore-${row.id}`}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("ui2.settings.channels.access.restore")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Ui2Section>

      <Ui2Section title={t("ui2.settings.channels.access.addTitle")}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="ui2-channel-access-provider" className="text-xs font-medium">
              {t("ui2.settings.channels.access.providerLabel")}
            </label>
            <select
              id="ui2-channel-access-provider"
              value={draft.provider}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
              data-testid="ui2-channel-access-provider"
              className="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {UI2_CHANNEL_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="ui2-channel-access-external-id" className="text-xs font-medium">
              {t("ui2.settings.channels.access.externalIdLabel")}
            </label>
            <input
              id="ui2-channel-access-external-id"
              type="text"
              value={draft.externalId}
              onChange={(e) => setDraft({ ...draft, externalId: e.target.value })}
              data-testid="ui2-channel-access-external-id"
              className="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ui2-channel-access-handle" className="text-xs font-medium">
              {t("ui2.settings.channels.access.handleLabel")}
            </label>
            <input
              id="ui2-channel-access-handle"
              type="text"
              value={draft.handle}
              onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
              data-testid="ui2-channel-access-handle"
              className="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ui2-channel-access-scope" className="text-xs font-medium">
              {t("ui2.settings.channels.access.scopeLabel")}
            </label>
            <select
              id="ui2-channel-access-scope"
              value={draft.scope}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  scope: e.target.value === "endpoint" ? "endpoint" : "company",
                  endpointId:
                    e.target.value === "endpoint" ? (endpoints[0]?.id ?? "") : "",
                })
              }
              data-testid="ui2-channel-access-scope"
              className="w-44 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="company">
                {t("ui2.settings.channels.access.scopeCompany")}
              </option>
              <option value="endpoint">
                {t("ui2.settings.channels.access.scopeEndpoint")}
              </option>
            </select>
          </div>
          {draft.scope === "endpoint" ? (
            <div className="space-y-1">
              <label htmlFor="ui2-channel-access-endpoint" className="text-xs font-medium">
                {t("ui2.settings.channels.access.endpointLabel")}
              </label>
              <select
                id="ui2-channel-access-endpoint"
                value={draft.endpointId}
                onChange={(e) => setDraft({ ...draft, endpointId: e.target.value })}
                data-testid="ui2-channel-access-endpoint"
                className="w-56 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              >
                {endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>
                    {endpoint.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <button
            type="button"
            disabled={pending || !canAdd}
            onClick={add}
            data-testid="ui2-channel-access-add"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending
              ? t("ui2.settings.channels.access.saving")
              : t("ui2.settings.channels.access.add")}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("ui2.settings.channels.access.addHint")}
        </p>
      </Ui2Section>
    </div>
  );
}
