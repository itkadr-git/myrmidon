import { Database, Gauge, ReceiptText } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const K = "area.costs-budgets-1.accounting-model-card";

const surfaces = (t: TFunction) => [
  {
    title: t(`${K}.inference.title`),
    description: t(`${K}.inference.description`),
    icon: Database,
    points: [t(`${K}.inference.point1`), t(`${K}.inference.point2`), t(`${K}.inference.point3`)],
    tone: "from-sky-500/12 via-sky-500/6 to-transparent",
  },
  {
    title: t(`${K}.finance.title`),
    description: t(`${K}.finance.description`),
    icon: ReceiptText,
    points: [t(`${K}.finance.point1`), t(`${K}.finance.point2`), t(`${K}.finance.point3`)],
    tone: "from-amber-500/14 via-amber-500/6 to-transparent",
  },
  {
    title: t(`${K}.quotas.title`),
    description: t(`${K}.quotas.description`),
    icon: Gauge,
    points: [t(`${K}.quotas.point1`), t(`${K}.quotas.point2`), t(`${K}.quotas.point3`)],
    tone: "from-emerald-500/14 via-emerald-500/6 to-transparent",
  },
] as const;

export function AccountingModelCard() {
  const { t } = useTranslation();
  return (
    <Card className="relative overflow-hidden border-border/70">
      <div className="absolute inset-0 bg-(image:--gradient-extract-3)" />
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
          {t("area.costs-budgets-1.accounting-model-card.title")}
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">
          {t("area.costs-budgets-1.accounting-model-card.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {surfaces(t).map((surface) => {
          const Icon = surface.icon;
          return (
            <div
              key={surface.title}
              className={`rounded-2xl border border-border/70 bg-gradient-to-br ${surface.tone} p-4 shadow-sm`}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-background/80">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{surface.title}</div>
                  <div className="text-xs text-muted-foreground">{surface.description}</div>
                </div>
              </div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                {surface.points.map((point) => (
                  <div key={point}>{point}</div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
