import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useParams } from "@/lib/router";
import { useTranslation } from "@/i18n";

const MIN_LENGTH = 8;

/** Public page behind the one-time link an administrator hands to a user (OPE-8985). */
export function PasswordSetPage() {
  const { t } = useTranslation();
  const { token = "" } = useParams<{ token: string }>();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");

  const save = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/myrmidon/users-admin-a/password-set", { token, newPassword: password }),
  });

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;
  const canSubmit = password.length >= MIN_LENGTH && repeat === password && !save.isPending;
  const linkDead = save.error instanceof ApiError && save.error.status === 404;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-lg font-semibold">{t("area.access-secrets-3.password-set.title")}</h1>
      {save.isSuccess ? (
        <div className="space-y-4" role="status">
          <p className="text-sm">{t("area.access-secrets-3.password-set.done")}</p>
          <Button asChild><a href="/auth">{t("area.access-secrets-3.password-set.signIn")}</a></Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (canSubmit) save.mutate(); }}>
          <p className="text-sm text-muted-foreground">{t("area.access-secrets-3.password-set.hint", { count: MIN_LENGTH })}</p>
          <div className="space-y-2">
            <Label htmlFor="password-set-new">{t("area.access-secrets-3.password-set.newPassword")}</Label>
            <Input id="password-set-new" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            {tooShort && <p className="text-xs text-destructive">{t("area.access-secrets-3.password-set.tooShort", { count: MIN_LENGTH })}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password-set-repeat">{t("area.access-secrets-3.password-set.repeatPassword")}</Label>
            <Input id="password-set-repeat" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
            {mismatch && <p className="text-xs text-destructive">{t("area.access-secrets-3.password-set.mismatch")}</p>}
          </div>
          {save.error && <p role="alert" className="text-sm text-destructive">{linkDead ? t("area.access-secrets-3.password-set.linkInvalid") : t("area.access-secrets-3.password-set.saveError")}</p>}
          <Button type="submit" disabled={!canSubmit}>{t("area.access-secrets-3.password-set.save")}</Button>
        </form>
      )}
    </main>
  );
}
