// Plugin entitlement keys (myrmidon PLUGIN-ENTITLEMENT C): the instance admin
// accepts a key per plugin and sees which plugins are unlocked, until when.
// Accepting or removing a key applies without a restart — the loader gate
// re-reads the settings row on every activation pass.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { pluginEntitlementApi, pluginEntitlementPublicKeyQueryKey, pluginEntitlementQueryKey } from "./pluginEntitlementApi";
import type { PluginEntitlementKeyView } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";

function formatExpiry(value: PluginEntitlementKeyView["expiresAt"]): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function PluginEntitlementSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pluginId, setPluginId] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [publicKeyValue, setPublicKeyValue] = useState("");
  const [publicKeyError, setPublicKeyError] = useState<string | null>(null);

  const { data: keys, isLoading } = useQuery({
    queryKey: pluginEntitlementQueryKey,
    queryFn: pluginEntitlementApi.list,
  });

  const { data: publicKey } = useQuery({
    queryKey: pluginEntitlementPublicKeyQueryKey,
    queryFn: pluginEntitlementApi.getPublicKey,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: pluginEntitlementQueryKey });
  };

  const refreshPublicKey = () => {
    void queryClient.invalidateQueries({ queryKey: pluginEntitlementPublicKeyQueryKey });
  };

  const accept = useMutation({
    mutationFn: () => pluginEntitlementApi.accept({ pluginId: pluginId.trim(), key: keyValue.trim() }),
    onSuccess: () => {
      setError(null);
      setPluginId("");
      setKeyValue("");
      refresh();
    },
    onError: (err: unknown) => {
      // The server answers 400 with the failure reason (bad signature,
      // expired, wrong instance, wrong plugin) — show it as-is so the admin
      // knows why the key was rejected.
      setError(err instanceof Error ? err.message : t("pluginEntitlement.saveFailed"));
    },
  });

  const savePublicKey = useMutation({
    mutationFn: () => pluginEntitlementApi.setPublicKey(publicKeyValue.trim() ? publicKeyValue.trim() : null),
    onSuccess: () => {
      setPublicKeyError(null);
      setPublicKeyValue("");
      refreshPublicKey();
    },
    onError: (err: unknown) => {
      setPublicKeyError(err instanceof Error ? err.message : t("pluginEntitlement.publicKeySaveFailed"));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => pluginEntitlementApi.remove(id),
    onSuccess: refresh,
  });

  const submit = () => {
    const trimmedId = pluginId.trim();
    const trimmedKey = keyValue.trim();
    if (!trimmedId || !trimmedKey) return;
    accept.mutate();
  };

  const now = Date.now();
  const entries = keys ?? [];

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="plugin-entitlement-panel">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("pluginEntitlement.title")}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t("pluginEntitlement.description")}</p>

      {entries.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="plugin-entitlement-empty">
          {t("pluginEntitlement.noKeysMessage")}
        </p>
      )}

      {entries.length > 0 && (
        <ul className="space-y-2" data-testid="plugin-entitlement-list">
          {entries.map((entry) => {
            const rawExpiry = entry.expiresAt;
            const expiresMs =
              rawExpiry === null || rawExpiry === undefined
                ? null
                : new Date(rawExpiry instanceof Date ? rawExpiry.toISOString() : String(rawExpiry)).getTime();
            const expiry = expiresMs === null ? null : formatExpiry(new Date(expiresMs).toISOString());
            const expired = expiresMs !== null && expiresMs <= now;
            return (
              <li
                key={entry.pluginId}
                className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
                data-testid="plugin-entitlement-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">{entry.pluginId}</p>
                  <p className="text-xs text-muted-foreground">
                    {expired
                      ? t("pluginEntitlement.statusExpired")
                      : expiry === null
                        ? t("pluginEntitlement.neverExpires")
                        : t("pluginEntitlement.expiresOn", { date: expiry })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {expired && (
                    <span
                      className="rounded bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-600"
                      data-testid="plugin-entitlement-expired"
                    >
                      {t("pluginEntitlement.statusExpired")}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => remove.mutate(entry.pluginId)}
                    disabled={remove.isPending}
                    data-testid="plugin-entitlement-remove"
                  >
                    {t("pluginEntitlement.removeKeyButton")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2">
        <Label htmlFor="plugin-entitlement-plugin-id">{t("pluginEntitlement.pluginIdLabel")}</Label>
        <Input
          id="plugin-entitlement-plugin-id"
          placeholder={t("pluginEntitlement.pluginIdPlaceholder")}
          value={pluginId}
          onChange={(event) => {
            setPluginId(event.target.value);
            setError(null);
          }}
          data-testid="plugin-entitlement-plugin-id-input"
        />
        <Label htmlFor="plugin-entitlement-key">{t("pluginEntitlement.keyLabel")}</Label>
        <Input
          id="plugin-entitlement-key"
          placeholder={t("pluginEntitlement.keyPlaceholder")}
          value={keyValue}
          onChange={(event) => {
            setKeyValue(event.target.value);
            setError(null);
          }}
          data-testid="plugin-entitlement-key-input"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={accept.isPending || !pluginId.trim() || !keyValue.trim()} data-testid="plugin-entitlement-add">
            {t("pluginEntitlement.addKeyButton")}
          </Button>
          {error && <p className="text-xs text-red-600" data-testid="plugin-entitlement-error">{error}</p>}
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <Label htmlFor="plugin-entitlement-public-key">{t("pluginEntitlement.publicKeyLabel")}</Label>
        <p className="text-xs text-muted-foreground" data-testid="plugin-entitlement-public-key-source">
          {publicKey?.publicKey
            ? t(
                publicKey.source === "env"
                  ? "pluginEntitlement.publicKeySourceEnv"
                  : "pluginEntitlement.publicKeySourceSettings",
              )
            : t("pluginEntitlement.publicKeySourceNone")}
        </p>
        <Textarea
          id="plugin-entitlement-public-key"
          placeholder={t("pluginEntitlement.publicKeyPlaceholder")}
          value={publicKeyValue}
          rows={4}
          onChange={(event) => {
            setPublicKeyValue(event.target.value);
            setPublicKeyError(null);
          }}
          data-testid="plugin-entitlement-public-key-input"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => savePublicKey.mutate()}
            disabled={savePublicKey.isPending}
            data-testid="plugin-entitlement-public-key-save"
          >
            {t("pluginEntitlement.publicKeySaveButton")}
          </Button>
          {publicKeyError && (
            <p className="text-xs text-red-600" data-testid="plugin-entitlement-public-key-error">{publicKeyError}</p>
          )}
        </div>
      </div>
    </section>
  );
}
