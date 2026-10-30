import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modelApiPricingSettingsSchema, MODEL_API_PRICING_DEFAULTS, type ModelApiPricingSettings } from "@myrmidon/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";

function formatPrices(value: ModelApiPricingSettings): string {
  return JSON.stringify(value, null, 2);
}

export function ModelApiPricingSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => formatPrices(MODEL_API_PRICING_DEFAULTS));
  const [error, setError] = useState<string | null>(null);
  const settings = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: instanceSettingsApi.getGeneral,
  });
  useEffect(() => {
    if (settings.data) setDraft(formatPrices(settings.data.modelApiPricing ?? MODEL_API_PRICING_DEFAULTS));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (modelApiPricing: ModelApiPricingSettings) => instanceSettingsApi.updateGeneral({ modelApiPricing }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: () => setError(t("area.settings-models-runtime-1.model-api-pricing-settings-panel.saveFailed")),
  });
  const submit = () => {
    setError(null);
    let value: unknown;
    try {
      value = JSON.parse(draft);
    } catch {
      setError(t("area.settings-models-runtime-1.model-api-pricing-settings-panel.invalidJson"));
      return;
    }
    const parsed = modelApiPricingSettingsSchema.safeParse(value);
    if (!parsed.success) {
      setError(t("area.settings-models-runtime-1.model-api-pricing-settings-panel.invalidPrices"));
      return;
    }
    save.mutate(parsed.data);
  };

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid="model-api-pricing-settings">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-1.model-api-pricing-settings-panel.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-1.model-api-pricing-settings-panel.description")}</p>
      </div>
      <Textarea
        aria-label={t("area.settings-models-runtime-1.model-api-pricing-settings-panel.pricesLabel")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={8}
        spellCheck={false}
        disabled={save.isPending || settings.isPending}
        data-testid="model-api-pricing-input"
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {settings.isError && <p role="alert" className="text-sm text-destructive">{t("area.settings-models-runtime-1.model-api-pricing-settings-panel.loadFailed")}</p>}
      <Button type="button" onClick={submit} disabled={save.isPending || settings.isPending} data-testid="model-api-pricing-save">
        {t("area.settings-models-runtime-1.model-api-pricing-settings-panel.saveButton")}
      </Button>
    </section>
  );
}
