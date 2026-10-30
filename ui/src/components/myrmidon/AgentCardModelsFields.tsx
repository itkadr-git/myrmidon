import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { i18n, useTranslation } from "@/i18n";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import { defaultEffortForModel, effortsForModel } from "@/lib/card-effort-policy";

/**
 * myrmidon(M1): extra models on the agent card, stored as
 * `adapterConfig.models = { vision, video, stt, tts, fallbacks: [] }`.
 * The text model stays `adapterConfig.model`, the reasoning level stays the
 * vendor "Thinking effort" setting. Only model names are stored.
 *
 * myrmidon(BOT-TUNING-C): new fields wrap the compiler part B inputs —
 * `contextLength` (the model's context window in tokens, written to
 * `model.context_length`) and the auxiliary `titleGeneration` /
 * `compressionSummary` models (`auxiliary.title_generation.model` /
 * `auxiliary.compression.model`). They read and write
 * `adapterConfig.models` only.
 */
export type AgentCardModels = {
  vision?: string;
  video?: string;
  stt?: string;
  tts?: string;
  fallbacks?: string[];
  /** myrmidon(BOT-TUNING-C): explicit context window (tokens) for the card's model. */
  contextLength?: number;
  /** myrmidon(BOT-RUNTIME-TUNING-A): absolute compression threshold in tokens. */
  compressionThresholdTokens?: number;
  /** myrmidon(BOT-TUNING-C): model for auxiliary title generation. */
  titleGeneration?: string;
  /** myrmidon(BOT-TUNING-C): model for auxiliary compression summaries. */
  compressionSummary?: string;
};

type SingleModelKey = "vision" | "video" | "stt" | "tts";

const SINGLE_MODEL_KEYS: ReadonlyArray<SingleModelKey> = ["vision", "video", "stt", "tts"];

// Lazy: the language must be read at render time, not frozen at import.
const singleModelFields = (): ReadonlyArray<{ key: SingleModelKey; label: string; hint: string }> => [
  { key: "vision", label: i18n.t("area.settings-agent-card.agent-card-models-fields.visionLabel"), hint: i18n.t("area.settings-agent-card.agent-card-models-fields.visionHint") },
  { key: "video", label: i18n.t("area.settings-agent-card.agent-card-models-fields.videoLabel"), hint: i18n.t("area.settings-agent-card.agent-card-models-fields.videoHint") },
  { key: "stt", label: i18n.t("area.settings-agent-card.agent-card-models-fields.sttLabel"), hint: i18n.t("area.settings-agent-card.agent-card-models-fields.sttHint") },
  { key: "tts", label: i18n.t("area.settings-agent-card.agent-card-models-fields.ttsLabel"), hint: i18n.t("area.settings-agent-card.agent-card-models-fields.ttsHint") },
];

/** myrmidon(BOT-TUNING-C): the auxiliary model fields from the card block. */
const auxiliaryModelFields = (): ReadonlyArray<{
  key: "titleGeneration" | "compressionSummary";
  label: string;
  hint: string;
}> => [
  {
    key: "titleGeneration",
    label: i18n.t("area.settings-agent-card.agent-card-models-fields.titleGenerationLabel"),
    hint: i18n.t("area.settings-agent-card.agent-card-models-fields.titleGenerationHint"),
  },
  {
    key: "compressionSummary",
    label: i18n.t("area.settings-agent-card.agent-card-models-fields.compressionSummaryLabel"),
    hint: i18n.t("area.settings-agent-card.agent-card-models-fields.compressionSummaryHint"),
  },
];

/** Which card model fields each adapter applies to its runs. */
const SUPPORTED_FIELDS_BY_ADAPTER: Record<
  string,
  ReadonlySet<CardModelFieldKey>
> = {
  // Hermes has no separate video model; the run log warns when one is set.
  // BOT-TUNING-C: contextLength and the auxiliary models map to
  // model.context_length and auxiliary.title_generation/compression.
  hermes_local: new Set([
    "vision",
    "stt",
    "tts",
    "fallbacks",
    "contextLength",
    // myrmidon(BOT-RUNTIME-TUNING-A): the compression token cap.
    "compressionThresholdTokens",
    "titleGeneration",
    "compressionSummary",
  ]),
};

export type CardModelFieldKey =
  | SingleModelKey
  | "fallbacks"
  | "contextLength"
  | "compressionThresholdTokens"
  | "titleGeneration"
  | "compressionSummary";

export function isCardModelFieldSupported(adapterType: string, key: CardModelFieldKey): boolean {
  return SUPPORTED_FIELDS_BY_ADAPTER[adapterType]?.has(key) ?? false;
}

function normalize(value: unknown): AgentCardModels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as AgentCardModels;
}

/** Drop empty single fields so an untouched card stores nothing. */
export function compactCardModels(models: AgentCardModels): AgentCardModels | undefined {
  const next: AgentCardModels = {};
  for (const key of SINGLE_MODEL_KEYS) {
    const value = models[key]?.trim();
    if (value) next[key] = value;
  }
  // Empty rows stay while being edited; the server and the run ignore them.
  const fallbacks = (models.fallbacks ?? []).map((item) => item.trim());
  if (fallbacks.length > 0) next.fallbacks = fallbacks;
  // myrmidon(BOT-TUNING-C): the compiler part B fields compact the same way:
  // the context window only when a finite number, model names only when non-empty.
  if (typeof models.contextLength === "number" && Number.isFinite(models.contextLength)) {
    next.contextLength = models.contextLength;
  }
  // myrmidon(BOT-RUNTIME-TUNING-A): the compression cap compacts like the
  // context window (a finite number is kept; an empty field stores nothing).
  if (typeof models.compressionThresholdTokens === "number" && Number.isFinite(models.compressionThresholdTokens)) {
    next.compressionThresholdTokens = models.compressionThresholdTokens;
  }
  const title = models.titleGeneration?.trim();
  if (title) next.titleGeneration = title;
  const compression = models.compressionSummary?.trim();
  if (compression) next.compressionSummary = compression;
  return Object.keys(next).length > 0 ? next : undefined;
}

export type ModelPickerRenderer = (props: {
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => ReactNode;

function UnsupportedNote() {
  const { t } = useTranslation();
  return <p className="text-xs text-muted-foreground">{t("area.settings-agent-card.agent-card-models-fields.unsupported")}</p>;
}

/**
 * myrmidon(BOT-TUNING-C): the "Thinking effort" picker for the card. Only
 * the values the selected model accepts are offered (the UI twin of the
 * server effort policy, ui/src/lib/card-effort-policy); the model's safe
 * default wears a "default" badge, and an empty selection compiles to it.
 */
export function CardEffortPicker({
  model,
  value,
  onChange,
}: {
  /** The card's model (`adapterConfig.model`), used to pick the effort list. */
  model: string | undefined;
  value: string;
  onChange: (effort: string) => void;
}) {
  const { t } = useTranslation();
  const efforts = effortsForModel(model);
  const safeDefault = defaultEffortForModel(model);
  const selected = value || safeDefault;
  return (
    <Field label={t("area.settings-agent-card.agent-card-models-fields.effortLabel")} hint={t("area.settings-agent-card.agent-card-models-fields.effortHint")}>
      <div className="space-y-1" data-testid="myrmidon-card-effort-picker">
        <div className="flex flex-wrap items-center gap-1">
          {efforts.map((effort) => (
            <button
              key={effort}
              type="button"
              className={
                selected === effort
                  ? "rounded-md border border-border bg-accent px-2.5 py-1.5 text-sm transition-colors"
                  : "rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/50"
              }
              aria-pressed={selected === effort}
              data-effort={effort}
              onClick={() => onChange(value === effort ? "" : effort)}
            >
              {effort}
              {effort === safeDefault ? (
                <span className="ml-1.5 text-(length:--text-nano) text-muted-foreground" data-effort-default>
                  {t("area.settings-agent-card.agent-card-models-fields.effortDefaultBadge")}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-card-effort-hint">
          {value
            ? t("area.settings-agent-card.agent-card-models-fields.effortSelected", { value })
            : t("area.settings-agent-card.agent-card-models-fields.effortEmpty", { value: safeDefault })}
        </p>
      </div>
    </Field>
  );
}

/**
 * myrmidon(BOT-TUNING-C): the context window field, validated against the
 * same range the compiler part B enforces on `model.context_length`.
 */
const CONTEXT_LENGTH_MIN = 8_000;
const CONTEXT_LENGTH_MAX = 10_000_000;

/**
 * myrmidon(BOT-RUNTIME-TUNING-A): the card's compression token cap. Same
 * range the compiler enforces on `compression.threshold_tokens`, and the same
 * default the company applies when the card is empty (profile-input.ts
 * `BOT_DEFAULT_COMPRESSION_THRESHOLD_TOKENS`) — the field shows it as its
 * placeholder, so an empty field and an explicit 100000 compile the same.
 */
const COMPRESSION_THRESHOLD_MIN = 10_000;
const COMPRESSION_THRESHOLD_MAX = 2_000_000;
export const CARD_COMPRESSION_THRESHOLD_DEFAULT = 100_000;

function parseTokenCount(
  draft: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const n = Number(draft);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: i18n.t("area.settings-agent-card.agent-card-models-fields.tokensWhole", { label }) };
  }
  if (n < min || n > max) {
    return { ok: false, message: i18n.t("area.settings-agent-card.agent-card-models-fields.tokensRange", { label, min, max }) };
  }
  return { ok: true, value: n };
}

/**
 * The shared body of the card's numeric token fields (context window,
 * compression cap): a controlled text input that only reports whole numbers
 * inside the compiler's own range, and shows the range error in place.
 */
function TokenInputField({
  label,
  hint,
  placeholder,
  testId,
  value,
  min,
  max,
  labelForErrors,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  testId: string;
  value: number | undefined;
  min: number;
  max: number;
  labelForErrors: string;
  onChange: (tokens: number | undefined) => void;
}) {
  const shown = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const parsed = draft.trim() === "" ? ({ ok: true, value: undefined } as const) : parseTokenCount(draft, min, max, labelForErrors);
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={!parsed.ok}
        data-testid={testId}
        className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40"
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const next =
            event.target.value.trim() === ""
              ? ({ ok: true, value: undefined } as const)
              : parseTokenCount(event.target.value, min, max, labelForErrors);
          if (next.ok) onChange(next.value);
        }}
      />
      {!parsed.ok && (
        <p className="mt-1 text-xs text-amber-400" data-testid={`${testId}-error`}>
          {parsed.message}
        </p>
      )}
    </Field>
  );
}

export function CardContextLengthField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (tokens: number | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <TokenInputField
      label={t("area.settings-agent-card.agent-card-models-fields.contextLengthLabel")}
      hint={t("area.settings-agent-card.agent-card-models-fields.contextLengthHint")}
      placeholder={t("area.settings-agent-card.agent-card-models-fields.contextLengthPlaceholder")}
      testId="myrmidon-card-context-length"
      value={value}
      min={CONTEXT_LENGTH_MIN}
      max={CONTEXT_LENGTH_MAX}
      labelForErrors={t("area.settings-agent-card.agent-card-models-fields.contextLengthErrorLabel")}
      onChange={onChange}
    />
  );
}

/**
 * myrmidon(BOT-RUNTIME-TUNING-A): the compression token cap. Hermes compresses
 * at the lower of the ratio threshold and this count, so a large-window model
 * no longer grows a session to half its window before compacting.
 */
export function CardCompressionThresholdField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (tokens: number | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <TokenInputField
      label={t("area.settings-agent-card.agent-card-models-fields.compressionLabel")}
      hint={t("area.settings-agent-card.agent-card-models-fields.compressionHint", { value: CARD_COMPRESSION_THRESHOLD_DEFAULT })}
      placeholder={String(CARD_COMPRESSION_THRESHOLD_DEFAULT)}
      testId="myrmidon-card-compression-threshold"
      value={value}
      min={COMPRESSION_THRESHOLD_MIN}
      max={COMPRESSION_THRESHOLD_MAX}
      labelForErrors={t("area.settings-agent-card.agent-card-models-fields.compressionErrorLabel")}
      onChange={onChange}
    />
  );
}

export function AgentCardModelsFields({
  adapterType,
  value,
  onChange,
  renderModelPicker,
}: {
  adapterType: string;
  value: unknown;
  onChange: (next: AgentCardModels | undefined) => void;
  /** Same picker and model list as the main model field. */
  renderModelPicker: ModelPickerRenderer;
}) {
  const { t } = useTranslation();
  const models = normalize(value);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => compactCardModels(models) !== undefined);
  const fallbacks = models.fallbacks ?? [];

  const update = (patch: AgentCardModels) => onChange(compactCardModels({ ...models, ...patch }));
  const picker = (key: string, current: string, set: (id: string) => void) =>
    renderModelPicker({
      value: current,
      onChange: set,
      open: openKey === key,
      onOpenChange: (open) => setOpenKey(open ? key : null),
    });
  const moveFallback = (from: number, to: number) => {
    if (to < 0 || to >= fallbacks.length) return;
    const next = [...fallbacks];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    update({ fallbacks: next });
  };

  return (
    <CollapsibleSection title={t("area.settings-agent-card.agent-card-models-fields.title")} open={expanded} onToggle={() => setExpanded((open) => !open)}>
      <div className="space-y-3">
      {singleModelFields().map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          {picker(field.key, models[field.key] ?? "", (id) => update({ [field.key]: id }))}
          {!isCardModelFieldSupported(adapterType, field.key) && <UnsupportedNote />}
        </Field>
      ))}
      {/* myrmidon(BOT-TUNING-C): auxiliary models for title generation and compression. */}
      {auxiliaryModelFields().map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          {picker(field.key, models[field.key] ?? "", (id) => update({ [field.key]: id }))}
          {!isCardModelFieldSupported(adapterType, field.key) && <UnsupportedNote />}
        </Field>
      ))}
      {/* myrmidon(BOT-TUNING-C): explicit context window for the card's model. */}
      <Field label={t("area.settings-agent-card.agent-card-models-fields.contextLengthLabel")} hint={t("area.settings-agent-card.agent-card-models-fields.contextLengthHint")}>
        {isCardModelFieldSupported(adapterType, "contextLength") ? (
          <CardContextLengthField
            value={models.contextLength}
            onChange={(tokens) => update({ contextLength: tokens })}
          />
        ) : (
          <UnsupportedNote />
        )}
      </Field>
      {/* myrmidon(BOT-RUNTIME-TUNING-A): absolute compression token cap for this agent. */}
      <Field
        label={t("area.settings-agent-card.agent-card-models-fields.compressionLabel")}
        hint={t("area.settings-agent-card.agent-card-models-fields.compressionHint", { value: CARD_COMPRESSION_THRESHOLD_DEFAULT })}
      >
        {isCardModelFieldSupported(adapterType, "compressionThresholdTokens") ? (
          <CardCompressionThresholdField
            value={models.compressionThresholdTokens}
            onChange={(tokens) => update({ compressionThresholdTokens: tokens })}
          />
        ) : (
          <UnsupportedNote />
        )}
      </Field>
      <Field label={t("area.settings-agent-card.agent-card-models-fields.fallbackLabel")} hint={t("area.settings-agent-card.agent-card-models-fields.fallbackHint")}>
        <div className="space-y-2">
          {fallbacks.map((model, index) => (
            <div key={`${index}-${model}`} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                {picker(`fallback-${index}`, model, (id) => {
                  const next = [...fallbacks];
                  next[index] = id;
                  update({ fallbacks: next });
                })}
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={t("area.settings-agent-card.agent-card-models-fields.moveUp")} onClick={() => moveFallback(index, index - 1)}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("area.settings-agent-card.agent-card-models-fields.moveDown")} onClick={() => moveFallback(index, index + 1)}>
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("area.settings-agent-card.agent-card-models-fields.removeFallback")}
                onClick={() => update({ fallbacks: fallbacks.filter((_, i) => i !== index) })}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => update({ fallbacks: [...fallbacks, ""] })}>
            <Plus />
            {t("area.settings-agent-card.agent-card-models-fields.addFallback")}
          </Button>
          {!isCardModelFieldSupported(adapterType, "fallbacks") && <UnsupportedNote />}
        </div>
      </Field>
      </div>
    </CollapsibleSection>
  );
}
