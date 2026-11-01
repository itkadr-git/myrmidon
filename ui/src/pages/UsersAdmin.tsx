import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Search, Shield, ShieldCheck, ShieldOff, UserRoundPlus } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

type AuditEntry = {
  id: string;
  action: string;
  actorId: string;
  actorName: string;
  actorUsername: string;
  targetUserId: string;
  targetName: string;
  targetUsername: string;
  details: Record<string, unknown>;
  createdAt: string;
};

type UserList = { users: ManagedUser[] };
type AuditList = { audit: AuditEntry[] };
type OneTimeLink = { passwordSetLink?: string | null };
const endpoint = "/myrmidon/users-admin-a/users";

function formatAuditDetails(action: string, details: Record<string, unknown>): string {
  if (action === "instance.user.role_changed") {
    return `${String(details.previousRole ?? "")} → ${String(details.newRole ?? "")}`;
  }
  if (action === "instance.user.created") {
    return `role: ${String(details.role ?? "member")}, mode: ${String(details.passwordMode ?? "")}`;
  }
  if (action === "instance.user.blocked" || action === "instance.user.unblocked") {
    return `sessions closed: ${String(details.sessionsClosed ?? 0)}`;
  }
  if (action === "instance.user.password_reset" || action === "instance.user.password_set") {
    return `via: ${String(details.via ?? "")}`;
  }
  return Object.keys(details).length > 0 ? JSON.stringify(details) : "—";
}

export function UsersAdmin() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<string>("users");
  const [search, setSearch] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ManagedUser["role"]>("member");
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);

  const [auditUser, setAuditUser] = useState<string>("");
  const [auditActor, setAuditActor] = useState<string>("");
  const [auditAction, setAuditAction] = useState<string>("all");

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

  const audit = useQuery({
    queryKey: ["users-admin-a", "audit", auditUser, auditActor, auditAction],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (auditUser.trim()) params.set("userId", auditUser.trim());
      if (auditActor.trim()) params.set("actorId", auditActor.trim());
      if (auditAction !== "all") params.set("action", auditAction);
      const queryStr = params.toString() ? `?${params.toString()}` : "";
      return api.get<AuditList>(`/myrmidon/users-admin-a/audit${queryStr}`);
    },
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["users-admin-a", "users"] });
    await queryClient.invalidateQueries({ queryKey: ["users-admin-a", "audit"] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<ManagedUser & OneTimeLink>(endpoint, {
        username: username.trim(),
        name: name.trim(),
        ...(password ? { password } : {}),
        role,
      }),
    onSuccess: async (result) => {
      setOneTimeLink(result.passwordSetLink ?? null);
      setUsername("");
      setName("");
      setPassword("");
      await refresh();
    },
  });

  const update = useMutation({
    mutationFn: ({
      userId,
      blocked,
      role: nextRole,
    }: {
      userId: string;
      blocked?: boolean;
      role?: ManagedUser["role"];
    }) => api.patch(`${endpoint}/${encodeURIComponent(userId)}`, { blocked, role: nextRole }),
    onSuccess: refresh,
  });

  const reset = useMutation({
    mutationFn: (userId: string) =>
      api.patch<OneTimeLink>(`${endpoint}/${encodeURIComponent(userId)}`, { resetPassword: true }),
    onSuccess: async (result) => {
      setOneTimeLink(result.passwordSetLink ?? null);
      await refresh();
    },
  });

  if (users.error) {
    const message =
      users.error instanceof ApiError && users.error.status === 403
        ? t("area.access-secrets-3.users-admin.adminRequired")
        : users.error instanceof Error
          ? users.error.message
          : t("area.access-secrets-3.users-admin.loadError");
    return (
      <p className="text-sm text-destructive" role="alert">
        {message}
      </p>
    );
  }

  const userList = users.data?.users ?? [];
  const filtered = userList.filter((user) =>
    `${user.name} ${user.username} ${user.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="max-w-6xl space-y-6">
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-3 text-primary">
          <ShieldCheck aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">{t("area.access-secrets-3.users-admin.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.description")}</p>
        </div>
      </header>

      {oneTimeLink && (
        <Card className="space-y-3 border-primary/40 p-4" role="status">
          <h2 className="font-semibold">{t("area.access-secrets-3.users-admin.oneTimeTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.oneTimeHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted p-2 text-xs">{oneTimeLink}</code>
            <Button onClick={() => void copyTextToClipboard(oneTimeLink).catch(() => undefined)}>
              {t("area.access-secrets-3.users-admin.copyLink")}
            </Button>
            <Button variant="outline" onClick={() => setOneTimeLink(null)}>
              {t("common.dismiss")}
            </Button>
          </div>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="users">{t("area.access-secrets-3.users-admin.tabUsers", "Users")}</TabsTrigger>
          <TabsTrigger value="audit">{t("area.access-secrets-3.users-admin.tabAudit", "Audit log")}</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-12">
            <Card className="space-y-4 p-5 lg:col-span-5">
              <div className="flex items-center gap-2">
                <UserRoundPlus aria-hidden="true" className="h-4 w-4" />
                <h2 className="font-semibold">{t("area.access-secrets-3.users-admin.createUser")}</h2>
              </div>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  create.mutate();
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="managed-username">{t("area.access-secrets-3.users-admin.username")}</Label>
                  <Input
                    id="managed-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="managed-name">{t("area.access-secrets-3.users-admin.displayName")}</Label>
                  <Input id="managed-name" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="managed-password">{t("area.access-secrets-3.users-admin.tempPassword")}</Label>
                  <Input
                    id="managed-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">{t("area.access-secrets-3.users-admin.tempPasswordHint")}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="managed-role">{t("area.access-secrets-3.users-admin.role")}</Label>
                  <select
                    id="managed-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as ManagedUser["role"])}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="member">{t("common.user")}</option>
                    <option value="instance_admin">{t("area.access-secrets-3.users-admin.administrator")}</option>
                  </select>
                  <p className="text-xs text-muted-foreground">{t("area.access-secrets-3.users-admin.companyAccessHint")}</p>
                </div>
                {create.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {create.error instanceof Error ? create.error.message : t("area.access-secrets-3.users-admin.createError")}
                  </p>
                )}
                <Button type="submit" disabled={create.isPending}>
                  <UserRoundPlus aria-hidden="true" className="mr-2 h-4 w-4" />
                  {t("area.access-secrets-3.users-admin.createUser")}
                </Button>
              </form>
            </Card>

            <Card className="space-y-4 p-5 lg:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{t("area.access-secrets-3.users-admin.directoryTitle")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("area.access-secrets-3.users-admin.userCount", { count: filtered.length })}
                  </p>
                </div>
                <div className="relative w-full max-w-xs">
                  <Search aria-hidden="true" className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    aria-label={t("area.access-secrets-3.users-admin.searchLabel")}
                    className="pl-9"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("area.access-secrets-3.users-admin.searchPlaceholder")}
                  />
                </div>
              </div>

              {users.isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.loading")}</p>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("area.access-secrets-3.users-admin.empty")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {filtered.map((user) => (
                    <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-1">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{user.name}</span>
                          <span className="text-xs text-muted-foreground">@{user.username}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              user.blocked
                                ? "bg-destructive/10 text-destructive"
                                : "bg-primary/10 text-primary"
                            }`}
                          >
                            {user.blocked
                              ? t("area.access-secrets-3.users-admin.blocked")
                              : user.role === "instance_admin"
                                ? t("area.access-secrets-3.users-admin.administrator")
                                : t("common.user")}
                          </span>
                        </div>
                        <p className="truncate text-sm text-muted-foreground">{user.email}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {user.role === "instance_admin" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => update.mutate({ userId: user.id, role: "member" })}
                            disabled={update.isPending}
                          >
                            <ShieldOff aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                            {t("area.access-secrets-3.users-admin.removeAdmin", "Remove admin")}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => update.mutate({ userId: user.id, role: "instance_admin" })}
                            disabled={update.isPending}
                          >
                            <Shield aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                            {t("area.access-secrets-3.users-admin.makeAdmin", "Make admin")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => update.mutate({ userId: user.id, blocked: !user.blocked })}
                          disabled={update.isPending}
                        >
                          {user.blocked
                            ? t("area.access-secrets-3.users-admin.unblock")
                            : t("area.access-secrets-3.users-admin.block")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => reset.mutate(user.id)}
                          disabled={reset.isPending}
                        >
                          <KeyRound aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                          {t("area.access-secrets-3.users-admin.resetPassword")}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {(update.error || reset.error) && (
                <p role="alert" className="text-sm text-destructive">
                  {update.error instanceof Error
                    ? update.error.message
                    : reset.error instanceof Error
                      ? reset.error.message
                      : t("area.access-secrets-3.users-admin.updateError")}
                </p>
              )}
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="audit" className="space-y-6">
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold">{t("area.access-secrets-3.users-admin.tabAudit", "Audit log")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("area.access-secrets-3.users-admin.description")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-48">
                  <select
                    aria-label={t("area.access-secrets-3.users-admin.auditFilterUser", "Filter by user")}
                    value={auditUser}
                    onChange={(e) => setAuditUser(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{t("area.access-secrets-3.users-admin.auditFilterAll", "All users")}</option>
                    {userList.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} (@{u.username})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-48">
                  <select
                    aria-label={t("area.access-secrets-3.users-admin.auditFilterActor", "Filter by author")}
                    value={auditActor}
                    onChange={(e) => setAuditActor(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{t("area.access-secrets-3.users-admin.auditFilterAll", "All authors")}</option>
                    {userList.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} (@{u.username})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-48">
                  <select
                    aria-label={t("area.access-secrets-3.users-admin.auditAction", "Action")}
                    value={auditAction}
                    onChange={(e) => setAuditAction(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="all">{t("area.access-secrets-3.users-admin.auditFilterAll", "All actions")}</option>
                    <option value="instance.user.created">
                      {t("area.access-secrets-3.users-admin.actionCreated", "Created")}
                    </option>
                    <option value="instance.user.blocked">
                      {t("area.access-secrets-3.users-admin.actionBlocked", "Blocked")}
                    </option>
                    <option value="instance.user.unblocked">
                      {t("area.access-secrets-3.users-admin.actionUnblocked", "Unblocked")}
                    </option>
                    <option value="instance.user.password_reset">
                      {t("area.access-secrets-3.users-admin.actionPasswordReset", "Reset link")}
                    </option>
                    <option value="instance.user.password_set">
                      {t("area.access-secrets-3.users-admin.actionPasswordSet", "Password set")}
                    </option>
                    <option value="instance.user.role_changed">
                      {t("area.access-secrets-3.users-admin.actionRoleChanged", "Role changed")}
                    </option>
                  </select>
                </div>
              </div>
            </div>

            {audit.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("area.access-secrets-3.users-admin.auditLoading", "Loading audit log…")}
              </p>
            ) : audit.error ? (
              <p role="alert" className="py-8 text-center text-sm text-destructive">
                {audit.error instanceof Error
                  ? audit.error.message
                  : t("area.access-secrets-3.users-admin.auditError", "Unable to load audit log.")}
              </p>
            ) : (audit.data?.audit ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("area.access-secrets-3.users-admin.auditEmpty", "No audit records found.")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="py-2 pr-4">{t("area.access-secrets-3.users-admin.auditTime", "Time")}</th>
                      <th className="py-2 pr-4">{t("area.access-secrets-3.users-admin.auditAction", "Action")}</th>
                      <th className="py-2 pr-4">{t("area.access-secrets-3.users-admin.auditTarget", "Target user")}</th>
                      <th className="py-2 pr-4">{t("area.access-secrets-3.users-admin.auditAuthor", "Author")}</th>
                      <th className="py-2">{t("area.access-secrets-3.users-admin.auditDetails", "Details")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {audit.data?.audit.map((item) => (
                      <tr key={item.id} className="py-3">
                        <td className="whitespace-nowrap py-3 pr-4 text-xs text-muted-foreground">
                          {new Date(item.createdAt).toLocaleString()}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant="outline">{item.action.replace("instance.user.", "")}</Badge>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium">{item.targetName}</div>
                          <div className="text-xs text-muted-foreground">@{item.targetUsername}</div>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium">{item.actorName}</div>
                          <div className="text-xs text-muted-foreground">@{item.actorUsername}</div>
                        </td>
                        <td className="py-3 text-xs text-muted-foreground">
                          {formatAuditDetails(item.action, item.details)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  );
}