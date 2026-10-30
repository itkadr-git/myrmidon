// myrmidon(BOT-DISK-F): "Disk isolation" — which bots share one disk root.
//
// Every agent resolves to a scope instance, most specific first: its own override,
// an explicit named group, its caste, its reporting subtree, a project, its catalog
// team, the company. Each instance is either isolated (every member keeps its own
// disk, the default) or shared (one directory with one pnpm store and a
// subdirectory per member). A change only moves what an agent resolves to; the
// bot's container restarts, with its directories moved, when the owner applies it
// ("restart required"). The rules live in packages/shared/src/myrmidon-isolation-scope.ts.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { Trans } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOptionalCompany } from "@/context/CompanyContext";
import { i18n, useTranslation } from "@/i18n";
import {
  botScopeApi,
  botScopeQueryKey,
  describeScopeMode,
  describeScopeSource,
  type BotScopeAgentView,
  type BotScopeGroupView,
  type BotScopeOverview,
  type IsolationMode,
  type SettableScopeKind,
} from "./botScopeApi";

const addableKinds = (): Array<{ kind: SettableScopeKind; label: string; hint: string }> => [
  { kind: "caste", label: i18n.t("area.settings-bots-host-1.bot-scope-panel.kindCaste"), hint: i18n.t("area.settings-bots-host-1.bot-scope-panel.hintCaste") },
  { kind: "subtree", label: i18n.t("area.settings-bots-host-1.bot-scope-panel.kindSubtree"), hint: i18n.t("area.settings-bots-host-1.bot-scope-panel.hintSubtree") },
  { kind: "project", label: i18n.t("area.settings-bots-host-1.bot-scope-panel.kindProject"), hint: i18n.t("area.settings-bots-host-1.bot-scope-panel.hintProject") },
  { kind: "catalog", label: i18n.t("area.settings-bots-host-1.bot-scope-panel.kindCatalog"), hint: i18n.t("area.settings-bots-host-1.bot-scope-panel.hintCatalog") },
  { kind: "company", label: i18n.t("area.settings-bots-host-1.bot-scope-panel.kindCompany"), hint: "" },
];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function instanceLabel(overview: BotScopeOverview, kind: SettableScopeKind, id: string): string {
  if (kind === "group") return overview.groups.find((g) => g.id === id)?.name ?? id;
  if (kind === "subtree") return overview.agents.find((a) => a.agentId === id)?.name ?? id;
  if (kind === "company") return i18n.t("area.settings-bots-host-1.bot-scope-panel.company");
  return id;
}

export function BotScopePanel() {
  const { t } = useTranslation();
  const kinds = addableKinds();
  // Optional: the page also renders where no company is selected yet (the panel then stays empty).
  const companyId = useOptionalCompany()?.selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const key = botScopeQueryKey(companyId);
  const { data: overview } = useQuery({
    queryKey: key,
    queryFn: () => botScopeApi.overview(companyId),
    enabled: companyId.length > 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");
  const [addKind, setAddKind] = useState<SettableScopeKind>("caste");
  const [addId, setAddId] = useState("");
  const [addMode, setAddMode] = useState<IsolationMode>("shared");

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const run = <T,>(fn: () => Promise<T>, fallback: string, after?: () => void) =>
    fn()
      .then(() => {
        setError(null);
        after?.();
        return refresh();
      })
      .catch((err) => setError(errorText(err, fallback)));

  const applyAll = useMutation({
    mutationFn: () => botScopeApi.applyAll(companyId),
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError: (err) => setError(errorText(err, t("area.settings-bots-host-1.bot-scope-panel.errApply"))),
  });

  if (companyId === "") return null;
  if (!overview) {
    return (
      <section className="space-y-4 rounded-lg border p-4" data-testid="bot-scope-panel">
        <Heading />
        <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-scope-panel.loading")}</p>
      </section>
    );
  }

  const restartCount = overview.agents.filter((agent) => agent.restartRequired).length;
  const openChoices = overview.agents.filter((agent) => agent.problems.length > 0);
  const agentName = (id: string) => overview.agents.find((a) => a.agentId === id)?.name ?? id;

  return (
    <section className="space-y-5 rounded-lg border p-4" data-testid="bot-scope-panel">
      <Heading />
      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="area.settings-bots-host-1.bot-scope-panel.intro" components={[<strong key="shared" />, <em key="restart" />]} />
        {overview.scopeRoot ? (
          <>
            {" "}
            <Trans i18nKey="area.settings-bots-host-1.bot-scope-panel.scopeRoot" values={{ root: overview.scopeRoot }} components={[<code key="root" />]} />
          </>
        ) : null}
      </p>
      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid="bot-scope-error">
          {error}
        </p>
      )}

      <div className="space-y-2" data-testid="bot-scope-instances">
        <h4 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-scope-panel.instancesHeading")}</h4>
        {overview.instances.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-scope-panel.noInstances")}</p>
        ) : (
          <ul className="space-y-1">
            {overview.instances.map((instance) => (
              <li key={`${instance.kind}:${instance.id}`} className="flex flex-wrap items-center gap-2 text-sm" data-testid="bot-scope-instance">
                <span className="w-40 text-xs uppercase text-muted-foreground">{instance.kind}</span>
                <span className="min-w-32 font-medium">{instanceLabel(overview, instance.kind, instance.id)}</span>
                <ModeSelect
                  value={instance.mode}
                  label={t("area.settings-bots-host-1.bot-scope-panel.modeOf", { kind: instance.kind, name: instanceLabel(overview, instance.kind, instance.id) })}
                  onChange={(mode) =>
                    run(() => botScopeApi.putSetting(companyId, instance.kind, instance.id, mode), t("area.settings-bots-host-1.bot-scope-panel.errMode"))
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {t("area.settings-bots-host-1.bot-scope-panel.members", { count: instance.memberIds.length })}
                  {instance.dirName ? <> · <code>{instance.dirName}</code></> : null}
                </span>
                {instance.kind !== "group" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(() => botScopeApi.deleteSetting(companyId, instance.kind, instance.id), t("area.settings-bots-host-1.bot-scope-panel.errRemove"))}
                  >
                    {t("area.settings-bots-host-1.bot-scope-panel.remove")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("area.settings-bots-host-1.bot-scope-panel.addKindAria")}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={addKind}
            onChange={(event) => setAddKind(event.target.value as SettableScopeKind)}
          >
            {kinds.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.label}
              </option>
            ))}
          </select>
          {addKind !== "company" && (
            <Input
              aria-label={t("area.settings-bots-host-1.bot-scope-panel.addIdAria")}
              className="w-64"
              placeholder={kinds.find((item) => item.kind === addKind)?.hint}
              value={addId}
              onChange={(event) => setAddId(event.target.value)}
            />
          )}
          <ModeSelect value={addMode} label={t("area.settings-bots-host-1.bot-scope-panel.addModeAria")} onChange={setAddMode} />
          <Button
            size="sm"
            disabled={addKind !== "company" && addId.trim() === ""}
            onClick={() =>
              run(
                () => botScopeApi.putSetting(companyId, addKind, addKind === "company" ? companyId : addId.trim(), addMode),
                t("area.settings-bots-host-1.bot-scope-panel.errScope"),
                () => setAddId(""),
              )
            }
          >
            {t("area.settings-bots-host-1.bot-scope-panel.addScope")}
          </Button>
        </div>
      </div>

      <div className="space-y-2" data-testid="bot-scope-groups">
        <h4 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-scope-panel.groupsHeading")}</h4>
        {overview.groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            overview={overview}
            onMode={(mode) =>
              run(
                () =>
                  mode === null
                    ? botScopeApi.deleteSetting(companyId, "group", group.id)
                    : botScopeApi.putSetting(companyId, "group", group.id, mode),
                t("area.settings-bots-host-1.bot-scope-panel.errGroupMode"),
              )
            }
            onRename={(name) => run(() => botScopeApi.patchGroup(companyId, group.id, { name }), t("area.settings-bots-host-1.bot-scope-panel.errRename"))}
            onMembers={(memberIds) =>
              run(() => botScopeApi.patchGroup(companyId, group.id, { memberIds }), t("area.settings-bots-host-1.bot-scope-panel.errMembers"))
            }
            onDelete={() => run(() => botScopeApi.deleteGroup(companyId, group.id), t("area.settings-bots-host-1.bot-scope-panel.errDeleteGroup"))}
          />
        ))}
        <div className="flex items-center gap-2">
          <Input
            aria-label={t("area.settings-bots-host-1.bot-scope-panel.newGroupName")}
            className="w-64"
            placeholder={t("area.settings-bots-host-1.bot-scope-panel.newGroupName")}
            value={newGroup}
            onChange={(event) => setNewGroup(event.target.value)}
          />
          <Button
            size="sm"
            disabled={newGroup.trim() === ""}
            onClick={() =>
              run(() => botScopeApi.createGroup(companyId, { name: newGroup.trim() }), t("area.settings-bots-host-1.bot-scope-panel.errCreateGroup"), () => setNewGroup(""))
            }
          >
            {t("area.settings-bots-host-1.bot-scope-panel.createGroup")}
          </Button>
        </div>
      </div>

      <div className="space-y-2" data-testid="bot-scope-agents">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-scope-panel.agentsHeading")}</h4>
          {restartCount > 0 && (
            <Button size="sm" onClick={() => applyAll.mutate()} disabled={applyAll.isPending} data-testid="bot-scope-apply-all">
              {t("area.settings-bots-host-1.bot-scope-panel.applyAll", { restarts: restartCount })}
            </Button>
          )}
          {openChoices.length > 0 && (
            <span className="text-xs text-red-600" data-testid="bot-scope-choices-open">
              {t("area.settings-bots-host-1.bot-scope-panel.needChoice", { count: openChoices.length })}
            </span>
          )}
        </div>
        <ul className="space-y-2">
          {overview.agents.map((agent) => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              overview={overview}
              agentName={agentName}
              onPref={(body) => run(() => botScopeApi.putAgent(companyId, agent.agentId, body), t("area.settings-bots-host-1.bot-scope-panel.errChoice"))}
              onApply={() => run(() => botScopeApi.apply(companyId, agent.agentId), t("area.settings-bots-host-1.bot-scope-panel.errApplyOne"))}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function Heading() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Layers className="size-4 text-muted-foreground" />
      <h3 className="text-sm font-medium">{t("area.settings-bots-host-1.bot-scope-panel.title")}</h3>
    </div>
  );
}

function ModeSelect(props: { value: IsolationMode; label: string; onChange: (mode: IsolationMode) => void }) {
  const { t } = useTranslation();
  return (
    <select
      aria-label={props.label}
      className="h-8 rounded-md border bg-background px-2 text-sm"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as IsolationMode)}
    >
      <option value="isolated">{t("area.settings-bots-host-1.bot-scope-panel.modeIsolated")}</option>
      <option value="shared">{t("area.settings-bots-host-1.bot-scope-panel.modeShared")}</option>
    </select>
  );
}

function GroupCard(props: {
  group: BotScopeGroupView;
  overview: BotScopeOverview;
  onMode: (mode: IsolationMode | null) => void;
  onRename: (name: string) => void;
  onMembers: (memberIds: string[]) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { group, overview } = props;
  const [name, setName] = useState(group.name);
  const conflicted = new Set(
    overview.agents
      .filter((agent) => agent.problems.some((p) => p.code === "group-conflict" && p.groupIds.includes(group.id)))
      .map((agent) => agent.agentId),
  );
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="bot-scope-group">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={t("area.settings-bots-host-1.bot-scope-panel.groupNameAria", { name: group.name })} className="w-56" value={name} onChange={(event) => setName(event.target.value)} />
        <Button size="sm" variant="outline" disabled={name.trim() === "" || name.trim() === group.name} onClick={() => props.onRename(name.trim())}>
          {t("area.settings-bots-host-1.bot-scope-panel.rename")}
        </Button>
        <select
          aria-label={t("area.settings-bots-host-1.bot-scope-panel.groupIsolationAria", { name: group.name })}
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={group.mode ?? "none"}
          onChange={(event) => props.onMode(event.target.value === "none" ? null : (event.target.value as IsolationMode))}
        >
          <option value="none">{t("area.settings-bots-host-1.bot-scope-panel.modeNone")}</option>
          <option value="isolated">{t("area.settings-bots-host-1.bot-scope-panel.modeIsolated")}</option>
          <option value="shared">{t("area.settings-bots-host-1.bot-scope-panel.modeShared")}</option>
        </select>
        <Button size="sm" variant="ghost" onClick={props.onDelete}>
          {t("area.settings-bots-host-1.bot-scope-panel.delete")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {overview.agents.map((agent) => {
          const member = group.memberIds.includes(agent.agentId);
          return (
            <label key={agent.agentId} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={member}
                aria-label={t("area.settings-bots-host-1.bot-scope-panel.memberAria", { agent: agent.name, group: group.name })}
                onChange={() =>
                  props.onMembers(member ? group.memberIds.filter((id) => id !== agent.agentId) : [...group.memberIds, agent.agentId])
                }
              />
              {agent.name}
              {conflicted.has(agent.agentId) && <span className="text-red-600" title={t("area.settings-bots-host-1.bot-scope-panel.conflictTitle")}>{t("area.settings-bots-host-1.bot-scope-panel.conflict")}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function AgentRow(props: {
  agent: BotScopeAgentView;
  overview: BotScopeOverview;
  agentName: (id: string) => string;
  onPref: (body: { isolate?: boolean; groupId?: string | null; projectId?: string | null }) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const { agent } = props;
  const groupConflict = agent.problems.find((p) => p.code === "group-conflict");
  const projectProblem = agent.problems.find((p) => p.code === "project-ambiguous");
  return (
    <li className="space-y-1 rounded-md border p-2 text-sm" data-testid="bot-scope-agent">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{agent.name}</span>
        {agent.role && <span className="text-xs text-muted-foreground">{agent.role}</span>}
        {!agent.container && <span className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.bot-scope-panel.noContainer")}</span>}
        <span data-testid="bot-scope-effective">
          {describeScopeMode(agent)}
          {agent.effective.layout.kind === "shared" ? <> · <code>{agent.effective.layout.dirName}</code></> : null}
        </span>
        <span className="text-xs text-muted-foreground" data-testid="bot-scope-source">
          {t("area.settings-bots-host-1.bot-scope-panel.from", { source: describeScopeSource(agent) })}
        </span>
        {agent.restartRequired && (
          <>
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900" data-testid="bot-scope-restart-required">
              {t("area.settings-bots-host-1.bot-scope-panel.restartRequired")}
            </span>
            <Button size="sm" variant="outline" disabled={agent.problems.length > 0} onClick={props.onApply}>
              {t("area.settings-bots-host-1.bot-scope-panel.applyRestart")}
            </Button>
          </>
        )}
        <label className="ml-auto flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={agent.pref.isolate}
            aria-label={t("area.settings-bots-host-1.bot-scope-panel.keepIsolatedAria", { name: agent.name })}
            onChange={(event) => props.onPref({ isolate: event.target.checked })}
          />
          {t("area.settings-bots-host-1.bot-scope-panel.keepIsolated")}
        </label>
      </div>
      {groupConflict && (
        <div className="text-xs text-red-600" data-testid="bot-scope-group-conflict">
          {t("area.settings-bots-host-1.bot-scope-panel.groupConflict")}{" "}
          <select
            aria-label={t("area.settings-bots-host-1.bot-scope-panel.groupDecidingAria", { name: agent.name })}
            className="h-7 rounded-md border bg-background px-1 text-xs"
            value={agent.pref.groupId ?? ""}
            onChange={(event) => props.onPref({ groupId: event.target.value || null })}
          >
            <option value="">{t("area.settings-bots-host-1.bot-scope-panel.choose")}</option>
            {groupConflict.groupIds.map((id) => (
              <option key={id} value={id}>
                {props.overview.groups.find((g) => g.id === id)?.name ?? id}
              </option>
            ))}
          </select>
        </div>
      )}
      {projectProblem && (
        <div className="text-xs text-red-600" data-testid="bot-scope-project-ambiguous">
          {t("area.settings-bots-host-1.bot-scope-panel.projectAmbiguous")}{" "}
          <select
            aria-label={t("area.settings-bots-host-1.bot-scope-panel.projectDecidingAria", { name: agent.name })}
            className="h-7 rounded-md border bg-background px-1 text-xs"
            value={agent.pref.projectId ?? ""}
            onChange={(event) => props.onPref({ projectId: event.target.value || null })}
          >
            <option value="">{t("area.settings-bots-host-1.bot-scope-panel.choose")}</option>
            {projectProblem.projectIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      )}
    </li>
  );
}
