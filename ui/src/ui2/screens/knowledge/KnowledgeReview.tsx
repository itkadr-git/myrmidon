// myrmidon(1.7 KNOWLEDGE L-1.3): pending suggestions and explicit decisions.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { knowledgeReviewApi, type KnowledgeSuggestion } from "./knowledgeReviewApi";
import { reviewMessages } from "./knowledgeReviewMessages";

export function KnowledgeReview() {
  const { selectedCompanyId } = useCompany();
  const { i18n } = useTranslation();
  const text = reviewMessages[i18n.language?.startsWith("ru") ? "ru" : "en"];
  // Remount local editor state on company changes; never carry a draft across nests.
  return selectedCompanyId
    ? <ReviewQueue key={selectedCompanyId} companyId={selectedCompanyId} text={text} />
    : <p>{text.company}</p>;
}

type Messages = typeof reviewMessages.en;
function ReviewQueue({ companyId, text }: { companyId: string; text: Messages }) {
  const client = useQueryClient();
  const queryKey = ["knowledge", "suggestions", companyId, "pending"];
  const queue = useQuery({ queryKey, queryFn: () => knowledgeReviewApi.pending(companyId) });
  const [editing, setEditing] = useState<KnowledgeSuggestion | null>(null);
  const [focusAfterCancel, setFocusAfterCancel] = useState<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (focusAfterCancel === null) return;
    editButtons.current.get(focusAfterCancel)?.focus();
    setFocusAfterCancel(null);
  }, [focusAfterCancel]);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  // A successful draft write is not repeated if the later decision fails.
  const [draftSaved, setDraftSaved] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<Record<string, { content: string; title: string; slug: string }>>({});
  const decision = useMutation({
    mutationFn: async ({ suggestion, action, edit }: { suggestion: KnowledgeSuggestion; action: "accept" | "decline"; edit?: boolean }) => {
      if (edit && !draftSaved) {
        await knowledgeReviewApi.saveDraft(companyId, suggestion, { content, title, slug });
        setDraftSaved(true);
      }
      return knowledgeReviewApi.decide(companyId, suggestion.id, action);
    },
    onSuccess: (_response, { suggestion }) => {
      client.setQueryData<{ suggestions: KnowledgeSuggestion[] }>(queryKey, (old) => old && ({
        ...old,
        suggestions: old.suggestions.filter((row) => row.id !== suggestion.id),
      }));
      setEditing(null);
      setDraftSaved(false);
      void client.invalidateQueries({ queryKey });
      void client.invalidateQueries({ queryKey: ["knowledge", "items", companyId] });
    },
  });
  return (
    <main aria-busy={decision.isPending} className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">{text.heading}</h1>
      {queue.isPending && <p role="status">{text.loading}</p>}
      {queue.error && <div role="alert"><p>{text.loadFailed}</p><Button onClick={() => void queue.refetch()}>{text.retry}</Button></div>}
      {decision.error && <p role="alert">{text.failed}: {decision.error.message}</p>}
      {queue.data?.suggestions.length === 0 && <p>{text.empty}</p>}
      {queue.data?.suggestions.map((suggestion) => (
        <section key={suggestion.id} aria-label={text.suggestion} className="space-y-3 border-b border-border py-4">
          <p className="whitespace-pre-wrap break-words">{suggestion.body}</p>
          {suggestion.rationale && <p className="text-sm text-muted-foreground">{suggestion.rationale}</p>}
          {editing?.id === suggestion.id ? (
            <form className="space-y-3" onSubmit={(event) => {
              event.preventDefault();
              if (content.length > 500000 || (!suggestion.targetItemId && (title.length > 300 || slug.length > 200))) return;
              decision.mutate({ suggestion, action: "accept", edit: true });
            }}>
              {!suggestion.targetItemId && <>
                <label className="block">{text.title}<input className="block w-full border border-border bg-background p-2" required maxLength={300} value={title} disabled={draftSaved || decision.isPending} onChange={(event) => setTitle(event.target.value)} /></label>
                <label className="block">{text.slug}<input className="block w-full border border-border bg-background p-2" required maxLength={200} value={slug} disabled={draftSaved || decision.isPending} onChange={(event) => setSlug(event.target.value)} /></label>
              </>}
              <label className="block">{text.content}<textarea autoFocus className="block min-h-48 w-full border border-border bg-background p-2" required maxLength={500000} value={content} disabled={draftSaved || decision.isPending} onChange={(event) => setContent(event.target.value)} /></label>
              <p className="text-sm text-muted-foreground">{draftSaved ? text.saved : text.draftHint}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={decision.isPending || !content.trim() || (!suggestion.targetItemId && (!title.trim() || !slug.trim()))}>{text.save}</Button>
                <Button type="button" variant="outline" disabled={decision.isPending} onClick={() => {
                  if (draftSaved) setSavedDrafts((drafts) => ({ ...drafts, [suggestion.id]: { content, title, slug } }));
                  setFocusAfterCancel(suggestion.id); setEditing(null); decision.reset();
                }}>{text.cancel}</Button>
              </div>
            </form>
          ) : <div className="flex flex-wrap gap-2">
            <Button aria-label={`${text.accept} ${suggestion.id}`} disabled={decision.isPending || editing !== null} onClick={() => decision.mutate({ suggestion, action: "accept" })}>{text.accept}</Button>
            <Button aria-label={`${text.reject} ${suggestion.id}`} variant="outline" disabled={decision.isPending || editing !== null} onClick={() => decision.mutate({ suggestion, action: "decline" })}>{text.reject}</Button>
            <Button aria-label={`${text.edit} ${suggestion.id}`} ref={(element) => { if (element) editButtons.current.set(suggestion.id, element); else editButtons.current.delete(suggestion.id); }} variant="outline" disabled={decision.isPending || editing !== null} onClick={() => {
              const saved = savedDrafts[suggestion.id];
              decision.reset(); setEditing(suggestion); setContent(saved?.content ?? suggestion.body); setTitle(saved?.title ?? ""); setSlug(saved?.slug ?? ""); setDraftSaved(Boolean(saved));
            }}>{text.edit}</Button>
          </div>}
        </section>
      ))}
    </main>
  );
}
