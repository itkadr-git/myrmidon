import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export function AiConnectionLegacyNotice({
  onAdopt,
  readOnly = false,
}: {
  onAdopt: () => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">
        {t("area.apps-connections-2.ai-connection-management.legacyTitle")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t("area.apps-connections-2.ai-connection-management.legacyDescription")}
      </p>
      {!readOnly && (
        <Button variant="outline" className="self-start" onClick={onAdopt}>
          {t("area.apps-connections-2.ai-connection-management.chooseButton")}
        </Button>
      )}
    </div>
  );
}
