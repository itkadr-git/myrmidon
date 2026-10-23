import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CornerDownRight,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type {
  IssueQueuedCommentEntry,
  IssueQueuedCommentQueue,
} from "@myrmidon/shared";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type QueueAction = "steer" | "interrupt" | "discard" | null;

export function reorderQueuedMessageEntries(
  entries: IssueQueuedCommentEntry[],
  activeId: string,
  overId: string,
) {
  // myrmidon(UPSTREAM-13539): an immutable interaction response freezes the queue.
  if (entries.some((entry) => entry.source?.kind === "interaction")) return null;
  const from = entries.findIndex((entry) => entry.comment.id === activeId);
  const to = entries.findIndex((entry) => entry.comment.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(entries, from, to).map((entry, position) => ({
    ...entry,
    position,
  }));
}

function queueActionErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const directCode = (body as { code?: unknown }).code;
  if (typeof directCode === "string") return directCode;
  const details = (body as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const detailCode = (details as { code?: unknown }).code;
  return typeof detailCode === "string" ? detailCode : null;
}

export interface TaskChatQueuedMessagesProps {
  queue: IssueQueuedCommentQueue;
  onEdit: (commentId: string) => void;
  onReorder: (orderedCommentIds: string[], revision: string) => Promise<void>;
  onSteer: (commentId: string, revision: string) => Promise<void>;
  onInterrupt?: () => Promise<void>;
  onDiscard: (commentId: string, revision: string) => Promise<void>;
}

function SortableQueuedMessage({
  entry,
  queue,
  busy,
  queueMutationDisabled,
  action,
  onEdit,
  onSteer,
  onInterrupt,
  onDiscard,
}: {
  entry: IssueQueuedCommentEntry;
  queue: IssueQueuedCommentQueue;
  busy: boolean;
  queueMutationDisabled: boolean;
  action: QueueAction;
  onEdit: () => void;
  onSteer: () => void;
  onInterrupt?: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  // myrmidon(UPSTREAM-13539): interaction-projected responses are immutable —
  // no drag/reorder, no edit/discard; label is the body's first line.
  const immutableResponse = entry.source?.kind === "interaction";
  const label = immutableResponse ? entry.comment.body.split("\n")[0] : entry.comment.body;
  const sortable = useSortable({
    id: entry.comment.id,
    disabled: queueMutationDisabled || immutableResponse,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const steerDisabled =
    queueMutationDisabled || queue.steeringDisposition !== "available";
  const steerTitle =
    queue.steeringDisposition === "unsupported"
      ? t("area.task-chat-2.queued-messages.steerUnsupported")
      : queue.steeringDisposition === "temporarily_unavailable"
        ? t("area.task-chat-2.queued-messages.steerTemporarilyUnavailable")
        : t("area.task-chat-2.queued-messages.steerTitle");

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group flex h-11 min-w-0 items-center gap-1 border-b border-border/55 bg-card/95 px-2.5 text-sm last:border-b-0",
        sortable.isDragging &&
          "relative z-20 rounded-lg border border-border shadow-lg",
      )}
      data-testid={`task-chat-queued-message-${entry.comment.id}`}
    >
      <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        disabled={queueMutationDisabled || immutableResponse}
        aria-label={t("area.task-chat-2.queued-messages.reorderAria", { body: entry.comment.body })}
        className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>

      <CornerDownRight
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate px-1" title={entry.comment.body}>
        {label}
      </span>

      {queue.protocol === "legacy" || entry.source?.requiresFreshSession ? (
        <button
          type="button"
          onClick={onInterrupt}
          disabled={busy || !queue.queueId || !onInterrupt}
          title={queue.targetRunId ? t("area.task-chat-2.queued-messages.interruptTitle") : t("area.task-chat-2.queued-messages.sendNowTitle")}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          data-testid={`task-chat-queued-interrupt-${entry.comment.id}`}
        >
          {action === "interrupt" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {t("area.task-chat-2.queued-messages.interrupt")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onSteer}
          disabled={steerDisabled}
          title={steerTitle}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          data-testid={`task-chat-queued-steer-${entry.comment.id}`}
        >
          {action === "steer" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {t("area.task-chat-2.queued-messages.steer")}
        </button>
      )}

      <button
        type="button"
        onClick={onDiscard}
        disabled={
          busy ||
          (!queue.queueId && !entry.comment.id.startsWith("optimistic-")) ||
          !entry.canDiscard
        }
        title={t("area.task-chat-2.queued-messages.discardTitle")}
        aria-label={t("area.task-chat-2.queued-messages.discardAria", { body: entry.comment.body })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        data-testid={`task-chat-queued-discard-${entry.comment.id}`}
      >
        {action === "discard" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={queueMutationDisabled || immutableResponse}
            title={t("area.task-chat-2.queued-messages.actionsTitle")}
            aria-label={t("area.task-chat-2.queued-messages.actionsAria", { body: entry.comment.body })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={!entry.canEdit} onSelect={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden />
            {t("area.task-chat-2.queued-messages.editMessage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Compact production queue shown immediately above the default task composer. */
export function TaskChatQueuedMessages({
  queue,
  onEdit,
  onReorder,
  onSteer,
  onInterrupt,
  onDiscard,
}: TaskChatQueuedMessagesProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState(queue.entries);
  const [pending, setPending] = useState<{
    commentId: string;
    action: Exclude<QueueAction, null>;
  } | null>(null);
  const [reordering, setReordering] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [visibleError, setVisibleError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    setEntries(queue.entries);
  }, [queue.entries, queue.revision]);

  const ids = useMemo(
    () => entries.map((entry) => entry.comment.id),
    [entries],
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (
      !queue.queueId ||
      !over ||
      active.id === over.id ||
      reordering ||
      pending
    )
      return;
    const previous = entries;
    const next = reorderQueuedMessageEntries(
      entries,
      String(active.id),
      String(over.id),
    );
    if (!next) return;
    const orderedIds = next.map((entry) => entry.comment.id);
    const activeCommentId = String(active.id);
    const to = next.findIndex((entry) => entry.comment.id === activeCommentId);
    setEntries(next);
    setReordering(true);
    setVisibleError(null);
    setAnnouncement(
      t("area.task-chat-2.queued-messages.moved", { position: to + 1, total: next.length }),
    );
    try {
      await onReorder(orderedIds, queue.revision);
    } catch (error) {
      setEntries(previous);
      setAnnouncement("");
      setVisibleError(
        queueActionErrorCode(error) === "queued_comment_revision_conflict"
          ? t("area.task-chat-2.queued-messages.reorderConflict")
          : t("area.task-chat-2.queued-messages.reorderFailed"),
      );
    } finally {
      setReordering(false);
    }
  }

  async function runRowAction(
    commentId: string,
    action: Exclude<QueueAction, null>,
  ) {
    const locallyDiscardable =
      action === "discard" && commentId.startsWith("optimistic-");
    if (
      pending ||
      reordering ||
      (!queue.queueId && action !== "interrupt" && !locallyDiscardable)
    ) {
      return;
    }
    const previous = entries;
    setPending({ commentId, action });
    setVisibleError(null);
    setAnnouncement(
      action === "steer"
        ? t("area.task-chat-2.queued-messages.announceSteering")
        : action === "interrupt"
          ? t("area.task-chat-2.queued-messages.announceInterrupting")
          : t("area.task-chat-2.queued-messages.announceDiscarding"),
    );
    if (action === "steer") {
      setEntries((current) =>
        current.filter((entry) => entry.comment.id !== commentId),
      );
    }
    try {
      if (action === "steer") await onSteer(commentId, queue.revision);
      else if (action === "interrupt") await onInterrupt?.();
      else await onDiscard(commentId, queue.revision);
      if (action === "discard") {
        setEntries((current) =>
          current.filter((entry) => entry.comment.id !== commentId),
        );
      }
      setAnnouncement(
        action === "steer"
          ? t("area.task-chat-2.queued-messages.announceSteered")
          : action === "interrupt"
            ? t("area.task-chat-2.queued-messages.announceInterrupted")
            : t("area.task-chat-2.queued-messages.announceDiscarded"),
      );
    } catch (error) {
      if (action === "steer") setEntries(previous);
      setAnnouncement("");
      const code = queueActionErrorCode(error);
      setVisibleError(
        code === "queued_comment_already_dispatching"
          ? t("area.task-chat-2.queued-messages.errTooLate")
          : action === "steer"
            ? t("area.task-chat-2.queued-messages.errSteer")
            : action === "interrupt"
              ? t("area.task-chat-2.queued-messages.errInterrupt")
              : code === "queued_comment_revision_conflict"
                ? t("area.task-chat-2.queued-messages.errConflict")
                : t("area.task-chat-2.queued-messages.errDiscard"),
      );
    } finally {
      setPending(null);
    }
  }

  if (entries.length === 0) return null;

  return (
    <div
      className="relative z-0 mx-3 -mb-px overflow-hidden rounded-t-xl rounded-b-none border border-b-0 border-border/75 bg-card shadow-sm"
      data-testid="task-chat-queued-messages"
      aria-label={t("area.task-chat-2.queued-messages.listAria")}
    >
      {queue.executionWait && (
        <div role="status" aria-live="polite" className="px-3 py-1.5 text-xs text-muted-foreground">
          {queue.executionWait.message}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {entries.map((entry) => {
            const action =
              pending?.commentId === entry.comment.id ? pending.action : null;
            const busy = Boolean(pending || reordering);
            const queueMutationDisabled = Boolean(
              !queue.queueId || pending || reordering,
            );
            return (
              <SortableQueuedMessage
                key={entry.comment.id}
                entry={entry}
                queue={queue}
                busy={busy}
                queueMutationDisabled={queueMutationDisabled}
                action={action}
                onEdit={() => onEdit(entry.comment.id)}
                onSteer={() => void runRowAction(entry.comment.id, "steer")}
                onInterrupt={
                  onInterrupt
                    ? () => void runRowAction(entry.comment.id, "interrupt")
                    : undefined
                }
                onDiscard={() => void runRowAction(entry.comment.id, "discard")}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {visibleError ? (
        <div
          role="status"
          aria-live="polite"
          className="border-t border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
        >
          {visibleError}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
