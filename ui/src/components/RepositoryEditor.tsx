import { useEffect, useRef, useState } from "react";
import type { ProjectRepository } from "@myrmidon/shared";
import { GitBranch, LockKeyhole, Plus, X } from "lucide-react";
import { GithubIcon } from "./icons/github-icon";
import { SearchableSelect } from "./SearchableSelect";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { useTranslation } from "@/i18n";

function RepoRow({ repo, onRemove }: { repo: ProjectRepository; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
      <GithubIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium" title={repo.fullName}>{repo.fullName}</span>
        {repo.connections.length > 0 && <span className="truncate text-xs text-muted-foreground" title={repo.connections.join(" · ")}>
          {repo.connections.join(" · ")}
        </span>}
      </div>
      {repo.private && <LockKeyhole className="size-3 shrink-0 text-muted-foreground" aria-label={t("area.projects-goals-workspaces-1.repository-editor.privateRepo")} />}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("area.projects-goals-workspaces-1.repository-editor.removeAria", { name: repo.fullName })} onClick={onRemove}><X className="size-4" /></Button>
    </div>
  );
}

/** Shared by both review surfaces, ready to extract after design approval. */
export function RepositoryEditor({ selected, onChange, state = "ready", available = [], onRetry, onConnect, disabled = false }: {
  selected: ProjectRepository[];
  onChange: (repos: ProjectRepository[]) => void;
  state?: "ready" | "loading" | "disconnected" | "empty" | "error";
  available?: ProjectRepository[];
  onRetry: () => void;
  disabled?: boolean;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  const [showPicker, setShowPicker] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showPicker) picker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
  }, [showPicker]);
  const options = available.filter((repo) => !selected.some((item) => item.id === repo.id)).map((repo) => ({
    key: repo.id, value: repo.id, label: repo.fullName,
    searchText: repo.connections.join(" "), repo,
  }));
  const addClassName = selected.length ? "self-start" : "h-24 w-full flex-col gap-2";
  const addLabel = selected.length ? t("area.projects-goals-workspaces-1.repository-editor.addAnother") : t("area.projects-goals-workspaces-1.repository-editor.addGithub");
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline gap-2"><span className="text-sm font-medium">{t("area.projects-goals-workspaces-1.repository-editor.title")}</span><span className="text-xs text-muted-foreground">{t("area.projects-goals-workspaces-1.repository-editor.optional")}</span></div>
      {selected.map((repo) => <RepoRow key={repo.id} repo={repo} onRemove={() => onChange(selected.filter((item) => item.id !== repo.id))} />)}
      {state === "disconnected" ? (
        <Popover>
          <PopoverTrigger asChild><Button type="button" variant="outline" className={addClassName}><GithubIcon className="size-4" />{addLabel}</Button></PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <div className="flex flex-col gap-3">
              <GithubIcon className="size-5" />
              <div className="flex flex-col gap-1"><p className="text-sm font-medium">{t("area.projects-goals-workspaces-1.repository-editor.connectTitle")}</p><p className="text-xs text-muted-foreground">{t("area.projects-goals-workspaces-1.repository-editor.connectHint")}</p></div>
              <Button type="button" onClick={onConnect}><GithubIcon className="size-4" />{t("area.projects-goals-workspaces-1.repository-editor.connectGithub")}</Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : showPicker ? (
        <div ref={picker} className="flex flex-col gap-2">
          <SearchableSelect<string, (typeof options)[number]>
            value="" groups={[{ id: "available", label: t("area.projects-goals-workspaces-1.repository-editor.availableGroup"), options }]}
            placeholder={addLabel} searchPlaceholder={t("area.projects-goals-workspaces-1.repository-editor.search")}
            contentClassName="max-h-(--radix-popover-content-available-height) overflow-hidden [&_[data-slot=command]]:max-h-(--radix-popover-content-available-height) [&_[data-slot=command-list]]:min-h-0 [&_[data-slot=command-list]]:flex-1 [&_[data-slot=command-input-wrapper]]:shrink-0"
            loading={state === "loading"} loadingMessage={t("area.projects-goals-workspaces-1.repository-editor.loadingRepos")}
            emptyMessage={state === "error" ? t("area.projects-goals-workspaces-1.repository-editor.emptyError") : state === "empty" ? t("area.projects-goals-workspaces-1.repository-editor.emptyNone") : t("area.projects-goals-workspaces-1.repository-editor.emptyNoMatch")}
            renderValue={() => <span className="flex items-center gap-2 text-foreground"><GithubIcon className="size-4" />{addLabel}</span>}
            renderOption={({ repo }) => <><GitBranch className="size-4 shrink-0 text-muted-foreground" /><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate">{repo.fullName}</span><span className="truncate text-xs text-muted-foreground">{repo.connections.join(" · ")}</span></span>{repo.private && <LockKeyhole className="size-3 shrink-0 text-muted-foreground" />}</>}
            onValueChange={(_, option) => { onChange([...selected, option.repo]); setShowPicker(false); }}
            createItem={state === "error"
              ? { render: () => <>{t("area.projects-goals-workspaces-1.repository-editor.tryAgain")}</>, onSelect: () => { onRetry(); } }
              : { render: () => <><Plus className="size-4" />{t("area.projects-goals-workspaces-1.repository-editor.connectAnother")}</>, onSelect: onConnect }}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("area.projects-goals-workspaces-1.repository-editor.allConnections")}</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowPicker(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      ) : <Button type="button" variant="outline" className={addClassName} onClick={() => setShowPicker(true)}><GithubIcon className="size-4" />{addLabel}</Button>}
    </fieldset>
  );
}

