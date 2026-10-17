// ui/src/components/myrmidon/IssueScentFields.tsx
//
// myrmidon(1.6.5 F-26 T10 SCENT): the scent block of the issue form.
//
// Shows the stored scent (tags, the three Jev complexity values, the top
// caste with its probability), the «авто» mark when caste_source is not
// manual, and the «переразметить» button that re-runs the classifier through
// POST …/myrmidon/companies/:companyId/issues/:issueId/scent/refresh.
//
// T2 mounts this into its issue form file; this component owns no layout.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { IssueScent } from "@paperclipai/shared";
import { ISSUE_SCENT_MAX_TAGS } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface IssueScentFieldsProps {
  companyId: string;
  issueId: string;
  scent: IssueScent | null | undefined;
  casteSource?: string | null;
}

const COMPLEXITY_LABELS: Record<keyof IssueScent["complexity"], string> = {
  coordination: "Координация",
  uncertainty: "Неопределённость",
  consequences: "Последствия",
};

export function IssueScentFields(props: IssueScentFieldsProps) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/myrmidon/companies/${props.companyId}/issues/${props.issueId}/scent/refresh`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error(`scent refresh failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues", props.issueId] });
    },
  });

  const scent = props.scent ?? null;
  const isAuto = (props.casteSource ?? "manual") !== "manual";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Запах задачи</span>
          {isAuto && <Badge variant="secondary">авто</Badge>}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          Переразметить
        </Button>
      </div>
      {scent ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          <div>
            Теги: {scent.tags.slice(0, ISSUE_SCENT_MAX_TAGS).join(", ") || "—"}
          </div>
          <div>
            Сложность:{" "}
            {(Object.keys(COMPLEXITY_LABELS) as (keyof IssueScent["complexity"])[])
              .map((k) => `${COMPLEXITY_LABELS[k]} ${scent.complexity[k].toFixed(2)}`)
              .join(" · ")}
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">Запах ещё не снят.</div>
      )}
      {refresh.isError && (
        <div className="text-sm text-destructive">
          Не удалось переразметить: {(refresh.error as Error).message}
        </div>
      )}
    </div>
  );
}
