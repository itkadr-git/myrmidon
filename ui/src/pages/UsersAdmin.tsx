import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Search, ShieldCheck, UserRoundPlus } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";

type ManagedUser = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: "instance_admin" | "member";
  blocked: boolean;
  syntheticEmail: boolean;
  createdAt: string;
};

type UserList = { users: ManagedUser[] };
type OneTimeLink = { passwordSetLink?: string | null };
const endpoint = "/myrmidon/users-admin-a/users";

export function UsersAdmin() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ManagedUser["role"]>("member");
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: t("area.access-secrets-3.users-admin.title"), href: "/company/settings/users" }]);
  }, [setBreadcrumbs, t]);

  const users = useQuery({
    queryKey: ["users-admin-a", "users"],
    queryFn: async () => {
      const result = await api.get<UserList | ManagedUser[]>(endpoint);
      return Array.isArray(result) ? { users: result } : result;
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users-admin-a", "users"] });
  const create = useMutation({
    mutationFn: () => api.post<ManagedUser & OneTimeLink>(endpoint, {
      username: username.trim(), name: name.trim(), ...(password ? { password } : {}), role,
    }),
    onSuccess: async (result) => {
      setOneTimeLink(result.passwordSetLink ?? null);
      setUsername(""); setName(""); setPassword("");
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ userId, blocked }: { userId: string; blocked: boolean }) =>
      api.patch(`${endpoint}/${encodeURIComponent(userId)}`, { blocked }),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: (userId: string) => api.patch<OneTimeLink>(`${endpoint}/${encodeURIComponent(userId)}`, { resetPassword: true }),
    onSuccess: (result) => setOneTimeLink(result.passwordSetLink ?? null),
  });

  if (users.error) {
    const message = users.error instanceof ApiError && users.error.status === 403
      ? t("area.access-secrets-3.users-admin.adminRequired")
      : users.error instanceof Error ? users.error.message : t("area.access-secrets-3.users-admin.loadError");
    return <p className="text-sm text-destructive" role="alert">{message}</p>;
  }

  const filtered = (users.data?.users ?? []).filter((user) =>
    `${user.name} ${user.username} ${user.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="max-w-6xl space-y-6">
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-3 text-primary"><ShieldCheck aria-hidden="true" /></div>
        <div><h1 className="text-lg font-semibold">{t("area.access-secrets-3.users-admin.title")}</h1><p className="text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.description")}</p></div>
      </header>
      {oneTimeLink && <Card className="space-y-3 border-primary/40 p-4" role="status">
        <h2 className="font-semibold">{t("area.access-secrets-3.users-admin.oneTimeTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.oneTimeHint")}</p>
        <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all rounded bg-muted p-2 text-xs">{oneTimeLink}</code>
          <Button onClick={() => void copyTextToClipboard(oneTimeLink).catch(() => undefined)}>{t("area.access-secrets-3.users-admin.copyLink")}</Button>
          <Button variant="outline" onClick={() => setOneTimeLink(null)}>{t("common.dismiss")}</Button></div>
      </Card>}
      <div className="grid gap-6 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.5fr)]">
        <Card className="space-y-4 p-5">
          <div className="flex items-center gap-2"><UserRoundPlus aria-hidden="true" className="h-4 w-4" /><h2 className="font-semibold">{t("area.access-secrets-3.users-admin.createUser")}</h2></div>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
            <div className="space-y-2"><Label htmlFor="managed-username">{t("area.access-secrets-3.users-admin.username")}</Label><Input id="managed-username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="managed-name">{t("area.access-secrets-3.users-admin.displayName")}</Label><Input id="managed-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor="managed-password">{t("area.access-secrets-3.users-admin.tempPassword")}</Label><Input id="managed-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /><p className="text-xs text-muted-foreground">{t("area.access-secrets-3.users-admin.tempPasswordHint")}</p></div>
            <div className="space-y-2"><Label htmlFor="managed-role">{t("area.access-secrets-3.users-admin.role")}</Label><select id="managed-role" value={role} onChange={(e) => setRole(e.target.value as ManagedUser["role"])} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="member">{t("common.user")}</option><option value="instance_admin">{t("area.access-secrets-3.users-admin.administrator")}</option></select><p className="text-xs text-muted-foreground">{t("area.access-secrets-3.users-admin.companyAccessHint")}</p></div>
            {create.error && <p role="alert" className="text-sm text-destructive">{create.error instanceof Error ? create.error.message : t("area.access-secrets-3.users-admin.createError")}</p>}
            <Button type="submit" disabled={create.isPending}><UserRoundPlus aria-hidden="true" className="mr-2 h-4 w-4" />{t("area.access-secrets-3.users-admin.createUser")}</Button>
          </form>
        </Card>
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{t("area.access-secrets-3.users-admin.directoryTitle")}</h2><p className="text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.userCount", { count: filtered.length })}</p></div>
            <div className="relative w-full max-w-xs"><Search aria-hidden="true" className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label={t("area.access-secrets-3.users-admin.searchLabel")} className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("area.access-secrets-3.users-admin.searchPlaceholder")} /></div></div>
          {users.isLoading ? <p className="py-8 text-center text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.loading")}</p> : filtered.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.empty")}</p> :
            <ul className="divide-y divide-border">{filtered.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-1">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{user.name}</span><span className="text-xs text-muted-foreground">@{user.username}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${user.blocked ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>{user.blocked ? t("area.access-secrets-3.users-admin.blocked") : user.role === "instance_admin" ? t("area.access-secrets-3.users-admin.administrator") : t("common.user")}</span></div><p className="truncate text-sm text-muted-foreground">{user.email}</p></div>
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => update.mutate({ userId: user.id, blocked: !user.blocked })} disabled={update.isPending}>{user.blocked ? t("area.access-secrets-3.users-admin.unblock") : t("area.access-secrets-3.users-admin.block")}</Button>
                <Button size="sm" variant="outline" onClick={() => reset.mutate(user.id)} disabled={reset.isPending}><KeyRound aria-hidden="true" className="mr-1 h-3.5 w-3.5" />{t("area.access-secrets-3.users-admin.resetPassword")}</Button></div>
            </li>)}</ul>}
          {(update.error || reset.error) && <p role="alert" className="text-sm text-destructive">{update.error instanceof Error ? update.error.message : reset.error instanceof Error ? reset.error.message : t("area.access-secrets-3.users-admin.updateError")}</p>}
        </Card>
      </div>
    </main>
  );
}