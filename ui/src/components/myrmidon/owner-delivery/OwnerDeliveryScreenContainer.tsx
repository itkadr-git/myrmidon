// myrmidon(1.6.5-OWNER-DM-FILTER): wire tier of the "Owner Telegram delivery"
// settings screen. Owns the react-query state — the settings GET and the mode
// PATCH — plus the error surfaces; the layout lives in OwnerDeliveryScreen.tsx.
//
// The endpoint is instance-wide (instance admins only), so the screen needs no
// selected company.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { OwnerDeliveryScreenView } from "./OwnerDeliveryScreen";
import {
  ownerDeliveryApi,
  ownerDeliverySettingsQueryKey,
  type OwnerDeliverySettings,
} from "./ownerDeliveryApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function OwnerDeliveryScreen() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Owner Telegram delivery" }]);
  }, [setBreadcrumbs]);

  const settingsQuery = useQuery({
    queryKey: ownerDeliverySettingsQueryKey,
    queryFn: () => ownerDeliveryApi.getSettings(),
    retry: false,
  });

  const save = useMutation({
    mutationFn: (next: OwnerDeliverySettings) => ownerDeliveryApi.updateSettings(next),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ownerDeliverySettingsQueryKey });
    },
    onError: (err) => setError(readable(err)),
  });

  if (settingsQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-owner-delivery-error">
        {readable(settingsQuery.error)}
      </p>
    );
  }

  return (
    <OwnerDeliveryScreenView
      settings={settingsQuery.data}
      onSave={(next) => save.mutate(next)}
      pending={save.isPending}
      error={error}
    />
  );
}