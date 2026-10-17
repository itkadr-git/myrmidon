import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { knowledgeApi, type KnowledgeSuggestion } from "../api/knowledge";

function SuggestionCard({ item, companyId, refresh }: { item: KnowledgeSuggestion; companyId: string; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body);
  const [rationale, setRationale] = useState(item.rationale ?? "");
  const toast = useToastActions();
  const edit = useMutation({
    mutationFn: () => knowledgeApi.editSuggestion(companyId, item.id, body, rationale),
    onSuccess: () => { setEditing(false); refresh(); toast.pushToast({ title: "Suggestion updated", tone: "success" }); },
    onError: () => toast.pushToast({ title: "Could not update suggestion", tone: "error" }),
  });
  const decide = useMutation({
    mutationFn: (decision: "accepted" | "declined") => knowledgeApi.decideSuggestion(companyId, item.id, decision, decision === "declined" ? rationale : undefined),
    onSuccess: (_result, decision) => { refresh(); toast.pushToast({ title: decision === "accepted" ? "Suggestion accepted" : "Suggestion declined", tone: "success" }); },
    onError: () => toast.pushToast({ title: "Could not decide suggestion", tone: "error" }),
  });
  return <article className="rounded-xl border bg-card p-5 shadow-sm">
    {editing ? <div className="space-y-3">
      <Textarea aria-label="Suggested knowledge" value={body} onChange={(e) => setBody(e.target.value)} />
      <Textarea aria-label="Recommendation reason" placeholder="Recommendation reason" value={rationale} onChange={(e) => setRationale(e.target.value)} />
      <div className="flex gap-2"><Button disabled={edit.isPending || !body.trim()} onClick={() => edit.mutate()}><Check className="mr-2 h-4 w-4"/>Save</Button><Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div>
    </div> : <>
      <p className="whitespace-pre-wrap text-sm leading-6">{item.body}</p>
      {item.rationale && <p className="mt-3 border-l-2 pl-3 text-sm text-muted-foreground"><span className="font-medium">Recommendation:</span> {item.rationale}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{item.sourceKind ?? "Knowledge"}</span>{item.sourceRef && <span>{item.sourceRef}</span>}<time className="ml-auto">{new Date(item.createdAt).toLocaleString()}</time></div>
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={decide.isPending} onClick={() => decide.mutate("accepted")}><Check className="mr-2 h-4 w-4"/>Accept</Button><Button variant="outline" onClick={() => setEditing(true)}><Pencil className="mr-2 h-4 w-4"/>Edit</Button><Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("declined")}><X className="mr-2 h-4 w-4"/>Reject</Button></div>
    </>}
  </article>;
}

export function KnowledgeReview() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const suggestions = useQuery({
    queryKey: ["knowledge-suggestions", selectedCompanyId],
    queryFn: () => knowledgeApi.listSuggestions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["knowledge-suggestions", selectedCompanyId] });
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
    <header className="border-b pb-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Knowledge · Review queue</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Suggestions</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Review proposed additions to your company knowledge. Accept, refine, or reject each suggestion.</p></header>
    {suggestions.isLoading ? <p className="text-sm text-muted-foreground">Loading suggestions…</p> : suggestions.isError ? <p role="alert" className="text-sm text-destructive">Could not load knowledge suggestions.</p> : suggestions.data?.length ? <div className="grid gap-4">{suggestions.data.map((item) => <SuggestionCard key={item.id} item={item} companyId={selectedCompanyId!} refresh={refresh}/>)}</div> : <section className="rounded-2xl border border-dashed p-10 text-center"><BookOpen className="mx-auto h-8 w-8 text-muted-foreground"/><h2 className="mt-3 font-medium">Nothing to review</h2><p className="mt-1 text-sm text-muted-foreground">New knowledge suggestions will appear here.</p></section>}
  </main>;
}