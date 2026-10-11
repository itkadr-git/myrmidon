// ui/src/components/myrmidon/knowledge/KnowledgeSettingsScreen.tsx
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-11): "Settings → Knowledge".
//
// Limits, auto-accept, the sweep schedule and the section reviewers. Every
// field shows the badge of the layer that produced its effective value
// (`ui`, `env` or `default`). Saving writes only the fields the operator
// changed; the next read badges those `ui`.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import {
  KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT,
  KNOWLEDGE_MAX_ITEMS_DEFAULT,
  KNOWLEDGE_MAX_ITEMS_MAX,
  KNOWLEDGE_MAX_ITEMS_MIN,
  KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT,
  KNOWLEDGE_MAX_REVISION_BYTES_MAX,
  KNOWLEDGE_MAX_REVISION_BYTES_MIN,
  KNOWLEDGE_SCHEDULE_DEFAULT,
  KNOWLEDGE_SECTION_MAX_LENGTH,
  KNOWLEDGE_SECTION_REVIEWERS_MAX,
  knowledgeScheduleOk,
  knowledgeSettingsPatchErrors,
  parseKnowledgeBoundedInt,
  parseKnowledgeConfidence,
  type KnowledgeSectionReviewer,
  type KnowledgeSettingSource,
  type KnowledgeSettingsPatch,
  type KnowledgeSettingsView,
} from "@paperclipai/shared";
import { fetchKnowledgeSettings, patchKnowledgeSettings } from "./knowledgeSettingsApi";

interface ReviewerDraft {
  section: string;
  reviewerKind: "user" | "agent";
  reviewerId: string;
}

interface Draft {
  maxItems: string;
  maxRevisionBytes: string;
  autoAcceptEnabled: boolean;
  autoAcceptMinConfidence: string;
  schedule: string;
  sectionReviewers: ReviewerDraft[];
}

function emptyReviewer(): ReviewerDraft {
  return { section: "", reviewerKind: "user", reviewerId: "" };
}

function draftFromView(view: KnowledgeSettingsView): Draft {
  return {
    maxItems: String(view.maxItems.value),
    maxRevisionBytes: String(view.maxRevisionBytes.value),
    autoAcceptEnabled: view.autoAcceptEnabled.value,
    autoAcceptMinConfidence: view.autoAcceptMinConfidence.value,
    schedule: view.schedule.value,
    sectionReviewers: view.sectionReviewers.value.map((reviewer) => ({ ...reviewer })),
  };
}

/** The fields whose draft differs from the effective value, as a patch. */
function patchFromDraft(view: KnowledgeSettingsView, draft: Draft): KnowledgeSettingsPatch {
  const patch: KnowledgeSettingsPatch = {};
  if (draft.maxItems !== String(view.maxItems.value)) patch.maxItems = draft.maxItems;
  if (draft.maxRevisionBytes !== String(view.maxRevisionBytes.value)) {
    patch.maxRevisionBytes = draft.maxRevisionBytes;
  }
  if (draft.autoAcceptEnabled !== view.autoAcceptEnabled.value) {
    patch.autoAcceptEnabled = draft.autoAcceptEnabled;
  }
  if (draft.autoAcceptMinConfidence !== view.autoAcceptMinConfidence.value) {
    patch.autoAcceptMinConfidence = draft.autoAcceptMinConfidence;
  }
  if (draft.schedule !== view.schedule.value) patch.schedule = draft.schedule;
  const reviewers = draft.sectionReviewers.filter((reviewer) => reviewer.section.trim() !== "");
  const sameReviewers =
    reviewers.length === view.sectionReviewers.value.length &&
    reviewers.every((reviewer, index) => {
      const saved = view.sectionReviewers.value[index];
      return (
        saved !== undefined &&
        reviewer.section === saved.section &&
        reviewer.reviewerKind === saved.reviewerKind &&
        reviewer.reviewerId === saved.reviewerId
      );
    });
  if (!sameReviewers) patch.sectionReviewers = reviewers as KnowledgeSectionReviewer[];
  return patch;
}

function SourceBadge({ source }: { source: KnowledgeSettingSource }) {
  const { t } = useTranslation();
  const variant = source === "ui" ? "default" : source === "env" ? "secondary" : "outline";
  return (
    <Badge variant={variant} data-testid="knowledge-source-badge" data-source={source}>
      {t(`knowledgeSettings.source.${source}`)}
    </Badge>
  );
}

export function KnowledgeSettingsScreen() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const queryKey = ["knowledge-settings", selectedCompanyId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => fetchKnowledgeSettings(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data) setDraft(draftFromView(query.data));
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (patch: KnowledgeSettingsPatch) =>
      patchKnowledgeSettings(selectedCompanyId as string, patch),
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
      setDraft(draftFromView(view));
      setSaved(true);
    },
  });

  if (!selectedCompanyId) {
    return <p data-testid="knowledge-settings-no-company">{t("knowledgeSettings.noCompany")}</p>;
  }
  if (query.isError) {
    return <p data-testid="knowledge-settings-error">{t("knowledgeSettings.loadError")}</p>;
  }
  if (!query.data || !draft) {
    return <p data-testid="knowledge-settings-loading">{t("knowledgeSettings.loading")}</p>;
  }

  const view = query.data;
  const patch = patchFromDraft(view, draft);
  const fieldErrors = knowledgeSettingsPatchErrors(patch);
  const canSave = Object.keys(patch).length > 0 && fieldErrors.length === 0 && !mutation.isPending;

  function save() {
    if (!canSave) return;
    setSaved(false);
    mutation.mutate(patch);
  }

  function updateReviewer(index: number, next: ReviewerDraft) {
    setDraft((current) =>
      current
        ? {
            ...current,
            sectionReviewers: current.sectionReviewers.map((reviewer, i) => (i === index ? next : reviewer)),
          }
        : current,
    );
    setSaved(false);
  }

  return (
    <section data-testid="knowledge-settings" style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <header>
        <h1>{t("knowledgeSettings.title")}</h1>
        <p>{t("knowledgeSettings.intro")}</p>
      </header>

      <div>
        <Label htmlFor="knowledge-max-items">
          {t("knowledgeSettings.maxItems")} <SourceBadge source={view.maxItems.source} />
        </Label>
        <Input
          id="knowledge-max-items"
          data-testid="knowledge-max-items"
          inputMode="numeric"
          value={draft.maxItems}
          onChange={(event) => {
            setDraft({ ...draft, maxItems: event.target.value });
            setSaved(false);
          }}
        />
        <p>
          {t("knowledgeSettings.bounds", {
            min: KNOWLEDGE_MAX_ITEMS_MIN,
            max: KNOWLEDGE_MAX_ITEMS_MAX,
            fallback: KNOWLEDGE_MAX_ITEMS_DEFAULT,
          })}
        </p>
        {fieldErrors.includes("maxItems") ? <p role="alert">{t("knowledgeSettings.invalidNumber")}</p> : null}
      </div>

      <div>
        <Label htmlFor="knowledge-max-bytes">
          {t("knowledgeSettings.maxRevisionBytes")} <SourceBadge source={view.maxRevisionBytes.source} />
        </Label>
        <Input
          id="knowledge-max-bytes"
          data-testid="knowledge-max-bytes"
          inputMode="numeric"
          value={draft.maxRevisionBytes}
          onChange={(event) => {
            setDraft({ ...draft, maxRevisionBytes: event.target.value });
            setSaved(false);
          }}
        />
        <p>
          {t("knowledgeSettings.bounds", {
            min: KNOWLEDGE_MAX_REVISION_BYTES_MIN,
            max: KNOWLEDGE_MAX_REVISION_BYTES_MAX,
            fallback: KNOWLEDGE_MAX_REVISION_BYTES_DEFAULT,
          })}
        </p>
        {parseKnowledgeBoundedInt(draft.maxRevisionBytes, KNOWLEDGE_MAX_REVISION_BYTES_MIN, KNOWLEDGE_MAX_REVISION_BYTES_MAX) ===
          null && fieldErrors.includes("maxRevisionBytes") ? (
          <p role="alert">{t("knowledgeSettings.invalidNumber")}</p>
        ) : null}
      </div>

      <div>
        <Label htmlFor="knowledge-auto-accept">
          {t("knowledgeSettings.autoAccept")} <SourceBadge source={view.autoAcceptEnabled.source} />
        </Label>
        <input
          id="knowledge-auto-accept"
          data-testid="knowledge-auto-accept"
          type="checkbox"
          checked={draft.autoAcceptEnabled}
          onChange={(event) => {
            setDraft({ ...draft, autoAcceptEnabled: event.target.checked });
            setSaved(false);
          }}
        />
        <p>{t("knowledgeSettings.autoAcceptHint")}</p>
      </div>

      <div>
        <Label htmlFor="knowledge-confidence">
          {t("knowledgeSettings.minConfidence")} <SourceBadge source={view.autoAcceptMinConfidence.source} />
        </Label>
        <Input
          id="knowledge-confidence"
          data-testid="knowledge-confidence"
          value={draft.autoAcceptMinConfidence}
          onChange={(event) => {
            setDraft({ ...draft, autoAcceptMinConfidence: event.target.value });
            setSaved(false);
          }}
        />
        <p>{t("knowledgeSettings.minConfidenceHint", { fallback: KNOWLEDGE_AUTO_ACCEPT_MIN_CONFIDENCE_DEFAULT })}</p>
        {parseKnowledgeConfidence(draft.autoAcceptMinConfidence) === null &&
        fieldErrors.includes("autoAcceptMinConfidence") ? (
          <p role="alert">{t("knowledgeSettings.invalidConfidence")}</p>
        ) : null}
      </div>

      <div>
        <Label htmlFor="knowledge-schedule">
          {t("knowledgeSettings.schedule")} <SourceBadge source={view.schedule.source} />
        </Label>
        <Input
          id="knowledge-schedule"
          data-testid="knowledge-schedule"
          value={draft.schedule}
          onChange={(event) => {
            setDraft({ ...draft, schedule: event.target.value });
            setSaved(false);
          }}
        />
        <p>{t("knowledgeSettings.scheduleHint", { fallback: KNOWLEDGE_SCHEDULE_DEFAULT })}</p>
        {!knowledgeScheduleOk(draft.schedule) && fieldErrors.includes("schedule") ? (
          <p role="alert">{t("knowledgeSettings.invalidSchedule")}</p>
        ) : null}
      </div>

      <div data-testid="knowledge-reviewers">
        <h2>
          {t("knowledgeSettings.reviewers")} <SourceBadge source={view.sectionReviewers.source} />
        </h2>
        <p>{t("knowledgeSettings.reviewersHint")}</p>
        {draft.sectionReviewers.map((reviewer, index) => (
          <div key={index} style={{ display: "flex", gap: 8 }}>
            <Input
              aria-label={t("knowledgeSettings.section")}
              data-testid="knowledge-reviewer-section"
              maxLength={KNOWLEDGE_SECTION_MAX_LENGTH}
              value={reviewer.section}
              onChange={(event) => updateReviewer(index, { ...reviewer, section: event.target.value })}
            />
            <select
              aria-label={t("knowledgeSettings.reviewerKind")}
              data-testid="knowledge-reviewer-kind"
              value={reviewer.reviewerKind}
              onChange={(event) =>
                updateReviewer(index, { ...reviewer, reviewerKind: event.target.value as "user" | "agent" })
              }
            >
              <option value="user">{t("knowledgeSettings.kindUser")}</option>
              <option value="agent">{t("knowledgeSettings.kindAgent")}</option>
            </select>
            <Input
              aria-label={t("knowledgeSettings.reviewerId")}
              data-testid="knowledge-reviewer-id"
              value={reviewer.reviewerId}
              onChange={(event) => updateReviewer(index, { ...reviewer, reviewerId: event.target.value })}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft({
                  ...draft,
                  sectionReviewers: draft.sectionReviewers.filter((_, i) => i !== index),
                })
              }
            >
              {t("knowledgeSettings.removeReviewer")}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={draft.sectionReviewers.length >= KNOWLEDGE_SECTION_REVIEWERS_MAX}
          onClick={() => setDraft({ ...draft, sectionReviewers: [...draft.sectionReviewers, emptyReviewer()] })}
        >
          {t("knowledgeSettings.addReviewer")}
        </Button>
        {fieldErrors.includes("sectionReviewers") ? (
          <p role="alert">{t("knowledgeSettings.invalidReviewers")}</p>
        ) : null}
      </div>

      <div>
        <Button type="button" data-testid="knowledge-settings-save" disabled={!canSave} onClick={save}>
          {t("knowledgeSettings.save")}
        </Button>
        {saved ? <p data-testid="knowledge-settings-saved">{t("knowledgeSettings.saved")}</p> : null}
        {mutation.isError ? <p role="alert">{t("knowledgeSettings.saveError")}</p> : null}
      </div>
    </section>
  );
}
