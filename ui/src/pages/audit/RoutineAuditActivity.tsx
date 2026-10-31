import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { routinesApi } from "@/api/routines";
import { EmptyState } from "@/components/EmptyState";
import { RoutineActivityRow } from "@/components/RoutineActivityRow";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

export function RoutineAuditActivity({
  companyId,
  routineId,
}: {
  companyId: string;
  routineId: string;
}) {
  const { t } = useTranslation();
  const activity = useQuery({
    queryKey: [...queryKeys.routines.activity(companyId, routineId), "audit"],
    queryFn: async () => {
      const [routine, runs] = await Promise.all([
        routinesApi.get(routineId),
        routinesApi.listRuns(routineId, 200),
      ]);
      return routinesApi.activity(companyId, routineId, {
        triggerIds: routine.triggers.map((trigger) => trigger.id),
        runIds: runs.map((run) => run.id),
      });
    },
  });

  if (activity.isLoading) {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
        {t("area.search-timeline-audit-2.routine-audit-activity.loading")}
      </div>
    );
  }

  if (activity.error) {
    return (
      <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
        <p className="text-sm text-muted-foreground">
          {activity.error instanceof Error ? activity.error.message : t("area.search-timeline-audit-2.routine-audit-activity.loadFailed")}
        </p>
        <Button variant="outline" size="sm" onClick={() => activity.refetch()}>
          {t("area.search-timeline-audit-2.routine-audit-activity.tryAgain")}
        </Button>
      </div>
    );
  }

  const events = activity.data ?? [];
  if (events.length === 0) {
    return <EmptyState icon={Activity} message={t("area.search-timeline-audit-2.routine-audit-activity.empty")} />;
  }

  return (
    <div className="border-y border-border" aria-label={t("area.search-timeline-audit-2.routine-audit-activity.listLabel")}>
      {events.map((event) => (
        <RoutineActivityRow key={event.id} event={event} />
      ))}
    </div>
  );
}
