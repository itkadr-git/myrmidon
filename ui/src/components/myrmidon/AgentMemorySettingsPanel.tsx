// Agent memory (myrmidon MEMORY-UI): the memory service behind the agent card
// Memory tab. Saving applies on the next request, without a restart. The API key
// is optional: a service without authentication needs none.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import type { PatchAgentMemorySettings } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agentMemoryApi, agentMemoryQueryKey, type AgentMemorySettingsView } from "./agentMemoryApi";

interface Draft {
  enabled: boolean;
  apiUrl: string;
  keySecretName: string;
}

const SOURCE_LABEL = {
  setting: "this setting",
  env: "the server environment",
  "bot-env": "the bot containers' memory address",
} as const;

function toDraft(view: AgentMemorySettingsView): Draft {
  return {
    enabled: view.settings.enabled !== false,
    apiUrl: view.settings.apiUrl ?? "",
    keySecretName: view.settings.keySecretName ?? "",
  };
}

/** An empty field clears the value (the environment applies again); an address must be http(s). */
export function buildAgentMemoryPatch(draft: Draft): { patch: PatchAgentMemorySettings | null; urlError: string | null } {
  const apiUrl = draft.apiUrl.trim();
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      return { patch: null, urlError: "Enter an http(s):// address, or leave it empty" };
    }
  }
  return {
    patch: {
      // `true` is the default, so it is stored as "not set".
      enabled: draft.enabled ? null : false,
      apiUrl: apiUrl || null,
      keySecretName: draft.keySecretName.trim() || null,
    },
    urlError: null,
  };
}

export function AgentMemorySettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: AgentMemorySettingsView | null | undefined;
  onSave: (patch: PatchAgentMemorySettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = draft ?? (view ? toDraft(view) : null);
  const built = current ? buildAgentMemoryPatch(current) : { patch: null, urlError: null };

  return (
    <section className="space-y-4" data-testid="myrmidon-agent-memory">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Agent memory</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The shared memory service behind the Memory tab on an agent card. Saving applies on the next
          request, without a restart. Leave a field empty to use the server environment.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && current ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2 flex items-center gap-2">
            <input
              id="agent-memory-enabled"
              type="checkbox"
              checked={current.enabled}
              onChange={(event) => setDraft({ ...current, enabled: event.target.checked })}
            />
            <Label htmlFor="agent-memory-enabled">Show agent memory on agent cards</Label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-memory-url">Service address</Label>
            <Input
              id="agent-memory-url"
              placeholder="http://host:port"
              value={current.apiUrl}
              onChange={(event) => setDraft({ ...current, apiUrl: event.target.value })}
            />
            {built.urlError ? (
              <div className="text-xs text-destructive" data-testid="agent-memory-error-url">
                {built.urlError}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Empty = the server environment, then the bot containers&apos; memory address.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-memory-key">API key secret name (optional)</Label>
            <Input
              id="agent-memory-key"
              placeholder="No key"
              value={current.keySecretName}
              onChange={(event) => setDraft({ ...current, keySecretName: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Name of the company secret with the key. Empty = no key is sent (a service without authentication).
            </p>
          </div>
          <div className="md:col-span-2 text-xs text-muted-foreground" data-testid="agent-memory-effective">
            {view.effective.enabled && view.effective.apiUrl
              ? `In force: on, address from ${view.effective.urlSource ? SOURCE_LABEL[view.effective.urlSource] : "unknown"}${
                  view.effective.keySecretName ? ", with a key" : ", no key"
                }.`
              : "In force: off (no address is configured, or the switch is off)."}
          </div>
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || built.patch === null}
              onClick={() => {
                if (built.patch) onSave(built.patch);
              }}
            >
              {pending ? "Saving..." : "Save agent memory"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading agent memory settings...</p>
      )}
    </section>
  );
}

export function AgentMemorySettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: agentMemoryQueryKey,
    queryFn: () => agentMemoryApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: agentMemoryApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the agent memory settings failed."),
    onSuccess: async () => {
      setError(null);
      // Prefix key: also refreshes every agent card's Memory tab status.
      await queryClient.invalidateQueries({ queryKey: agentMemoryQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load agent memory settings."}
      </div>
    );
  }

  return (
    <AgentMemorySettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
