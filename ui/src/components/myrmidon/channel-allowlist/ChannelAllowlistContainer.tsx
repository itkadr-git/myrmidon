// myrmidon(CA-A): wire tier of the "Who may write to the bots" screen. Owns
// the react-query state (allowlist CRUD + the channel access mode) and the
// error surface; the layout lives in ChannelAllowlistScreen.tsx.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { ChannelAllowlistScreenView, type EndpointOption } from "./ChannelAllowlistScreen";
import {
  channelAllowlistApi,
  channelAllowlistQueryKey,
  type ChannelAllowlistCreateInput,
} from "./channelAllowlistApi";
import {
  channelSettingsApi,
  channelSettingsQueryKey,
  type ChannelAccessMode,
} from "./channelSettingsApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function ChannelAllowlistScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("channelAllowlist.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const listQuery = useQuery({
    queryKey: channelAllowlistQueryKey(companyId),
    queryFn: () => channelAllowlistApi.list(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });
  const settingsQuery = useQuery({
    queryKey: channelSettingsQueryKey,
    queryFn: () => channelSettingsApi.read(),
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
    onMutate: () => setError(null),
    onSuccess: refetchAll,
    onError: (err) => setError(readable(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => channelAllowlistApi.revoke(companyId, id),
    onMutate: () => setError(null),
    onSuccess: refetchAll,
    onError: (err) => setError(readable(err)),
  });
  const restore = useMutation({
    mutationFn: (id: string) => channelAllowlistApi.restore(companyId, id),
    onMutate: () => setError(null),
    onSuccess: refetchAll,
    onError: (err) => setError(readable(err)),
  });
  const saveMode = useMutation({
    mutationFn: (mode: ChannelAccessMode) => channelSettingsApi.setAccessMode(mode),
    onMutate: () => setError(null),
    onSuccess: refetchAll,
    onError: (err) => setError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-channel-allowlist-no-company">
        {t("channelAllowlist.noCompany")}
      </p>
    );
  }

  if (listQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-channel-allowlist-error">
        {readable(listQuery.error)}
      </p>
    );
  }

  const endpoints: EndpointOption[] = (endpointsQuery.data ?? []).map((endpoint) => ({
    id: endpoint.id,
    name: endpoint.botLabel ?? endpoint.providerAccountLabel ?? `${endpoint.provider} ${endpoint.id.slice(0, 8)}`,
  }));

  const modeValue = settingsQuery.data?.channelAccessMode?.value;
  const accessMode: ChannelAccessMode = modeValue === "allowlist" ? "allowlist" : "sponsor";
  const modeLocked = settingsQuery.data?.channelAccessMode?.overridden === true;

  return (
    <ChannelAllowlistScreenView
      allowedUsers={listQuery.data?.allowedUsers ?? []}
      endpoints={endpoints}
      accessMode={accessMode}
      modeLocked={modeLocked}
      onSaveMode={(mode) => saveMode.mutate(mode)}
      onAdd={(input) => add.mutate(input)}
      onRevoke={(id) => revoke.mutate(id)}
      onRestore={(id) => restore.mutate(id)}
      pending={add.isPending || revoke.isPending || restore.isPending || saveMode.isPending}
      error={error}
    />
  );
}
