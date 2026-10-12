// myrmidon(CA-A): the "Who may write to the bots" settings screen — view
// tier. Layout and local draft state only; the react-query wiring lives in
// ChannelAllowlistContainer.tsx.

import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
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
import type { ChannelAllowedUser } from "./channelAllowlistApi";

/** One bot endpoint option of the scope select. */
export interface EndpointOption {
  id: string;
  name: string;
}

interface AddDraft {
  provider: string;
  externalId: string;
  handle: string;
  scope: "company" | "endpoint";
  endpointId: string;
}

const EMPTY_DRAFT: AddDraft = {
  provider: "telegram",
  externalId: "",
  handle: "",
  scope: "company",
  endpointId: "",
};

export function ChannelAllowlistScreenView({
  allowedUsers,
  endpoints,
  accessMode,
  modeLocked,
  onSaveMode,
  onAdd,
  onRevoke,
  onRestore,
  pending,
  error,
}: {
  allowedUsers: ChannelAllowedUser[];
  endpoints: EndpointOption[];
  accessMode: "sponsor" | "allowlist";
  /** true when MYRMIDON_CHANNEL_ACCESS_MODE pins the value (read-only). */
  modeLocked: boolean;
  onSaveMode: (mode: "sponsor" | "allowlist") => void;
  onAdd: (draft: Omit<AddDraft, "handle" | "endpointId"> & {
    handle: string | null;
    endpointId: string | null;
  }) => void;
  onRevoke: (id: string) => void;
  onRestore: (id: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT);

  const endpointName = useMemo(() => {
    const map = new Map(endpoints.map((item) => [item.id, item.name]));
    return (id: string | null) => (id ? (map.get(id) ?? id) : null);
  }, [endpoints]);

  const canAdd = draft.externalId.trim().length > 0 && (draft.scope === "company" || draft.endpointId !== "");

  const add = () => {
    if (!canAdd) return;
    onAdd({
      provider: draft.provider,
      externalId: draft.externalId.trim(),
      handle: draft.handle.trim() ? draft.handle.trim().replace(/^@+/, "") : null,
      scope: draft.scope,
      endpointId: draft.scope === "endpoint" ? draft.endpointId : null,
    });
    setDraft(EMPTY_DRAFT);
  };

  return (
    <section className="space-y-4" data-testid="myrmidon-channel-allowlist">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("channelAllowlist.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("channelAllowlist.intro")}</p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="myrmidon-channel-allowlist-error"
        >
          {error}
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="channel-access-mode">{t("channelAllowlist.modeLabel")}</Label>
        <Select
          value={accessMode}
          disabled={modeLocked}
          onValueChange={(value) => {
            if (value === "sponsor" || value === "allowlist") onSaveMode(value);
          }}
        >
          <SelectTrigger id="channel-access-mode" className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sponsor">{t("channelAllowlist.modeSponsor")}</SelectItem>
            <SelectItem value="allowlist">{t("channelAllowlist.modeAllowlist")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-channel-allowlist-mode">
          {modeLocked ? t("channelAllowlist.modeOverridden") : t("channelAllowlist.modeHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("channelAllowlist.listLabel")}</Label>
        {allowedUsers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("channelAllowlist.listEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {allowedUsers.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 text-sm"
                data-testid={`channel-allowlist-row-${row.id}`}
              >
                <Badge variant="secondary">{row.provider}</Badge>
                <span className="font-mono">{row.externalId}</span>
                {row.handle ? <span className="text-muted-foreground">@{row.handle}</span> : null}
                <span className="text-muted-foreground">
                  {row.scope === "company"
                    ? t("channelAllowlist.scopeCompany")
                    : `${t("channelAllowlist.scopeEndpoint")}: ${endpointName(row.endpointId) ?? row.endpointId}`}
                </span>
                {row.status === "revoked" ? (
                  <Badge variant="outline">{t("channelAllowlist.revokedBadge")}</Badge>
                ) : null}
                {row.status === "active" ? (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => onRevoke(row.id)}>
                    {t("channelAllowlist.revoke")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => onRestore(row.id)}>
                    {t("channelAllowlist.restore")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <Label>{t("channelAllowlist.addLabel")}</Label>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="channel-allowlist-provider" className="text-xs">
              {t("channelAllowlist.providerLabel")}
            </Label>
            <Select
              value={draft.provider}
              onValueChange={(value) => setDraft({ ...draft, provider: value })}
            >
              <SelectTrigger id="channel-allowlist-provider" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="telegram">telegram</SelectItem>
                <SelectItem value="slack">slack</SelectItem>
                <SelectItem value="discord">discord</SelectItem>
                <SelectItem value="agentmail">agentmail</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="channel-allowlist-external-id" className="text-xs">
              {t("channelAllowlist.externalIdLabel")}
            </Label>
            <Input
              id="channel-allowlist-external-id"
              className="w-40"
              value={draft.externalId}
              onChange={(event) => setDraft({ ...draft, externalId: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="channel-allowlist-handle" className="text-xs">
              {t("channelAllowlist.handleLabel")}
            </Label>
            <Input
              id="channel-allowlist-handle"
              className="w-40"
              value={draft.handle}
              onChange={(event) => setDraft({ ...draft, handle: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="channel-allowlist-scope" className="text-xs">
              {t("channelAllowlist.scopeLabel")}
            </Label>
            <Select
              value={draft.scope}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  scope: value === "endpoint" ? "endpoint" : "company",
                  endpointId: value === "endpoint" ? (endpoints[0]?.id ?? "") : "",
                })
              }
            >
              <SelectTrigger id="channel-allowlist-scope" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="company">{t("channelAllowlist.scopeCompany")}</SelectItem>
                <SelectItem value="endpoint">{t("channelAllowlist.scopeEndpoint")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.scope === "endpoint" ? (
            <div className="space-y-1">
              <Label htmlFor="channel-allowlist-endpoint" className="text-xs">
                {t("channelAllowlist.endpointLabel")}
              </Label>
              <Select
                value={draft.endpointId}
                onValueChange={(value) => setDraft({ ...draft, endpointId: value })}
              >
                <SelectTrigger id="channel-allowlist-endpoint" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {endpoints.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Button type="button" size="sm" disabled={pending || !canAdd} onClick={add}>
            {t("channelAllowlist.add")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("channelAllowlist.addHint")}</p>
      </div>
    </section>
  );
}
