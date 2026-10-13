// myrmidon(1.7-AUTO-UPDATE-B): the update policy screen — the maintenance
// window, the update mode and the fleet canary of a release.
//
// The window decides when an update may touch the host (a deploy that verifies
// outside it waits for the window instead of opening it), the mode decides
// whether a release starts by itself (only after a human approves it here) or
// only on an operator's click, and the canary decides how much of the bot fleet
// moves first. Everything is saved in the instance settings and read by the
// deploy scheduler on every tick: no restart. Each knob shows the source of the
// value in force — an environment variable is a forced override and the screen
// says so instead of pretending the edit took effect.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  autoUpdateApi,
  autoUpdateQueryKey,
  type AutoUpdateCanary,
  type AutoUpdateMode,
  type AutoUpdatePatch,
  type AutoUpdateSource,
  type AutoUpdateView,
} from "./autoUpdateApi";

/** Monday first: how the days are listed on the screen (0 = Sunday). */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function sourceLabel(source: AutoUpdateSource): string {
  if (source === "ui") return "set here";
  if (source === "env") return "forced by the environment";
  return "default";
}

function minutesToClock(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function clockToMinutes(clock: string, label: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) throw new Error(`${label} must look like HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`${label} must be a time of day`);
  return hours * 60 + minutes;
}

function numberDraft(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number ${min}–${max}`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "the request failed";
}

/** The canary knobs as typed text, so a half-typed field is not sent. */
interface CanaryDraft {
  enabled: boolean;
  sharePercent: string;
  minBots: string;
  maxBots: string;
  healthSettleSec: string;
}

function canaryDraftOf(canary: AutoUpdateCanary): CanaryDraft {
  return {
    enabled: canary.enabled,
    sharePercent: String(canary.sharePercent),
    minBots: String(canary.minBots),
    maxBots: String(canary.maxBots),
    healthSettleSec: String(canary.healthSettleSec),
  };
}

export function AutoUpdateSettingsPanel() {
  const queryClient = useQueryClient();
  const { data: view } = useQuery({ queryKey: autoUpdateQueryKey, queryFn: autoUpdateApi.get });

  const [modeDraft, setModeDraft] = useState<AutoUpdateMode | null>(null);
  const [daysDraft, setDaysDraft] = useState<number[] | null>(null);
  const [fromDraft, setFromDraft] = useState<string | null>(null);
  const [toDraft, setToDraft] = useState<string | null>(null);
  const [canaryDraft, setCanaryDraft] = useState<CanaryDraft | null>(null);
  const [approveDraft, setApproveDraft] = useState({ tag: "", digest: "", version: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Seed the drafts once the stored values arrive (react-query v5 has no onSuccess).
  useEffect(() => {
    if (!view) return;
    if (modeDraft === null) setModeDraft(view.stored.mode);
    if (daysDraft === null) setDaysDraft([...view.stored.window.days]);
    if (fromDraft === null) setFromDraft(minutesToClock(view.stored.window.fromMinute));
    if (toDraft === null) setToDraft(minutesToClock(view.stored.window.toMinute));
    if (canaryDraft === null) setCanaryDraft(canaryDraftOf(view.stored.canary));
  }, [view, modeDraft, daysDraft, fromDraft, toDraft, canaryDraft]);

  const write = (saved: AutoUpdateView, text: string) => {
    queryClient.setQueryData(autoUpdateQueryKey, saved);
    setError(null);
    setNotice(text);
  };

  const save = useMutation({
    mutationFn: (patch: AutoUpdatePatch) => autoUpdateApi.patch(patch),
    onSuccess: (saved) => write(saved, "Saved — the deploy scheduler uses it from its next tick."),
    onError: (failure) => {
      setNotice(null);
      setError(message(failure));
    },
  });

  /** Built on the click, so a half-typed field is refused before the request. */
  const buildPatch = (): AutoUpdatePatch => ({
    mode: modeDraft ?? undefined,
    window: {
      days: [...(daysDraft ?? [])].sort((a, b) => a - b),
      fromMinute: clockToMinutes(fromDraft ?? "", "From"),
      toMinute: clockToMinutes(toDraft ?? "", "To"),
    },
    canary: canaryDraft
      ? {
          enabled: canaryDraft.enabled,
          sharePercent: numberDraft(canaryDraft.sharePercent, "Share", 1, 100),
          minBots: numberDraft(canaryDraft.minBots, "Min bots", 1, 100),
          maxBots: numberDraft(canaryDraft.maxBots, "Max bots", 1, 100),
          healthSettleSec: numberDraft(canaryDraft.healthSettleSec, "Health settle", 0, 86400),
        }
      : undefined,
  });

  function saveChanges() {
    try {
      save.mutate(buildPatch());
    } catch (failure) {
      setNotice(null);
      setError(message(failure));
    }
  }

  const approve = useMutation({
    mutationFn: () =>
      autoUpdateApi.approve({
        tag: approveDraft.tag.trim(),
        digest: approveDraft.digest.trim(),
        version: approveDraft.version.trim() || undefined,
      }),
    onSuccess: (saved) => {
      setApproveDraft({ tag: "", digest: "", version: "" });
      write(saved, "Approved — in automatic mode the scheduler starts it inside the window.");
    },
    onError: (failure) => {
      setNotice(null);
      setError(message(failure));
    },
  });

  const withdraw = useMutation({
    mutationFn: (tag: string) => autoUpdateApi.withdraw(tag),
    onSuccess: (saved) => write(saved, "Withdrawn."),
    onError: (failure) => {
      setNotice(null);
      setError(message(failure));
    },
  });

  if (!view) return null;
  const envForced = view.overridden.length > 0;
  const canary: CanaryDraft = canaryDraft ?? canaryDraftOf(view.stored.canary);
  const changed =
    modeDraft !== view.stored.mode ||
    JSON.stringify([...(daysDraft ?? [])].sort((a, b) => a - b)) !== JSON.stringify([...view.stored.window.days].sort((a, b) => a - b)) ||
    fromDraft !== minutesToClock(view.stored.window.fromMinute) ||
    toDraft !== minutesToClock(view.stored.window.toMinute) ||
    JSON.stringify(canary) !== JSON.stringify(canaryDraftOf(view.stored.canary));

  return (
    <section className="space-y-6" data-testid="auto-update-settings-panel">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Product updates</h2>
        <p className="text-sm text-muted-foreground">
          When an update may touch the host, whether a release starts on its own, and how much of the bot fleet moves
          first. An update that verifies outside the window waits for the window — the host is not touched meanwhile.
        </p>
        <p className="text-sm" data-testid="auto-update-window-state">
          Window now: {view.window.open ? "open" : "shut"}
          {view.window.closesAt ? ` (closes ${view.window.closesAt})` : ""}
          {view.window.opensAt ? ` (opens ${view.window.opensAt})` : ""} — {view.window.reason}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="auto-update-start-state">
          {view.start.allowed
            ? `In automatic mode the scheduler would start ${view.start.candidate?.tag ?? "the approved release"} now.`
            : `Nothing would start by itself now: ${view.start.reason}`}
        </p>
        {envForced && (
          <p className="text-xs text-amber-600" data-testid="auto-update-env-note">
            The environment forces {view.overridden.join(", ")}; the value shown as effective is the one in use.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="auto-update-mode">Update mode</Label>
        <select
          id="auto-update-mode"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          value={modeDraft ?? "manual"}
          onChange={(event) => {
            setModeDraft(event.target.value as AutoUpdateMode);
            setError(null);
            setNotice(null);
          }}
          data-testid="auto-update-mode-select"
        >
          <option value="manual">Manual — only when an operator starts it</option>
          <option value="auto_release">Automatic — an approved release starts inside the window</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Effective: {view.settings.mode === "auto_release" ? "automatic" : "manual"} ({sourceLabel(view.sources.mode)}).
          A deploy to the live board is always started by a human click.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Maintenance window (UTC)</Label>
        <div className="flex flex-wrap items-center gap-3">
          {DAY_ORDER.map((day) => (
            <label key={day} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={(daysDraft ?? []).includes(day)}
                onChange={(event) => {
                  const current = new Set(daysDraft ?? []);
                  if (event.target.checked) current.add(day);
                  else current.delete(day);
                  setDaysDraft([...current]);
                  setError(null);
                  setNotice(null);
                }}
                data-testid={`auto-update-day-${day}`}
              />
              {DAY_NAMES[day]}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          No day selected means no window: an update may run at any time. Effective:{" "}
          {view.settings.window.days.length === 0
            ? "any time"
            : `${view.settings.window.days.length} day(s), ${minutesToClock(view.settings.window.fromMinute)}–${minutesToClock(view.settings.window.toMinute)} UTC`}{" "}
          ({sourceLabel(view.sources.window)}).
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor="auto-update-from">From</Label>
          <Input
            id="auto-update-from"
            type="time"
            className="w-32"
            value={fromDraft ?? ""}
            onChange={(event) => {
              setFromDraft(event.target.value);
              setError(null);
              setNotice(null);
            }}
            data-testid="auto-update-from-input"
          />
          <Label htmlFor="auto-update-to">To</Label>
          <Input
            id="auto-update-to"
            type="time"
            className="w-32"
            value={toDraft ?? ""}
            onChange={(event) => {
              setToDraft(event.target.value);
              setError(null);
              setNotice(null);
            }}
            data-testid="auto-update-to-input"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Fleet canary</Label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={canary.enabled}
            onChange={(event) => {
              setCanaryDraft({ ...canary, enabled: event.target.checked });
              setError(null);
              setNotice(null);
            }}
            data-testid="auto-update-canary-enabled"
          />
          Switch a share of the bots first and wait for their health
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <div className="space-y-1">
            <Label htmlFor="auto-update-share">Share, %</Label>
            <Input
              id="auto-update-share"
              className="w-24"
              value={canary.sharePercent}
              onChange={(event) => {
                setCanaryDraft({ ...canary, sharePercent: event.target.value });
                setError(null);
                setNotice(null);
              }}
              data-testid="auto-update-canary-share"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auto-update-min">Min bots</Label>
            <Input
              id="auto-update-min"
              className="w-24"
              value={canary.minBots}
              onChange={(event) => {
                setCanaryDraft({ ...canary, minBots: event.target.value });
                setError(null);
                setNotice(null);
              }}
              data-testid="auto-update-canary-min"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auto-update-max">Max bots</Label>
            <Input
              id="auto-update-max"
              className="w-24"
              value={canary.maxBots}
              onChange={(event) => {
                setCanaryDraft({ ...canary, maxBots: event.target.value });
                setError(null);
                setNotice(null);
              }}
              data-testid="auto-update-canary-max"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auto-update-settle">Health settle, s</Label>
            <Input
              id="auto-update-settle"
              className="w-28"
              value={canary.healthSettleSec}
              onChange={(event) => {
                setCanaryDraft({ ...canary, healthSettleSec: event.target.value });
                setError(null);
                setNotice(null);
              }}
              data-testid="auto-update-canary-settle"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Effective: {view.settings.canary.enabled ? "on" : "off"}, {view.settings.canary.sharePercent}% (at least{" "}
          {view.settings.canary.minBots}, at most {view.settings.canary.maxBots}) watched for{" "}
          {view.settings.canary.healthSettleSec}s ({sourceLabel(view.sources.canary)}). A canary batch that fails leaves
          the rest of the fleet on the old image.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={saveChanges} disabled={save.isPending || !changed} data-testid="auto-update-save">
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {error && (
          <p className="text-xs text-red-600" data-testid="auto-update-error">
            {error}
          </p>
        )}
        {notice && !error && <p className="text-xs text-green-600">{notice}</p>}
      </div>

      <div className="space-y-2">
        <Label>Approved releases</Label>
        <p className="text-xs text-muted-foreground">
          In automatic mode the scheduler starts a release on this list inside the window, once per approval. Approve the
          tag together with the digest you verified on the deploy screen.
        </p>
        <ul className="space-y-1 text-sm" data-testid="auto-update-approvals">
          {view.stored.approvals.length === 0 && <li className="text-muted-foreground">Nothing approved yet.</li>}
          {view.stored.approvals.map((approval) => (
            <li key={approval.tag} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{approval.tag}</span>
              {approval.version && <span className="text-muted-foreground">({approval.version})</span>}
              <span className="text-muted-foreground">approved by {approval.approvedBy.actorId}</span>
              <span className="text-muted-foreground">
                {approval.jobId ? "started a deploy" : "waiting for the window"}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => withdraw.mutate(approval.tag)}
                disabled={withdraw.isPending}
                data-testid={`auto-update-withdraw-${approval.tag}`}
              >
                Withdraw
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="auto-update-approve-tag">Release tag</Label>
            <Input
              id="auto-update-approve-tag"
              className="w-40"
              value={approveDraft.tag}
              onChange={(event) => setApproveDraft({ ...approveDraft, tag: event.target.value })}
              data-testid="auto-update-approve-tag"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auto-update-approve-digest">Image digest</Label>
            <Input
              id="auto-update-approve-digest"
              className="w-80"
              placeholder="sha256:…"
              value={approveDraft.digest}
              onChange={(event) => setApproveDraft({ ...approveDraft, digest: event.target.value })}
              data-testid="auto-update-approve-digest"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auto-update-approve-version">Version</Label>
            <Input
              id="auto-update-approve-version"
              className="w-40"
              value={approveDraft.version}
              onChange={(event) => setApproveDraft({ ...approveDraft, version: event.target.value })}
              data-testid="auto-update-approve-version"
            />
          </div>
          <Button
            size="sm"
            onClick={() => approve.mutate()}
            disabled={approve.isPending || !approveDraft.tag.trim() || !approveDraft.digest.trim()}
            data-testid="auto-update-approve"
          >
            {approve.isPending ? "Approving…" : "Approve"}
          </Button>
        </div>
      </div>
    </section>
  );
}