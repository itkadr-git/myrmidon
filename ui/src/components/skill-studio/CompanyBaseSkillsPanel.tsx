// myrmidon(1.6.5 BASE-SKILLS): the company base-skills panel of the Skills
// screen.
//
// The panel is the interface half of the registry: it lists the skills every
// agent carries automatically, shows which agents still miss which of them, and
// offers the two repairs the registry has — declare a skill as base (it is
// applied to every agent right away) and apply the whole list again.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { CompanyBaseSkillEntry, CompanyBaseSkillOverview } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { baseSkillsApi } from "@/api/baseSkills";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/queryKeys";
import { useOptionalToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { skillRoute } from "@/lib/company-skill-routes";

function gapsByKey(overview: CompanyBaseSkillOverview | undefined) {
  const map = new Map<string, CompanyBaseSkillOverview["gaps"]>();
  for (const gap of overview?.gaps ?? []) {
    const bucket = map.get(gap.key) ?? [];
    bucket.push(gap);
    map.set(gap.key, bucket);
  }
  return map;
}

function BaseSkillRow({
  entry,
  overview,
  onRemove,
  removePending,
}: {
  entry: CompanyBaseSkillEntry;
  overview: CompanyBaseSkillOverview | undefined;
  onRemove: (key: string) => void;
  removePending: boolean;
}) {
  const gaps = gapsByKey(overview).get(entry.key) ?? [];
  const unsupported = gaps.filter((gap) => gap.reason === "adapter_unsupported");
  const missing = gaps.filter((gap) => gap.reason === "not_assigned");

  return (
    <li
      data-testid="base-skill-row"
      data-skill-key={entry.key}
      className="flex items-start justify-between gap-3 border-t border-border py-2 first:border-t-0"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {entry.skillId ? (
            <Link
              to={skillRoute(entry.skillId)}
              className="truncate text-sm font-medium text-foreground no-underline hover:underline"
            >
              {entry.name ?? entry.key}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium text-foreground">
              {entry.name ?? entry.key}
            </span>
          )}
          <Badge variant="outline">base</Badge>
          {entry.missing ? (
            <Badge variant="destructive">
              <AlertTriangle aria-hidden="true" /> not in the library
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {entry.skillId ? `${entry.key} · ` : null}
          {entry.assignedAgentCount} of {entry.agentCount} agents
        </p>
        {entry.missing ? (
          <p className="mt-1 text-xs text-destructive">
            The library has no skill with this key, so no agent can receive it. Remove it from the
            base list or install the skill again.
          </p>
        ) : null}
        {missing.length > 0 || unsupported.length > 0 ? (
          <div data-testid="base-skill-gaps" className="mt-1 text-xs text-muted-foreground">
            {missing.length > 0 ? (
              <p>
                Missing on {missing.length === 1 ? "1 agent" : `${missing.length} agents`}:{" "}
                {missing.map((gap) => gap.agentName).join(", ")}
                {" — press Apply to all agents."}
              </p>
            ) : null}
            {unsupported.length > 0 ? (
              <p>
                {unsupported.length === 1 ? "1 agent" : `${unsupported.length} agents`} cannot receive
                skills at all (adapter without skill sync):{" "}
                {unsupported.map((gap) => gap.agentName).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Remove ${entry.key} from the company base skills`}
        disabled={removePending}
        onClick={() => onRemove(entry.key)}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

function AddBaseSkillsDialog({
  companyId,
  open,
  onOpenChange,
  existingKeys,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingKeys: string[];
}) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: open,
  });

  const candidates = useMemo(() => {
    const already = new Set(existingKeys);
    const term = search.trim().toLowerCase();
    return (skillsQuery.data ?? [])
      .filter((skill) => !already.has(skill.key))
      .filter((skill) =>
        term.length === 0
          ? true
          : `${skill.name} ${skill.key} ${skill.slug}`.toLowerCase().includes(term),
      )
      .slice(0, 100);
  }, [existingKeys, search, skillsQuery.data]);

  const addSkills = useMutation({
    mutationFn: (keys: string[]) => baseSkillsApi.add(companyId, keys),
    onSuccess: (response, keys) => {
      queryClient.setQueryData(
        queryKeys.companySkills.baseSkills(companyId),
        response.overview,
      );
      toast?.pushToast({
        tone: "success",
        title: "Base skills updated",
        body:
          `${keys.join(", ")} declared base. ` +
          `${response.apply.changed} agent(s) updated, ${response.apply.unchanged} already had them.`,
      });
      setSelected([]);
      setSearch("");
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add company base skills</DialogTitle>
          <DialogDescription>
            Every agent of the company gets a base skill automatically: a new agent at creation, an
            existing one right away, and again whenever the list is applied.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the skill library"
        />
        <div className="max-h-72 overflow-y-auto">
          {skillsQuery.isLoading ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">Loading the skill library…</p>
          ) : candidates.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              Every skill of the library is already a base skill.
            </p>
          ) : (
            <ul className="flex flex-col">
              {candidates.map((skill) => (
                <li key={skill.id} className="border-t border-border py-2 first:border-t-0">
                  <label className="flex cursor-pointer items-start gap-2">
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.includes(skill.key)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked === true
                            ? Array.from(new Set([...current, skill.key]))
                            : current.filter((key) => key !== skill.key),
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {skill.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {skill.key}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {addSkills.error ? (
          <p className="text-sm text-destructive">
            {addSkills.error instanceof Error ? addSkills.error.message : "Could not save the list."}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0 || addSkills.isPending}
            onClick={() => addSkills.mutate(selected)}
          >
            {addSkills.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Declare base
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The base-skills section of the Skills screen. Owns its own data, so the
 * surrounding page only decides where it sits.
 */
export function CompanyBaseSkillsPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [addOpen, setAddOpen] = useState(false);

  const overviewQuery = useQuery({
    queryKey: queryKeys.companySkills.baseSkills(companyId),
    queryFn: () => baseSkillsApi.overview(companyId),
  });

  const applyBase = useMutation({
    mutationFn: () => baseSkillsApi.apply(companyId),
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.companySkills.baseSkills(companyId), response.overview);
      const { changed, unchanged, failed } = response.apply;
      toast?.pushToast({
        tone: failed.length > 0 ? "warn" : "success",
        title: "Base skills applied",
        body:
          `${changed} agent(s) updated, ${unchanged} already had every base skill` +
          (failed.length > 0 ? `, ${failed.length} could not be updated.` : "."),
      });
    },
  });

  const removeBase = useMutation({
    mutationFn: (key: string) => baseSkillsApi.remove(companyId, key),
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.companySkills.baseSkills(companyId), response.overview);
      toast?.pushToast({
        tone: "success",
        title: "Removed from the base skills",
        body: `${response.removed} is no longer assigned automatically. Agents that already have it keep it.`,
      });
    },
  });

  const overview = overviewQuery.data;
  const entries = overview?.entries ?? [];
  const gapCount = overview?.gaps.filter((gap) => gap.reason === "not_assigned").length ?? 0;

  return (
    <section
      data-testid="company-base-skills"
      className="rounded-md border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">Base skills</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Skills every agent of this company has automatically — including new agents and agents
              created from a template.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="base-skills-apply"
            disabled={entries.length === 0 || applyBase.isPending}
            onClick={() => applyBase.mutate()}
          >
            {applyBase.isPending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            Apply to all agents
            {gapCount > 0 ? ` (${gapCount})` : ""}
          </Button>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" /> Add skills
          </Button>
        </div>
      </div>

      {overviewQuery.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading base skills…</p>
      ) : overviewQuery.error ? (
        <p className="mt-3 text-sm text-destructive">
          {overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "Could not load the base skills."}
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No base skills yet. Add a skill here and every agent of the company receives it from then
          on — including the agents created later.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {entries.map((entry) => (
            <BaseSkillRow
              key={entry.key}
              entry={entry}
              overview={overview}
              removePending={removeBase.isPending}
              onRemove={(key) => removeBase.mutate(key)}
            />
          ))}
        </ul>
      )}

      <AddBaseSkillsDialog
        companyId={companyId}
        open={addOpen}
        onOpenChange={setAddOpen}
        existingKeys={entries.map((entry) => entry.key)}
      />
    </section>
  );
}