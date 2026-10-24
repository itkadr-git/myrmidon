// Channel settings (myrmidon 1.7-SETTINGS-TO-UI, SETTINGS-UI A): the
// "Channels (Telegram & chat bridges)" section of Instance → General. The
// Telegram bridge switches, the attachment ceilings and the cross-channel
// numbers, each with its origin (saved here, environment override, default).
// Saving writes `instance_settings.general.channelSettings`; the consumers
// re-resolve the effective value on use, so a change applies without a
// restart. A key the deployment environment pins shows its override read-only
// (`overridden` in the GET answer); `telegramApiBaseUrl` is deployment-only and
// is listed for reference.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { i18n, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  channelSettingsApi,
  channelSettingsQueryKey,
  describeChannelSettingSource,
  type ChannelSettingsPatch,
  type ChannelSettingsView,
  type ChannelSettingKey,
} from "./channelSettingsApi";

interface DraftParse {
  patch: ChannelSettingsPatch;
  errors: Partial<Record<string, string>>;
}

type NonNegativeKey =
  | "telegramSplitMaxParts"
  | "chatCrossChannelMessages"
  | "chatCrossChannelMessageChars"
  | "chatCrossChannelTotalChars"
  | "chatCrossChannelLookbackHours";

/** Integer >= 0; blank, malformed or negative is an error the panel refuses to save. */
function parseNonNegative(raw: string): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: i18n.t("area.settings-integrations.channel-settings-panel.errEnterNumber") };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { error: i18n.t("area.settings-integrations.channel-settings-panel.errNonNegative") };
  }
  return { value };
}

/**
 * Parse the channel-settings draft (the boolean switch is not part of it).
 * Positive-required fields (the file ceilings) reject 0; the split-part count
 * and the cross-channel numbers allow 0 (the documented "off" state); the
 * reconcile interval accepts an empty field as null ("today's pace").
 */
export function parseChannelSettingsDraft(draft: {
  telegramDmConversations: string;
  telegramSplitMaxParts: string;
  telegramFileLimitBytes: string;
  paperclipAttachmentMaxBytes: string;
  chatCrossChannelMessages: string;
  chatCrossChannelMessageChars: string;
  chatCrossChannelTotalChars: string;
  chatCrossChannelLookbackHours: string;
  chatReconcileIntervalMs: string;
}): DraftParse {
  const errors: Partial<Record<string, string>> = {};
  const patch: ChannelSettingsPatch = {
    telegramDmConversations: draft.telegramDmConversations.trim(),
  };

  const positive = (key: "telegramFileLimitBytes" | "paperclipAttachmentMaxBytes", raw: string) => {
    const { value, error } = parseNonNegative(raw);
    if (error) errors[key] = error;
    else if (!value || value <= 0) errors[key] = i18n.t("area.settings-integrations.channel-settings-panel.errPositive");
    else patch[key] = value;
  };
  const nonNegative = (key: NonNegativeKey, raw: string) => {
    const { value, error } = parseNonNegative(raw);
    if (error) errors[key] = error;
    else patch[key] = value;
  };

  nonNegative("telegramSplitMaxParts", draft.telegramSplitMaxParts);
  positive("telegramFileLimitBytes", draft.telegramFileLimitBytes);
  positive("paperclipAttachmentMaxBytes", draft.paperclipAttachmentMaxBytes);
  nonNegative("chatCrossChannelMessages", draft.chatCrossChannelMessages);
  nonNegative("chatCrossChannelMessageChars", draft.chatCrossChannelMessageChars);
  nonNegative("chatCrossChannelTotalChars", draft.chatCrossChannelTotalChars);
  nonNegative("chatCrossChannelLookbackHours", draft.chatCrossChannelLookbackHours);

  const reconcileRaw = draft.chatReconcileIntervalMs.trim();
  if (!reconcileRaw) {
    patch.chatReconcileIntervalMs = null;
  } else {
    const value = Number(reconcileRaw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.chatReconcileIntervalMs = i18n.t("area.settings-integrations.channel-settings-panel.errReconcile");
    } else {
      patch.chatReconcileIntervalMs = value;
    }
  }

  return { patch, errors };
}

type StringDraft = Record<
  Exclude<ChannelSettingKey, "telegramDmStatus">,
  string
> & { telegramDmStatus: boolean };

function toDraft(settings: ChannelSettingsView): StringDraft {
  return {
    telegramDmConversations: settings.telegramDmConversations.value,
    telegramDmStatus: settings.telegramDmStatus.value,
    telegramSplitMaxParts: String(settings.telegramSplitMaxParts.value),
    telegramFileLimitBytes: String(settings.telegramFileLimitBytes.value),
    paperclipAttachmentMaxBytes: String(settings.paperclipAttachmentMaxBytes.value),
    chatCrossChannelMessages: String(settings.chatCrossChannelMessages.value),
    chatCrossChannelMessageChars: String(settings.chatCrossChannelMessageChars.value),
    chatCrossChannelTotalChars: String(settings.chatCrossChannelTotalChars.value),
    chatCrossChannelLookbackHours: String(settings.chatCrossChannelLookbackHours.value),
    chatReconcileIntervalMs:
      settings.chatReconcileIntervalMs.value === null
        ? ""
        : String(settings.chatReconcileIntervalMs.value),
  };
}

const NUMERIC_FIELDS = [
  "telegramSplitMaxParts",
  "telegramFileLimitBytes",
  "paperclipAttachmentMaxBytes",
  "chatCrossChannelMessages",
  "chatCrossChannelMessageChars",
  "chatCrossChannelTotalChars",
  "chatCrossChannelLookbackHours",
  "chatReconcileIntervalMs",
] as const;

/** Labels are resolved at render time so a language switch applies at once. */
function fieldLabels(): Record<(typeof NUMERIC_FIELDS)[number], string> {
  return {
    telegramSplitMaxParts: i18n.t("area.settings-integrations.channel-settings-panel.labelSplitParts"),
    telegramFileLimitBytes: i18n.t("area.settings-integrations.channel-settings-panel.labelTelegramFile"),
    paperclipAttachmentMaxBytes: i18n.t("area.settings-integrations.channel-settings-panel.labelBoardAttachment"),
    chatCrossChannelMessages: i18n.t("area.settings-integrations.channel-settings-panel.labelCrossMessages"),
    chatCrossChannelMessageChars: i18n.t("area.settings-integrations.channel-settings-panel.labelCrossMessageChars"),
    chatCrossChannelTotalChars: i18n.t("area.settings-integrations.channel-settings-panel.labelCrossTotalChars"),
    chatCrossChannelLookbackHours: i18n.t("area.settings-integrations.channel-settings-panel.labelCrossLookback"),
    chatReconcileIntervalMs: i18n.t("area.settings-integrations.channel-settings-panel.labelReconcile"),
  };
}

function fieldHints(): Record<(typeof NUMERIC_FIELDS)[number] | "telegramDmConversations" | "telegramDmStatus", string> {
  return {
    telegramDmConversations: i18n.t("area.settings-integrations.channel-settings-panel.hintDmConversations"),
    telegramDmStatus: i18n.t("area.settings-integrations.channel-settings-panel.hintDmStatus"),
    telegramSplitMaxParts: i18n.t("area.settings-integrations.channel-settings-panel.hintSplitParts"),
    telegramFileLimitBytes: i18n.t("area.settings-integrations.channel-settings-panel.hintTelegramFile"),
    paperclipAttachmentMaxBytes: i18n.t("area.settings-integrations.channel-settings-panel.hintBoardAttachment"),
    chatCrossChannelMessages: i18n.t("area.settings-integrations.channel-settings-panel.hintCrossMessages"),
    chatCrossChannelMessageChars: i18n.t("area.settings-integrations.channel-settings-panel.hintCrossMessageChars"),
    chatCrossChannelTotalChars: i18n.t("area.settings-integrations.channel-settings-panel.hintCrossTotalChars"),
    chatCrossChannelLookbackHours: i18n.t("area.settings-integrations.channel-settings-panel.hintCrossLookback"),
    chatReconcileIntervalMs: i18n.t("area.settings-integrations.channel-settings-panel.hintReconcile"),
  };
}

function sourceLabel(view: ChannelSettingsView, key: ChannelSettingKey): string {
  return describeChannelSettingSource(view[key].source);
}

export function ChannelSettingsPanelView({
  view,
  onSave,
  pending,
  error,
  saved,
}: {
  view: ChannelSettingsView | null | undefined;
  onSave: (patch: ChannelSettingsPatch) => void;
  pending: boolean;
  error: string | null;
  saved: boolean;
}) {
  const { t } = useTranslation();
  const FIELD_LABELS = fieldLabels();
  const FIELD_HINTS = fieldHints();
  const [draft, setDraft] = useState<StringDraft | null>(null);

  const numbers = draft ?? (view ? toDraft(view) : null);
  const parsed = numbers ? parseChannelSettingsDraft(numbers) : null;
  const errors = parsed?.errors ?? {};

  if (!view || !numbers || !parsed) {
    return (
      <section className="space-y-4" data-testid="myrmidon-channel-settings">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-integrations.channel-settings-panel.title")}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t("area.settings-integrations.channel-settings-panel.loading")}</p>
      </section>
    );
  }

  const canSave = Object.keys(errors).length === 0;
  const currentPatch: ChannelSettingsPatch = {
    ...parsed.patch,
    telegramDmStatus: numbers.telegramDmStatus,
  };
  // Drop keys the environment pins: the server keeps honouring the override,
  // and saving them would only rewrite what the deployment already forces.
  for (const key of Object.keys(currentPatch) as ChannelSettingKey[]) {
    if (view[key].overridden) delete currentPatch[key];
  }

  const setField = (key: keyof Omit<StringDraft, "telegramDmStatus">, value: string) =>
    setDraft({ ...toDraft(view), ...numbers, [key]: value });

  return (
    <section className="space-y-4" data-testid="myrmidon-channel-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-integrations.channel-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-integrations.channel-settings-panel.description")}
        </p>
      </div>

      {saved && !pending && !error ? (
        <div role="status" data-testid="channel-settings-saved" className="text-sm text-muted-foreground">
          {t("area.settings-integrations.channel-settings-panel.saved")}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="channel-settings-save-error" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="channel-settings-telegramDmConversations">{t("area.settings-integrations.channel-settings-panel.dmEndpoints")}</Label>
          <Input
            id="channel-settings-telegramDmConversations"
            placeholder={t("area.settings-integrations.channel-settings-panel.emptyOff")}
            value={numbers.telegramDmConversations}
            onChange={(event) => setField("telegramDmConversations", event.target.value)}
            disabled={view.telegramDmConversations.overridden}
          />
          <div className="text-xs text-muted-foreground">
            <span data-testid="channel-settings-source-telegramDmConversations">
              {sourceLabel(view, "telegramDmConversations")}
            </span>
            {view.telegramDmConversations.overridden ? (
              <span className="ml-2 font-mono">{view.telegramDmConversations.envName}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{FIELD_HINTS.telegramDmConversations}</p>
        </div>

        <div className="space-y-2 md:col-span-2">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="channel-settings-telegramDmStatus">{t("area.settings-integrations.channel-settings-panel.dmStatus")}</Label>
              <p className="text-xs text-muted-foreground">
                <span data-testid="channel-settings-source-telegramDmStatus">
                  {sourceLabel(view, "telegramDmStatus")}
                </span>
                {view.telegramDmStatus.overridden ? (
                  <span className="ml-2 font-mono">{view.telegramDmStatus.envName}</span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">{FIELD_HINTS.telegramDmStatus}</p>
            </div>
            <ToggleSwitch
              id="channel-settings-telegramDmStatus"
              checked={numbers.telegramDmStatus}
              onCheckedChange={(checked) =>
                setDraft({ ...toDraft(view), ...numbers, telegramDmStatus: checked })
              }
              disabled={view.telegramDmStatus.overridden}
              data-testid="channel-settings-telegramDmStatus-toggle"
            />
          </div>
        </div>

        {NUMERIC_FIELDS.map((key) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`channel-settings-${key}`}>{FIELD_LABELS[key]}</Label>
            <Input
              id={`channel-settings-${key}`}
              inputMode="numeric"
              placeholder={key === "chatReconcileIntervalMs" ? t("area.settings-integrations.channel-settings-panel.standardPace") : t("area.settings-integrations.channel-settings-panel.required")}
              value={numbers[key]}
              onChange={(event) => setField(key, event.target.value)}
              disabled={view[key].overridden}
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid={`channel-settings-source-${key}`}>
                {sourceLabel(view, key as ChannelSettingKey)}
              </span>
              {view[key].overridden ? (
                <span className="ml-2 font-mono">{view[key].envName}</span>
              ) : null}
              {errors[key] ? (
                <span data-testid={`channel-settings-error-${key}`} className="ml-2 text-destructive">
                  {errors[key]}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{FIELD_HINTS[key]}</p>
          </div>
        ))}

        <div className="space-y-1 md:col-span-2 text-xs text-muted-foreground" data-testid="channel-settings-deployment-only">
          <span>{t("area.settings-integrations.channel-settings-panel.deploymentOnly")} </span>
          <span className="font-mono" data-testid="channel-settings-telegramApiBaseUrl">
            {view.telegramApiBaseUrl.value ?? t("area.settings-integrations.channel-settings-panel.unset")}
          </span>
          <span className="ml-2 font-mono">{view.telegramApiBaseUrl.envName}</span>
        </div>

        <div className="md:col-span-2">
          <Button
            type="button"
            size="sm"
            disabled={pending || !canSave}
            onClick={() => onSave(currentPatch)}
          >
            {pending ? t("area.settings-integrations.channel-settings-panel.saving") : t("area.settings-integrations.channel-settings-panel.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ChannelSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: channelSettingsQueryKey,
    queryFn: () => channelSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: channelSettingsApi.update,
    onMutate: () => {
      setError(null);
      setSaved(false);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : t("area.settings-integrations.channel-settings-panel.saveError")),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: channelSettingsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("area.settings-integrations.channel-settings-panel.loadError")}
      </div>
    );
  }

  return (
    <ChannelSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
      saved={saved}
    />
  );
}
