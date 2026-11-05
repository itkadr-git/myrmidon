import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { skillPolicyDocumentSchema, type EvaluateSkillPolicy, type ReplaceSkillPolicy, type SkillPolicyDocument } from "@myrmidon/shared";
import { useTranslation } from "@/i18n";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";

const key = (name: string) => `area.skills.company-skill-policy.${name}`;

export function CompanySkillPolicyEditor({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const policyQuery = useQuery({
    queryKey: queryKeys.companySkills.policy(companyId),
    queryFn: () => companySkillsApi.getPolicy(companyId),
    enabled: Boolean(companyId),
    retry: false,
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    retry: false,
  });
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [previewAgent, setPreviewAgent] = useState("");
  const [previewAction, setPreviewAction] = useState<EvaluateSkillPolicy["action"]>("skills.create");
  const [previewResult, setPreviewResult] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!policyQuery.data || dirty) return;
    const { schemaVersion, defaultEffect, rules, revision: latestRevision } = policyQuery.data;
    setDraft(JSON.stringify({ schemaVersion, defaultEffect, rules }, null, 2));
    setRevision(latestRevision);
  }, [policyQuery.data, dirty]);

  const canEdit = accessQuery.data?.access.canManageMembers === true;

  function validate(): SkillPolicyDocument | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError(t(key("invalidJson")));
      return null;
    }
    const result = skillPolicyDocumentSchema.safeParse(parsed);
    if (!result.success) {
      setError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return null;
    }
    setError("");
    return result.data;
  }

  const save = useMutation({
    mutationFn: (payload: ReplaceSkillPolicy) => companySkillsApi.replacePolicy(companyId, payload),
    onSuccess: (policy) => {
      queryClient.setQueryData(queryKeys.companySkills.policy(companyId), policy);
      setRevision(policy.revision);
      setDirty(false);
      setError("");
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.status === 409) {
        setError(t(key("staleRevision")));
      } else if (failure instanceof ApiError && failure.status === 403) {
        setError(t(key("forbidden")));
      } else {
        setError(failure.message);
      }
    },
  });
  const preview = useMutation({
    mutationFn: (payload: EvaluateSkillPolicy) => companySkillsApi.previewPolicy(companyId, payload),
    onSuccess: (decision) => setPreviewResult(JSON.stringify(decision, null, 2)),
    onError: (failure) => setError(failure.message),
  });

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label={t(key("title"))}>
      <h2 className="text-lg font-semibold">{t(key("title"))}</h2>
      <p className="text-sm text-muted-foreground">{t(key("description"))}</p>
      {policyQuery.isLoading ? <p>{t(key("loading"))}</p> : null}
      {policyQuery.isError ? <p role="alert">{policyQuery.error.message}</p> : null}
      {policyQuery.data ? (
        <>
          <p className="text-sm">{t(key("revision"), { revision: revision ?? policyQuery.data.revision })}</p>
          <label className="block space-y-2 text-sm">
            <span>{t(key("document"))}</span>
            <textarea aria-label={t(key("document"))} className="min-h-64 w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
              value={draft} readOnly={!canEdit} onChange={(event) => { setDraft(event.target.value); setDirty(true); setPreviewResult(""); }} />
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {!canEdit ? <p className="text-sm text-muted-foreground">{t(key("readOnly"))}</p> : null}
          {accessQuery.isError ? <p role="alert" className="text-sm text-destructive">{accessQuery.error.message}</p> : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={!canEdit} onClick={() => { validate(); }}>{t(key("validate"))}</Button>
            <Button type="button" disabled={!canEdit || save.isPending || revision === null || !dirty} onClick={() => {
              const document = validate();
              if (document && revision !== null) save.mutate({ ...document, expectedRevision: revision });
            }}>{t(key("save"))}</Button>
            <Button type="button" variant="outline" onClick={() => {
              setDirty(false);
              setError("");
              setDraft(JSON.stringify({ schemaVersion: policyQuery.data.schemaVersion, defaultEffect: policyQuery.data.defaultEffect, rules: policyQuery.data.rules }, null, 2));
              setRevision(policyQuery.data.revision);
              void policyQuery.refetch();
            }}>{t(key("reload"))}</Button>
          </div>
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium">{t(key("previewTitle"))}</p>
            <p className="text-xs text-muted-foreground">{t(key("previewHint"))}</p>
            <label className="block text-sm">{t(key("agentId"))}<input className="mt-1 w-full rounded-md border border-border bg-background p-2" value={previewAgent} onChange={(event) => setPreviewAgent(event.target.value)} /></label>
            <label className="block text-sm">{t(key("action"))}<select className="ml-2 rounded-md border border-border bg-background p-2" value={previewAction} onChange={(event) => setPreviewAction(event.target.value as EvaluateSkillPolicy["action"])}>
              {(["skills.create", "skills.import", "skills.install", "skills.edit", "skills.update", "skills.test", "skills.reset", "skills.remove"] as const).map((action) => <option key={action} value={action}>{action}</option>)}
            </select></label>
            <Button type="button" variant="outline" disabled={!canEdit || preview.isPending || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previewAgent.trim()) || dirty} onClick={() => preview.mutate({ action: previewAction, principal: { agentId: previewAgent.trim() }, resource: {} })}>{t(key("preview"))}</Button>
            {previewResult ? <pre className="overflow-auto rounded-md bg-muted p-3 text-xs" aria-label={t(key("previewResult"))}>{previewResult}</pre> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
