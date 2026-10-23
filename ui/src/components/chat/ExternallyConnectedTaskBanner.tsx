import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Paperclip, Radio } from "lucide-react";
import type {
  ChatPublicationState,
  ChatFileTransferPhase,
  IssueAttachment,
} from "@paperclipai/shared";
import {
  chatEndpointsApi,
  type ChatProvider,
  type ChatPublicationSummary,
  type ExternalChannelBindingSummary,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { issuesApi } from "@/api/issues";
import { i18n, useTranslation } from "@/i18n";
import {
  boardSendDraftKey,
  clearBoardSendDraft,
  canDismissBoardSendBatch,
  readBoardSendDraft,
  readBoardSendRejection,
  writeBoardSendDraft,
  type BoardSendRejection,
  type RetainedBoardSend,
} from "./board-send-draft";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  agentmail: "AgentMail",
  "imessage-photon": "iMessage Photon",
};

type PublicationFeedback = {
  title: string;
  body: string;
  tone: "info" | "success" | "warn" | "error";
};

// Built on demand so the text follows the active language.
function publicationFeedback(state: ChatPublicationState): PublicationFeedback {
  const table: Record<ChatPublicationState, PublicationFeedback> = {
    awaiting_consent: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.awaitingConsent.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.awaitingConsent.body"),
      tone: "info",
    },
    published: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.published.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.published.body"),
      tone: "success",
    },
    pending: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.pending.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.pending.body"),
      tone: "info",
    },
    streaming: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.streaming.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.streaming.body"),
      tone: "info",
    },
    retry: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.retry.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.retry.body"),
      tone: "warn",
    },
    delivery_unknown: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.deliveryUnknown.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.deliveryUnknown.body"),
      tone: "warn",
    },
    failed: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.failed.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.failed.body"),
      tone: "error",
    },
    cancelled: {
      title: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.cancelled.title"),
      body: i18n.t("area.apps-chat-email.externally-connected-task-banner.feedback.cancelled.body"),
      tone: "info",
    },
  };
  return table[state];
}

function filePhaseLabel(phase: ChatFileTransferPhase): string {
  const table: Record<ChatFileTransferPhase, string> = {
    consent_pending: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.consentPending"),
    consent_sending: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.consentSending"),
    consent_unknown: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.consentUnknown"),
    awaiting_consent: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.awaitingConsent"),
    upload_pending: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.uploadPending"),
    uploading: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.uploading"),
    upload_unknown: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.uploadUnknown"),
    file_info_pending: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.fileInfoPending"),
    file_info_sending: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.fileInfoSending"),
    file_info_unknown: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.fileInfoUnknown"),
    delivered: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.delivered"),
    declined: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.declined"),
    expired: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.expired"),
    cancelled: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.cancelled"),
    conflict: i18n.t("area.apps-chat-email.externally-connected-task-banner.filePhase.conflict"),
  };
  return table[phase];
}

export function useIssueChatBinding(companyId: string, issueId: string) {
  const { enabled } = useChatConnectorsEnabled();
  const queryEnabled = enabled && Boolean(companyId && issueId) && !issueId.startsWith("chat:");
  const query = useQuery({
    queryKey: ["issue-chat-binding", companyId, issueId],
    queryFn: () => chatEndpointsApi.getIssueBinding(issueId),
    enabled: queryEnabled,
  });
  return {
    binding: queryEnabled ? (query.data ?? null) : null,
    isLoading: queryEnabled && query.isLoading,
  };
}

type ConnectedTaskProps = {
  attachments?: IssueAttachment[];
  companyId: string;
  issueId: string;
  issueCacheRefs?: string[];
};

export function ExternallyConnectedTaskBanner(props: ConnectedTaskProps) {
  const { binding } = useIssueChatBinding(props.companyId, props.issueId);
  if (!binding || binding.provider === "agentmail") return null;
  return (
    <ConnectedTaskComposer
      key={boardSendDraftKey(
        props.companyId,
        props.issueId,
        binding.endpointId,
        binding.conversationId,
      )}
      {...props}
      binding={binding}
    />
  );
}

function ConnectedTaskComposer({
  attachments = [],
  companyId,
  issueId,
  issueCacheRefs,
  binding,
}: ConnectedTaskProps & { binding: ExternalChannelBindingSummary }) {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState("");
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>(
    [],
  );
  const [publication, setPublication] = useState<ChatPublicationSummary | null>(
    null,
  );
  const idempotencyKey = useRef<string | null>(null);
  const retainedSend = useRef<RetainedBoardSend | null>(null);
  const retainedScopeKey = useRef<string | null>(null);
  const [unconfirmedRequest, setUnconfirmedRequest] = useState(false);
  const [rejection, setRejection] = useState<BoardSendRejection | null>(null);
  const [excludedAttachmentIds, setExcludedAttachmentIds] = useState<string[]>(
    [],
  );
  const [selectionNotice, setSelectionNotice] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadInFlight = useRef(false);
  const mounted = useRef(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedAttachments, setUploadedAttachments] = useState<
    IssueAttachment[]
  >([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const storageKey = binding
    ? boardSendDraftKey(
        companyId,
        issueId,
        binding.endpointId,
        binding.conversationId,
      )
    : null;
  const loadedStorageKey = useRef<string | null>(null);
  useEffect(() => {
    if (!storageKey || loadedStorageKey.current === storageKey) return;
    loadedStorageKey.current = storageKey;
    try {
      const saved = readBoardSendDraft(storageKey);
      retainedScopeKey.current = storageKey;
      retainedSend.current = saved;
      idempotencyKey.current = saved?.idempotencyKey ?? null;
      setBody(saved?.body ?? "");
      setSelectedAttachmentIds(saved?.attachmentIds ?? []);
      setPublication(saved?.publication ?? null);
      setUnconfirmedRequest(
        Boolean(saved && !saved.publication && !saved.rejection),
      );
      setRejection(saved?.rejection ?? null);
      setComposing(Boolean(saved));
      setStorageError(null);
    } catch {
      setStorageError(i18n.t("area.apps-chat-email.externally-connected-task-banner.storageReadFailed"));
      setComposing(true);
    }
  }, [storageKey]);
  const deliveryScopeReady = Boolean(
    storageKey &&
    loadedStorageKey.current === storageKey &&
    retainedScopeKey.current === storageKey,
  );
  const invalidateTask = useCallback(() => {
    for (const ref of new Set([issueId, ...(issueCacheRefs ?? [])])) {
      for (const queryKey of [
        queryKeys.issues.comments(ref),
        queryKeys.issues.attachments(ref),
        queryKeys.issues.detail(ref),
        queryKeys.issues.activity(ref),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  }, [issueId, issueCacheRefs, queryClient]);
  const finishPublication = useCallback(() => {
    if (storageKey) {
      try {
        clearBoardSendDraft(storageKey);
      } catch {
        /* The retained anchor remains safe to recheck after reload. */
      }
    }
    retainedSend.current = null;
    setUnconfirmedRequest(false);
    setRejection(null);
    setSelectionNotice(false);
    setPublication(null);
    idempotencyKey.current = null;
    setBody("");
    setSelectedAttachmentIds([]);
    setUploadedAttachments([]);
    setUploadError(null);
    setComposing(false);
    invalidateTask();
    pushToast(publicationFeedback("published"));
  }, [invalidateTask, pushToast, storageKey]);
  // Keep the first returned ID as the anchor. A batch's blocking row may
  // change as text and files finish; no read is allowed to submit another send.
  const publicationStatus = useQuery({
    queryKey: [
      "chat-publication-batch",
      companyId,
      binding?.endpointId,
      binding?.conversationId,
      publication?.id,
    ],
    queryFn: () =>
      chatEndpointsApi.getPublicationBatchStatus(
        binding!.endpointId,
        binding!.conversationId,
        publication!.id,
      ),
    enabled: deliveryScopeReady && Boolean(publication),
    staleTime: 0,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    const batch = publicationStatus.data;
    if (
      publication &&
      batch &&
      batch.total > 0 &&
      batch.published === batch.total &&
      batch.publication.state === "published"
    ) {
      finishPublication();
    }
  }, [publication, publicationStatus.data, finishPublication]);
  const publish = useMutation({
    mutationFn: (input: {
      attachmentIds: string[];
      body: string;
      idempotencyKey: string;
      endpointId: string;
      conversationId: string;
    }) =>
      chatEndpointsApi.publishBoardMessage(
        input.endpointId,
        input.conversationId,
        input.body,
        input.idempotencyKey,
        input.attachmentIds,
      ),
    onSuccess: (result) => {
      invalidateTask();
      const feedback = publicationFeedback(result.state);
      setPublication(result.state === "published" ? null : result);
      if (result.state === "published") {
        finishPublication();
        return;
      }
      setUnconfirmedRequest(false);
      if (storageKey && retainedSend.current) {
        retainedSend.current = {
          ...retainedSend.current,
          publication: {
            id: result.id,
            state: result.state,
            attempts: result.attempts,
          },
        };
        try {
          writeBoardSendDraft(storageKey, retainedSend.current);
        } catch {
          // The pre-POST payload/key is already persisted. It remains a safe,
          // explicit same-request retry when the publication ID cannot be saved.
        }
      }
      pushToast({
        ...feedback,
        action: {
          label: i18n.t("area.apps-chat-email.externally-connected-task-banner.viewActivity"),
          href: `/apps/chat/${binding!.endpointId}/activity`,
        },
      });
    },
    onError: (error, request) => {
      const rejected = readBoardSendRejection(error, request);
      if (rejected && retainedSend.current && storageKey) {
        const saved = { ...retainedSend.current, rejection: rejected };
        try {
          // Keep the negative receipt through reload before offering a new key.
          writeBoardSendDraft(storageKey, saved);
        } catch {
          setStorageError(i18n.t("area.apps-chat-email.externally-connected-task-banner.rejectionSaveFailed"));
          return;
        }
        retainedSend.current = saved;
        setRejection(rejected);
        setUnconfirmedRequest(false);
        invalidateTask();
        pushToast({
          title: i18n.t("area.apps-chat-email.externally-connected-task-banner.rejectedToast.title"),
          body: i18n.t("area.apps-chat-email.externally-connected-task-banner.rejectedToast.body"),
          tone: "error",
        });
        return;
      }
      pushToast({
        title: i18n.t("area.apps-chat-email.externally-connected-task-banner.unconfirmedToast.title"),
        body:
          error instanceof Error
            ? i18n.t("area.apps-chat-email.externally-connected-task-banner.unconfirmedToast.bodyWithError", {
                message: error.message,
              })
            : i18n.t("area.apps-chat-email.externally-connected-task-banner.unconfirmedToast.body"),
        tone: "error",
      });
    },
  });
  const uploadDisabled = Boolean(
    retainedSend.current ||
    publication ||
    publish.isPending ||
    publish.isError ||
    unconfirmedRequest ||
    storageError ||
    !deliveryScopeReady ||
    uploading,
  );
  async function uploadFile(file: File) {
    if (uploadDisabled || uploadInFlight.current || retainedSend.current)
      return;
    uploadInFlight.current = true;
    setUploading(true);
    setUploadError(null);
    try {
      const attachment = await issuesApi.uploadAttachment(
        companyId,
        issueId,
        file,
      );
      if (!mounted.current) return;
      setUploadedAttachments((current) => [...current, attachment]);
      setSelectedAttachmentIds((current) => [...current, attachment.id]);
      idempotencyKey.current = null;
    } catch (error) {
      if (mounted.current) {
        setUploadError(
          i18n.t("area.apps-chat-email.externally-connected-task-banner.uploadFailed", {
            message:
              error instanceof Error
                ? error.message
                : i18n.t("area.apps-chat-email.externally-connected-task-banner.uploadUnconfirmed"),
          }),
        );
      }
    } finally {
      uploadInFlight.current = false;
      if (mounted.current) setUploading(false);
      // An interrupted response may still have stored the file on this task.
      invalidateTask();
    }
  }
  // Keep newly uploaded files usable before the task refetch completes. Once
  // present, server metadata wins (especially a file bound to a sent comment).
  const taskAttachments = [
    ...new Map(
      [...uploadedAttachments, ...attachments].map((attachment) => [
        attachment.id,
        attachment,
      ]),
    ).values(),
  ];
  useEffect(() => {
    // Metadata may arrive after this file was selected but before Send. Never
    // silently keep a now-hidden selection, and never rewrite a retained send.
    if (retainedSend.current) return;
    const newlyBound = attachments
      .filter((file) => file.issueCommentId !== null)
      .map((file) => file.id);
    if (!selectedAttachmentIds.some((id) => newlyBound.includes(id))) return;
    setSelectedAttachmentIds((current) =>
      current.filter((id) => !newlyBound.includes(id)),
    );
    setSelectionNotice(true);
    idempotencyKey.current = null;
  }, [attachments, selectedAttachmentIds]);
  const showingRetainedFiles = Boolean(retainedSend.current);
  // Comment binding removes files from new-send eligibility, not from the
  // immutable receipt for the current send. Saved names survive reload while
  // task metadata is loading (or a selected attachment has since been removed).
  const visibleAttachments = retainedSend.current
    ? retainedSend.current.attachmentIds.map((id) => ({
        id,
        originalFilename:
          retainedSend.current?.attachmentNames?.find((file) => file.id === id)
            ?.name ??
          taskAttachments.find((attachment) => attachment.id === id)
            ?.originalFilename ??
          i18n.t("area.apps-chat-email.externally-connected-task-banner.selectedFileUnavailable"),
      }))
    : taskAttachments.filter(
        (attachment) =>
          attachment.issueCommentId === null &&
          !excludedAttachmentIds.includes(attachment.id),
      );
  const currentPublication = publicationStatus.data?.publication ?? publication;
  const batch = publicationStatus.data;
  const dismissible =
    !publicationStatus.isError &&
    !publicationStatus.isFetching &&
    canDismissBoardSendBatch(batch);
  const mixedTerminal =
    canDismissBoardSendBatch(batch) && batch!.published < batch!.total;
  const currentFeedback = mixedTerminal
    ? {
        title: t("area.apps-chat-email.externally-connected-task-banner.feedback.mixed.title"),
        body: t("area.apps-chat-email.externally-connected-task-banner.feedback.mixed.body"),
        tone: "info" as const,
      }
    : currentPublication?.state === "cancelled" &&
        (batch?.awaitingConsent ?? 0) > 0
      ? {
          title: t("area.apps-chat-email.externally-connected-task-banner.feedback.remainingConsent.title"),
          body: t("area.apps-chat-email.externally-connected-task-banner.feedback.remainingConsent.body"),
          tone: "info" as const,
        }
      : currentPublication
        ? publicationFeedback(currentPublication.state)
        : null;
  const activityPath = `/apps/chat/${binding.endpointId}/activity`;
  return (
    <section
      aria-label={t("area.apps-chat-email.externally-connected-task-banner.sectionAriaLabel")}
      className="space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {t("area.apps-chat-email.externally-connected-task-banner.connectedTo", {
                provider: providerNames[binding.provider],
              })}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {binding.externalLabel} · {t("area.apps-chat-email.externally-connected-task-banner.assignmentFixed")}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {binding.externalUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={binding.externalUrl} target="_blank" rel="noreferrer">
                {t("area.apps-chat-email.externally-connected-task-banner.openProvider", {
                  provider: providerNames[binding.provider],
                })}{" "}
                <ExternalLink />
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setComposing((value) => !value)}
          >
            {t("area.apps-chat-email.externally-connected-task-banner.sendToChannel")}
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/apps/chat/${binding.endpointId}/conversations`}>
              {t("area.apps-chat-email.externally-connected-task-banner.connection")}
            </Link>
          </Button>
        </div>
      </div>
      {composing && (
        <div className="space-y-2 border-t border-border pt-3">
          <label
            className="text-xs font-medium"
            htmlFor="external-board-update"
          >
            {t("area.apps-chat-email.externally-connected-task-banner.boardUpdate")}
          </label>
          <Textarea
            id="external-board-update"
            value={body}
            disabled={
              Boolean(publication) ||
              Boolean(rejection) ||
              publish.isError ||
              unconfirmedRequest ||
              Boolean(storageError) ||
              !deliveryScopeReady
            }
            onChange={(event) => {
              setBody(event.target.value);
              idempotencyKey.current = null;
              publish.reset();
            }}
            placeholder={t("area.apps-chat-email.externally-connected-task-banner.boardUpdatePlaceholder")}
          />
          {selectedAttachmentIds.length > 0 && !body.trim() && (
            <p className="text-xs text-muted-foreground">
              {t("area.apps-chat-email.externally-connected-task-banner.addMessageForFiles")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              aria-label={t("area.apps-chat-email.externally-connected-task-banner.attachAriaLabel")}
              disabled={uploadDisabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadFile(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploadDisabled}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
              {uploading ? t("area.apps-chat-email.externally-connected-task-banner.uploading") : t("area.apps-chat-email.externally-connected-task-banner.attachFile")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("area.apps-chat-email.externally-connected-task-banner.filesStayNote")}
            </p>
          </div>
          {uploadError && (
            <p role="alert" className="text-xs text-destructive">
              {uploadError}
            </p>
          )}
          {selectionNotice && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("area.apps-chat-email.externally-connected-task-banner.selectionNotice")}
            </p>
          )}
          {visibleAttachments.length > 0 && (
            <fieldset
              className="space-y-2 rounded-md border border-border bg-background p-3"
              disabled={
                showingRetainedFiles ||
                Boolean(publication) ||
                publish.isError ||
                unconfirmedRequest ||
                Boolean(storageError) ||
                !deliveryScopeReady
              }
            >
              <legend className="px-1 text-xs font-medium">
                {showingRetainedFiles
                  ? t("area.apps-chat-email.externally-connected-task-banner.filesInSend")
                  : t("area.apps-chat-email.externally-connected-task-banner.includeTaskFiles")}
              </legend>
              <p className="text-xs text-muted-foreground">
                {binding.provider === "github"
                  ? t("area.apps-chat-email.externally-connected-task-banner.filesNoteGithub")
                  : binding.provider === "microsoft-teams" &&
                      !showingRetainedFiles
                    ? t("area.apps-chat-email.externally-connected-task-banner.filesNoteTeams")
                    : showingRetainedFiles
                      ? t("area.apps-chat-email.externally-connected-task-banner.filesNoteRetained")
                      : t("area.apps-chat-email.externally-connected-task-banner.filesNoteDefault")}
              </p>
              <div className="space-y-2">
                {visibleAttachments.map((attachment) => {
                  const label =
                    attachment.originalFilename ?? t("area.apps-chat-email.externally-connected-task-banner.unnamedAttachment");
                  return (
                    <label
                      className="flex items-center gap-2 text-xs"
                      key={attachment.id}
                    >
                      <Checkbox
                        disabled={showingRetainedFiles}
                        checked={selectedAttachmentIds.includes(attachment.id)}
                        onCheckedChange={(checked) => {
                          setSelectedAttachmentIds((current) =>
                            checked === true
                              ? [...current, attachment.id]
                              : current.filter((id) => id !== attachment.id),
                          );
                          idempotencyKey.current = null;
                          publish.reset();
                        }}
                      />
                      <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="truncate">{label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          {storageError && (
            <p role="alert" className="text-xs text-destructive">
              {storageError}
            </p>
          )}
          {rejection && (
            <div
              role="alert"
              className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
            >
              <p className="font-medium">{t("area.apps-chat-email.externally-connected-task-banner.rejection.title")}</p>
              <p className="text-muted-foreground">
                {t("area.apps-chat-email.externally-connected-task-banner.rejection.body")}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(storageError)}
                onClick={() => {
                  if (!storageKey || !retainedSend.current?.rejection) return;
                  try {
                    clearBoardSendDraft(storageKey);
                  } catch {
                    setStorageError(i18n.t("area.apps-chat-email.externally-connected-task-banner.rejectionClearFailed"));
                    return;
                  }
                  const invalidIds =
                    retainedSend.current.rejection.attachmentIds;
                  setExcludedAttachmentIds((current) => [
                    ...new Set([...current, ...invalidIds]),
                  ]);
                  setSelectedAttachmentIds((current) =>
                    current.filter((id) => !invalidIds.includes(id)),
                  );
                  setUploadedAttachments((current) =>
                    current.filter((file) => !invalidIds.includes(file.id)),
                  );
                  retainedSend.current = null;
                  idempotencyKey.current = null;
                  setRejection(null);
                  setUnconfirmedRequest(false);
                  setSelectionNotice(true);
                  publish.reset();
                }}
              >
                {t("area.apps-chat-email.externally-connected-task-banner.editRejected")}
              </Button>
            </div>
          )}
          {!rejection &&
            (publish.isError || unconfirmedRequest) &&
            !publish.isPending &&
            !publication && (
              <div
                role="alert"
                className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
              >
                <p className="font-medium">
                  {t("area.apps-chat-email.externally-connected-task-banner.unconfirmed.title")}
                </p>
                <p className="text-muted-foreground">
                  {t("area.apps-chat-email.externally-connected-task-banner.unconfirmed.body")}
                </p>
                <Link
                  className="inline-block font-medium underline underline-offset-4"
                  to={activityPath}
                >
                  {t("area.apps-chat-email.externally-connected-task-banner.openActivity")}
                </Link>
              </div>
            )}
          {publication && currentPublication && currentFeedback && (
            <div
              role={
                currentPublication.state === "failed" ||
                currentPublication.state === "delivery_unknown"
                  ? "alert"
                  : "status"
              }
              className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
            >
              <p className="font-medium">{currentFeedback.title}</p>
              <p className="text-muted-foreground">{currentFeedback.body}</p>
              {batch && (
                <p className="text-muted-foreground">
                  {batch.declined !== undefined &&
                  batch.expired !== undefined &&
                  batch.cancelled !== undefined &&
                  batch.awaitingConsent !== undefined
                    ? [
                        t("area.apps-chat-email.externally-connected-task-banner.summary.published", { n: batch.published }),
                        ...(batch.awaitingConsent
                          ? [
                              t("area.apps-chat-email.externally-connected-task-banner.summary.awaitingConsent", {
                                n: batch.awaitingConsent,
                              }),
                            ]
                          : []),
                        ...(batch.declined
                          ? [t("area.apps-chat-email.externally-connected-task-banner.summary.declined", { n: batch.declined })]
                          : []),
                        ...(batch.expired
                          ? [t("area.apps-chat-email.externally-connected-task-banner.summary.expired", { n: batch.expired })]
                          : []),
                        ...(batch.cancelled
                          ? [t("area.apps-chat-email.externally-connected-task-banner.summary.cancelled", { n: batch.cancelled })]
                          : []),
                      ].join(" · ")
                    : t("area.apps-chat-email.externally-connected-task-banner.summary.partsPublished", {
                        published: batch.published,
                        total: batch.total,
                      })}
                </p>
              )}
              {batch?.parts?.some((part) => part.fileTransfer) && (
                <ul
                  className="space-y-1 text-muted-foreground"
                  aria-label={t("area.apps-chat-email.externally-connected-task-banner.fileOutcomesAriaLabel")}
                >
                  {batch.parts
                    .filter((part) => part.fileTransfer)
                    .map((part) => (
                      <li key={part.id}>
                        {part.fileTransfer!.filename} —{" "}
                        {filePhaseLabel(part.fileTransfer!.phase)}
                      </li>
                    ))}
                </ul>
              )}
              {publicationStatus.isError && (
                <p role="alert" className="text-muted-foreground">
                  {t("area.apps-chat-email.externally-connected-task-banner.statusRefreshFailed")}
                </p>
              )}
              {currentPublication.redactedError && (
                <p className="text-muted-foreground">
                  {t("area.apps-chat-email.externally-connected-task-banner.providerDetail", {
                    detail: currentPublication.redactedError,
                  })}
                </p>
              )}
              <Link
                className="inline-block font-medium underline underline-offset-4"
                to={activityPath}
              >
                {t("area.apps-chat-email.externally-connected-task-banner.openActivity")}
              </Link>
              {dismissible && (
                <Button
                  className="ml-3"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (storageKey) {
                      try {
                        clearBoardSendDraft(storageKey);
                      } catch {
                        setStorageError(i18n.t("area.apps-chat-email.externally-connected-task-banner.identityClearFailed"));
                        return;
                      }
                    }
                    setStorageError(null);
                    retainedSend.current = null;
                    setUnconfirmedRequest(false);
                    setPublication(null);
                    setBody("");
                    setSelectedAttachmentIds([]);
                    setUploadedAttachments([]);
                    setUploadError(null);
                    idempotencyKey.current = null;
                    publish.reset();
                  }}
                >
                  {t("area.apps-chat-email.externally-connected-task-banner.dismissReceipt")}
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {t("area.apps-chat-email.externally-connected-task-banner.boardCommentsNote")}
            </p>
            <Button
              size="sm"
              disabled={
                !body.trim() ||
                publish.isPending ||
                uploading ||
                Boolean(publication) ||
                Boolean(rejection) ||
                Boolean(storageError) ||
                !deliveryScopeReady
              }
              onClick={() => {
                if (
                  uploadInFlight.current ||
                  !storageKey ||
                  loadedStorageKey.current !== storageKey ||
                  retainedScopeKey.current !== storageKey
                )
                  return;
                idempotencyKey.current ??= crypto.randomUUID();
                const input = retainedSend.current ?? {
                  attachmentIds: selectedAttachmentIds,
                  attachmentNames: selectedAttachmentIds.map((id) => ({
                    id,
                    name:
                      taskAttachments.find((attachment) => attachment.id === id)
                        ?.originalFilename ?? i18n.t("area.apps-chat-email.externally-connected-task-banner.unnamedAttachment"),
                  })),
                  body: body.trim(),
                  idempotencyKey: idempotencyKey.current,
                  publication: null,
                };
                try {
                  if (!storageKey) throw new Error("Missing delivery scope");
                  writeBoardSendDraft(storageKey, input);
                } catch {
                  setStorageError(i18n.t("area.apps-chat-email.externally-connected-task-banner.identitySaveFailed"));
                  return;
                }
                retainedSend.current = input;
                setUnconfirmedRequest(true);
                publish.mutate({
                  ...input,
                  endpointId: binding.endpointId,
                  conversationId: binding.conversationId,
                });
              }}
            >
              {publish.isPending
                ? t("area.apps-chat-email.externally-connected-task-banner.sending")
                : !rejection && (publish.isError || unconfirmedRequest)
                  ? t("area.apps-chat-email.externally-connected-task-banner.retrySafely")
                  : t("area.apps-chat-email.externally-connected-task-banner.sendToChannel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
