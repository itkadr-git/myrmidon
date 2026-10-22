// Service models and limits (myrmidon 1.7 SETTINGS-TO-UI D): the "Models"
// section of Instance → General. LiteLLM cost sweep, bot runtime tuning, the
// CTO chat planner, the evals judge and the OCR limits, each with its origin
// (saved here, environment override, default). A key the environment pins is
// read-only. Consumers re-read the live settings on use: no restart.
// Service addresses and secret names stay in the environment.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  describeModelServiceSettingSource,
  modelServiceSettingsApi,
  modelServiceSettingsQueryKey,
  type ModelServiceSettingsPatch,
  type ModelServiceSettingsView,
} from "./modelServiceSettingsApi";

type FieldKind = "text" | "int" | "bool" | "map" | "backend";
interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
}

export const MODEL_SERVICE_FIELDS: Field[] = [
  { key: "litellmCostIntervalSec", label: "LiteLLM cost sweep interval, s", kind: "int" },
  { key: "botCompressionThresholdTokens", label: "Bot compression threshold, tokens", kind: "int", hint: "0 turns compression off." },
  { key: "botModelContextLengths", label: "Bot model context lengths", kind: "map", hint: "model=tokens, comma-separated." },
  { key: "botAuxTitleModel", label: "Bot auxiliary title model", kind: "text", hint: "Empty — not set." },
  { key: "botAuxCompressionModel", label: "Bot auxiliary compression model", kind: "text", hint: "Empty — not set." },
  { key: "botHelperModel", label: "Bot helper model", kind: "text" },
  { key: "ctoChatModel", label: "CTO chat model", kind: "text" },
  { key: "ctoChatTimeoutSec", label: "CTO chat timeout, s", kind: "int" },
  { key: "ctoChatMaxTasks", label: "CTO chat max tasks", kind: "int" },
  { key: "evalsModel", label: "Evals judge model", kind: "text" },
  { key: "evalsTimeoutSec", label: "Evals timeout, s", kind: "int" },
  { key: "evalsLangfuseExport", label: "Evals Langfuse export", kind: "bool" },
  { key: "ocrBackend", label: "OCR backend", kind: "backend" },
  { key: "ocrModel", label: "OCR model", kind: "text" },
  { key: "ocrMaxBytes", label: "OCR max bytes", kind: "int" },
  { key: "ocrMaxPages", label: "OCR max pages", kind: "int" },
  { key: "ocrMaxChars", label: "OCR max characters", kind: "int" },
  { key: "ocrTimeoutSec", label: "OCR timeout, s", kind: "int" },
];

function toText(field: Field, value: unknown): string {
  if (field.kind === "map") {
    return Object.entries((value ?? {}) as Record<string, number>)
      .map(([model, tokens]) => `${model}=${tokens}`)
      .join(",");
  }
  if (field.kind === "bool") return value ? "true" : "false";
  return value === null || value === undefined ? "" : String(value);
}

/** Parse one draft entry; returns an error string or the patch value. */
export function parseModelServiceField(
  field: Field,
  raw: string,
): { value: string | number | boolean | Record<string, number> } | { error: string } {
  const text = raw.trim();
  if (field.kind === "text") return { value: text };
  if (field.kind === "backend") {
    return text === "ragflow" || text === "litellm" ? { value: text } : { error: "ragflow or litellm" };
  }
  if (field.kind === "bool") return { value: text === "true" };
  if (field.kind === "int") {
    const n = Number(text);
    return text !== "" && Number.isSafeInteger(n) && n >= 0 ? { value: n } : { error: "Enter a whole number" };
  }
  const map: Record<string, number> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [model, tokens] = part.split("=").map((p) => p.trim());
    const n = Number(tokens);
    if (!model || !Number.isSafeInteger(n) || n <= 0) return { error: "Use model=tokens, comma-separated" };
    map[model] = n;
  }
  return { value: map };
}

export function ModelServiceSettingsPanelView({
  view,
  onSave,
  pending,
  error,
  saved,
}: {
  view: ModelServiceSettingsView | null | undefined;
  onSave: (patch: ModelServiceSettingsPatch) => void;
  pending: boolean;
  error: string | null;
  saved: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!view) {
    return (
      <section className="space-y-4" data-testid="myrmidon-model-service-settings">
        <h2 className="text-sm font-semibold">Service models &amp; limits</h2>
        <p className="text-sm text-muted-foreground">Loading model settings...</p>
      </section>
    );
  }
  const current = (field: Field) => draft[field.key] ?? toText(field, view.settings[field.key]);
  const errors: Record<string, string> = {};
  const patch: ModelServiceSettingsPatch = {};
  for (const field of MODEL_SERVICE_FIELDS) {
    if (view.sources[field.key] === "env") continue;
    if (draft[field.key] === undefined) continue;
    const parsed = parseModelServiceField(field, draft[field.key]);
    if ("error" in parsed) errors[field.key] = parsed.error;
    else patch[field.key] = parsed.value;
  }
  const canSave = Object.keys(errors).length === 0 && Object.keys(patch).length > 0;

  return (
    <section className="space-y-4" data-testid="myrmidon-model-service-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Service models &amp; limits</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Cost sweep, bot tuning, CTO chat, evals judge and OCR limits. Changes apply without a restart; an
          environment variable stays a forced override and is shown read-only. Service addresses and secret
          names are set in the environment.
        </p>
      </div>
      {saved && !pending && !error ? (
        <div role="status" data-testid="model-service-saved" className="text-sm text-muted-foreground">
          Model settings saved.
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="model-service-save-error" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {MODEL_SERVICE_FIELDS.map((field) => {
          const pinned = view.sources[field.key] === "env";
          return (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`model-service-${field.key}`}>{field.label}</Label>
              {field.kind === "bool" ? (
                <input
                  id={`model-service-${field.key}`}
                  type="checkbox"
                  checked={current(field) === "true"}
                  disabled={pinned}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.checked ? "true" : "false" })}
                />
              ) : (
                <Input
                  id={`model-service-${field.key}`}
                  value={current(field)}
                  disabled={pinned}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              )}
              <div className="text-xs text-muted-foreground">
                <span data-testid={`model-service-source-${field.key}`}>
                  {describeModelServiceSettingSource(view.sources[field.key])}
                </span>
                {errors[field.key] ? (
                  <span data-testid={`model-service-error-${field.key}`} className="ml-2 text-destructive">
                    {errors[field.key]}
                  </span>
                ) : null}
              </div>
              {field.hint ? <p className="text-xs text-muted-foreground">{field.hint}</p> : null}
            </div>
          );
        })}
        <div className="md:col-span-2">
          <Button type="button" size="sm" disabled={pending || !canSave} onClick={() => onSave(patch)}>
            {pending ? "Saving..." : "Save model settings"}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ModelServiceSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: modelServiceSettingsQueryKey,
    queryFn: () => modelServiceSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: modelServiceSettingsApi.update,
    onMutate: () => {
      setError(null);
      setSaved(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the model settings failed."),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: modelServiceSettingsQueryKey });
    },
  });
  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load model settings."}
      </div>
    );
  }
  return (
    <ModelServiceSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
      saved={saved}
    />
  );
}
