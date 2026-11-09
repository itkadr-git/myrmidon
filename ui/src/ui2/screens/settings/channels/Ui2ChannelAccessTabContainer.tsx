// ui/src/ui2/screens/settings/channels/Ui2ChannelAccessTabContainer.tsx
//
// myrmidon(UI2-CHANNELS): wire tier of the Channel access tab (OPE-10143).
// Owns the react-query state — the instance channel access mode (GET/PATCH
// /myrmidon/channel-settings), the channel allowlist CRUD, the bot endpoint
// list for the endpoint scope select, and the error surface — and renders
// Ui2ChannelAccessTabView. Errors surface as a message; the tab never white-
// screens on a failed request.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { Ui2ErrorState, Ui2SkeletonRows } from "../../../components/ui2StateViews";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2ChannelAccessTabView, type Ui2ChannelAccessMode, type Ui2ChannelEndpointOption } from "./Ui2ChannelAccessTab";
import {
  channelAllowlistApi,
  channelAllowlistQueryKey,
  channelSettingsApi,
  channelSettingsQueryKey,
  chatEndpointsApi,
  type ChannelAllowlistCreateInput,
} from "./ui2ChannelAccessTabApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function Ui2ChannelAccessTabContainer() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const [actionError, setActionError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: channelSettingsQueryKey,
    queryFn: () => channelSettingsApi.read(),
    retry: false,
  });
  const listQuery = useQuery({
    queryKey: channelAllowlistQueryKey(companyId),
    queryFn: () => channelAllowlistApi.list(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });
  const endpointsQuery = useQuery({
    queryKey: ["chat-endpoints", companyId],
    queryFn: () => chatEndpointsApi.list(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const refetchAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: channelAllowlistQueryKey(companyId) }),
      queryClient.invalidateQueries({ queryKey: channelSettingsQueryKey }),
    ]);
  };

  const add = useMutation({
    mutationFn: (input: ChannelAllowlistCreateInput) => channelAllowlistApi.create(companyId, input),
    onMutate: () => setActionError(null),
    onSuccess: refetchAll,
    onError: (err) => setActionError(readable(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => channelAllowlistApi.revoke(companyId, id),
    onMutate: () => setActionError(null),
    onSuccess: refetchAll,
    onError: (err) => setActionError(readable(err)),
  });
  const restore = useMutation({
    mutationFn: (id: string) => channelAllowlistApi.restore(companyId, id),
    onMutate: () => setActionError(null),
    onSuccess: refetchAll,
    onError: (err) => setActionError(readable(err)),
  });
  const saveMode = useMutation({
    mutationFn: (mode: Ui2ChannelAccessMode) => channelSettingsApi.setAccessMode(mode),
    onMutate: () => setActionError(null),
    onSuccess: refetchAll,
    onError: (err) => setActionError(readable(err)),
  });

  if (settingsQuery.isLoading) {
    return (
      <div data-testid="ui2-channel-access-loading" className="space-y-4">
        <Ui2SkeletonRows rows={4} />
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div data-testid="ui2-channel-access-load-error">
        <Ui2ErrorState
          message={t("ui2.settings.channels.access.loadError")}
          detail={
            settingsQuery.error instanceof Error
              ? settingsQuery.error.message
              : t("ui2.settings.channels.access.loadErrorDetail")
          }
          retryLabel={t("ui2.settings.channels.access.retry")}
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ui2-channel-access-no-company">
        {t("ui2.settings.channels.access.noCompany")}
      </p>
    );
  }

  const endpoints: Ui2ChannelEndpointOption[] = (endpointsQuery.data ?? []).map((endpoint) => ({
    id: endpoint.id,
    name: endpoint.botLabel ?? endpoint.providerAccountLabel ?? `${endpoint.provider} ${endpoint.id.slice(0, 8)}`,
  }));

  const modeValue = settingsQuery.data.channelAccessMode?.value;
  const accessMode: Ui2ChannelAccessMode = modeValue === "allowlist" ? "allowlist" : "sponsor";
  const modeLocked = settingsQuery.data.channelAccessMode?.overridden === true;

  return (
    <Ui2ChannelAccessTabView
      accessMode={accessMode}
      modeLocked={modeLocked}
      onSaveMode={(mode) => saveMode.mutate(mode)}
      allowedUsers={listQuery.data?.allowedUsers ?? []}
      endpoints={endpoints}
      onAdd={(input) => add.mutate(input)}
      onRevoke={(id) => revoke.mutate(id)}
      onRestore={(id) => restore.mutate(id)}
      pending={add.isPending || revoke.isPending || restore.isPending || saveMode.isPending}
      error={actionError}
    />
  );
}
