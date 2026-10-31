// myrmidon(1.7 KNOWLEDGE L-1.3): pending suggestions and explicit decisions.
import { useState } from "react";
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
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  // A successful draft write is not repeated if the later decision fails.
  const [draftSaved, setDraftSaved] = useState(false);
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
        suggestions: old.suggestions.filter((row) => row.id !== suggestion.id),
      }));
      setEditing(null);
      setDraftSaved(false);
      void client.invalidateQueries({ queryKey });
      void client.invalidateQueries({ queryKey: ["knowledge", "items", companyId] });
    },
  });
  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
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
                <Button type="button" variant="outline" disabled={decision.isPending} onClick={() => { setEditing(null); decision.reset(); }}>{text.cancel}</Button>
              </div>
            </form>
          ) : <div className="flex flex-wrap gap-2">
            <Button disabled={decision.isPending || editing !== null} onClick={() => decision.mutate({ suggestion, action: "accept" })}>{text.accept}</Button>
            <Button variant="outline" disabled={decision.isPending || editing !== null} onClick={() => decision.mutate({ suggestion, action: "decline" })}>{text.reject}</Button>
            <Button variant="outline" disabled={decision.isPending || editing !== null} onClick={() => {
              decision.reset(); setEditing(suggestion); setContent(suggestion.body); setTitle(""); setSlug(""); setDraftSaved(false);
            }}>{text.edit}</Button>
          </div>}
        </section>
      ))}
    </main>
  );
}
