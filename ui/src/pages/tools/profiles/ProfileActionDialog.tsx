import { AlertTriangle } from "lucide-react";
import type { ToolProfileWithDetails } from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";

export type ProfileActionDialogKind = "archive" | "delete" | "restore";

export function ProfileActionDialog({
  kind,
  profile,
  pending,
  onClose,
  onArchive,
  onRestore,
  onDelete,
}: {
  kind: ProfileActionDialogKind | null;
  profile: ToolProfileWithDetails | null;
  pending: boolean;
  onClose: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  if (!kind || !profile) return null;

  const defaultDeleteBlocked = kind === "delete" && profile.summary.isCompanyDefault;
  const copy = {
    archive: {
      title: t("area.tools-profiles-1.profile-action-dialog.archiveTitle"),
      body: t("area.tools-profiles-1.profile-action-dialog.archiveBody", { count: profile.summary.appliesToAgentCount }),
      confirm: t("area.tools-profiles-1.profile-action-dialog.archiveConfirm"),
      action: onArchive,
    },
    restore: {
      title: t("area.tools-profiles-1.profile-action-dialog.restoreTitle"),
      body: t("area.tools-profiles-1.profile-action-dialog.restoreBody"),
      confirm: t("area.tools-profiles-1.profile-action-dialog.restoreConfirm"),
      action: onRestore,
    },
    delete: {
      title: t("area.tools-profiles-1.profile-action-dialog.deleteTitle"),
      body: defaultDeleteBlocked
        ? t("area.tools-profiles-1.profile-action-dialog.deleteBlockedBody")
        : t("area.tools-profiles-1.profile-action-dialog.deleteBody", { count: profile.summary.assignmentCount }),
      confirm: t("area.tools-profiles-1.profile-action-dialog.deleteConfirm"),
      action: onDelete,
    },
  }[kind];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {defaultDeleteBlocked ? (
          <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("area.tools-profiles-1.profile-action-dialog.deleteBlockedHint")}</span>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant={kind === "delete" ? "destructive" : "default"}
            disabled={pending || defaultDeleteBlocked}
            onClick={copy.action}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
