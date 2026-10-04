import React, { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { botDiskApi, botDiskQueryKey } from "./botDiskApi";

interface DraftState {
  sharedPackageStore: string;
  sharedEnabled: boolean;
}

export const BotDiskSettingsPanel: React.FC = () => {
  const [draft, setDraft] = useState<DraftState>({ sharedPackageStore: "", sharedEnabled: false });
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: botDiskQueryKey,
    queryFn: () => botDiskApi.get(),
    retry: false,
  });

  // react-query v5 has no query onSuccess: seed the draft when the data arrives.
  useEffect(() => {
    if (!query.data) return;
    setDraft({
      sharedPackageStore: query.data.settings["shared.packageStore"] || "",
      sharedEnabled: query.data.settings["shared.enabled"] || false,
    });
  }, [query.data]);

  const save = useMutation({
    mutationFn: (settings: { "shared.packageStore"?: string, "shared.enabled"?: boolean }) => botDiskApi.update(settings),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the bot disk settings failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: botDiskQueryKey });
    },
  });

  const handleSave = () => {
    const settings = {
      "shared.packageStore": draft.sharedPackageStore.trim() === "" 
        ? undefined 
        : draft.sharedPackageStore.trim(),
      "shared.enabled": draft.sharedPackageStore.trim() !== ""
    };
    
    save.mutate(settings);
  };

  const isLoading = query.isLoading;
  const isSaving = save.isPending;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bot Disk Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div>Loading...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bot Disk Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        
        <div className="space-y-2">
          <Label htmlFor="sharedPackageStore">Shared Package Cache Path</Label>
          <Input
            id="sharedPackageStore"
            value={draft.sharedPackageStore}
            onChange={(e) => setDraft(prev => ({ ...prev, sharedPackageStore: e.target.value }))}
            placeholder="/mnt/shared/package-cache"
            disabled={isSaving}
          />
          <p className="text-sm text-muted-foreground">
            Path to the shared cache for pnpm, pip, go, and gradle. All bots will mount this path to share package downloads.
          </p>
        </div>
        
        <Button 
          onClick={handleSave} 
          disabled={isSaving || save.isSuccess}
        >
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </CardContent>
    </Card>
  );
};

export default BotDiskSettingsPanel;