import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { BOARD_API_KEY_SCOPE_KINDS, type BoardApiKeyScopeKind } from "@paperclipai/shared";
import { accessApi, type BoardApiKeyRecord, type CreatedBoardApiKey } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { i18n, useTranslation } from "@/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

// myrmidon(ROLE-SCOPED-TOKENS): instance settings screen for board API keys.
// Lists every key of the signed-in board user with its scope, creates keys
// with a chosen scope, and revokes keys. The plaintext token of a newly
// created key is rendered exactly once and never refetched.

const scopeHints = (): Record<BoardApiKeyScopeKind, string> => ({
  full: i18n.t("area.access-secrets-2.board-api-keys.hintFull"),
  read_only: i18n.t("area.access-secrets-2.board-api-keys.hintReadOnly"),
  ops: i18n.t("area.access-secrets-2.board-api-keys.hintOps"),
  agents_manage: i18n.t("area.access-secrets-2.board-api-keys.hintAgentsManage"),
  secrets_manage: i18n.t("area.access-secrets-2.board-api-keys.hintSecretsManage"),
  release: i18n.t("area.access-secrets-2.board-api-keys.hintRelease"),
  monitoring_link: i18n.t("area.access-secrets-2.board-api-keys.hintMonitoringLink"),
});

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || i18n.t("area.access-secrets-2.board-api-keys.requestFailed", { status: error.status });
  if (error instanceof Error) return error.message;
  return i18n.t("area.access-secrets-2.board-api-keys.unexpectedError");
}

export function BoardApiKeysPage() {
  const { t, i18n: i18nInstance } = useTranslation();
  const formatDate = (value: string | Date) => new Date(value).toLocaleDateString(i18nInstance.language);
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<BoardApiKeyScopeKind>("read_only");
  const [created, setCreated] = useState<CreatedBoardApiKey | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.access-secrets-2.board-api-keys.breadcrumbSettings"), href: "/company/settings" },
      { label: t("area.access-secrets-2.board-api-keys.breadcrumbInstance"), href: "/company/settings/instance/general" },
      { label: t("area.access-secrets-2.board-api-keys.title") },
    ]);
  }, [setBreadcrumbs, t]);

  const keysQuery = useQuery({
    queryKey: queryKeys.access.boardApiKeys(includeInactive),
    queryFn: () => accessApi.listBoardApiKeys({ includeInactive }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      accessApi.createBoardApiKey({
        name: newName.trim() || "board key",
        scope: { kind: newScope },
      }),
    onSuccess: async (record) => {
      setCreated(record);
      setCreateError(null);
      setNewName("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardApiKeys(includeInactive) });
      pushToast({ title: t("area.access-secrets-2.board-api-keys.createdTitle"), body: t("area.access-secrets-2.board-api-keys.createdBody"), tone: "success" });
    },
    onError: (error) => setCreateError(readable(error)),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => accessApi.revokeBoardApiKey(keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardApiKeys(includeInactive) });
      pushToast({ title: t("area.access-secrets-2.board-api-keys.revokedTitle"), tone: "success" });
    },
    onError: (error) => pushToast({ title: t("area.access-secrets-2.board-api-keys.revokeFailed"), body: readable(error), tone: "error" }),
  });

  const keys = keysQuery.data ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">{t("area.access-secrets-2.board-api-keys.title")}</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("area.access-secrets-2.board-api-keys.intro")}
      </p>

      <Card className="space-y-4 p-4">
        <h2 className="text-sm font-semibold">{t("area.access-secrets-2.board-api-keys.createHeading")}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="board-key-name">{t("area.access-secrets-2.board-api-keys.nameLabel")}</Label>
            <Input
              id="board-key-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t("area.access-secrets-2.board-api-keys.namePlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="board-key-scope">{t("area.access-secrets-2.board-api-keys.scopeLabel")}</Label>
            <Select value={newScope} onValueChange={(value) => setNewScope(value as BoardApiKeyScopeKind)}>
              <SelectTrigger id="board-key-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOARD_API_KEY_SCOPE_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{scopeHints()[newScope]}</p>
          </div>
        </div>
        {createError ? <p className="text-sm text-destructive">{createError}</p> : null}
        <div className="flex justify-end">
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            {createMutation.isPending ? t("area.access-secrets-2.board-api-keys.creating") : t("area.access-secrets-2.board-api-keys.createButton")}
          </Button>
        </div>

        {created ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">{created.name}</p>
            <p className="text-xs text-muted-foreground">
              {t("area.access-secrets-2.board-api-keys.createdScope", { scope: created.scope.kind })}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {created.token}
              </code>
              <Button
                variant="outline"
                onClick={() => {
                  void copyTextToClipboard(created.token);
                  pushToast({ title: t("area.access-secrets-2.board-api-keys.tokenCopied"), tone: "success" });
                }}
              >
                {t("area.access-secrets-2.board-api-keys.copy")}
              </Button>
              <Button variant="ghost" onClick={() => setCreated(null)}>
                {t("common.dismiss")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("area.access-secrets-2.board-api-keys.keysHeading")}</h2>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            {t("area.access-secrets-2.board-api-keys.showInactive")}
          </label>
        </div>
        {keysQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : keysQuery.isError ? (
          <p className="text-sm text-destructive">{readable(keysQuery.error)}</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("area.access-secrets-2.board-api-keys.empty")}</p>
        ) : (
          <div className="space-y-2">
            {keys.map((key: BoardApiKeyRecord) => (
              <div
                key={key.id}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium">{key.name}</div>
                  <div className="text-muted-foreground">
                    {[
                      t("area.access-secrets-2.board-api-keys.rowScope", { scope: key.scope?.kind ?? "full" }),
                      t("area.access-secrets-2.board-api-keys.rowCreated", { date: formatDate(key.createdAt) }),
                      key.lastUsedAt ? t("area.access-secrets-2.board-api-keys.rowLastUsed", { date: formatDate(key.lastUsedAt) }) : null,
                      key.revokedAt ? t("area.access-secrets-2.board-api-keys.rowRevoked") : null,
                      key.expiresAt ? t("area.access-secrets-2.board-api-keys.rowExpires", { date: formatDate(key.expiresAt) }) : null,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  </div>
                </div>
                {!key.revokedAt ? (
                  <Button
                    variant="outline"
                    onClick={() => revokeMutation.mutate(key.id)}
                    disabled={revokeMutation.isPending}
                  >
                    {t("area.access-secrets-2.board-api-keys.revoke")}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
