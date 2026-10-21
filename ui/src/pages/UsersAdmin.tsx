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
  const [search, setSearch] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ManagedUser["role"]>("member");
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Users", href: "/company/settings/users" }]);
  }, [setBreadcrumbs]);

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
      ? "Instance administrator access is required to manage users."
      : users.error instanceof Error ? users.error.message : "Unable to load users.";
    return <p className="text-sm text-destructive" role="alert">{message}</p>;
  }

  const filtered = (users.data?.users ?? []).filter((user) =>
    `${user.name} ${user.username} ${user.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="max-w-6xl space-y-6">
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-3 text-primary"><ShieldCheck aria-hidden="true" /></div>
        <div><h1 className="text-lg font-semibold">Users</h1><p className="text-sm text-muted-foreground">Create and manage board users. Self-registration is disabled.</p></div>
      </header>
      {oneTimeLink && <Card className="space-y-3 border-primary/40 p-4" role="status">
        <h2 className="font-semibold">One-time password setup link</h2>
        <p className="text-sm text-muted-foreground">Copy this link now. It is shown only once and is not retained here.</p>
        <div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all rounded bg-muted p-2 text-xs">{oneTimeLink}</code>
          <Button onClick={() => void copyTextToClipboard(oneTimeLink)}>Copy link</Button>
          <Button variant="outline" onClick={() => setOneTimeLink(null)}>Dismiss</Button></div>
      </Card>}
      <div className="grid gap-6 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.5fr)]">
        <Card className="space-y-4 p-5">
          <div className="flex items-center gap-2"><UserRoundPlus aria-hidden="true" className="h-4 w-4" /><h2 className="font-semibold">Create user</h2></div>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
            <div className="space-y-2"><Label htmlFor="managed-username">Username</Label><Input id="managed-username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="managed-name">Display name</Label><Input id="managed-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor="managed-password">Temporary password (optional)</Label><Input id="managed-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /><p className="text-xs text-muted-foreground">Leave blank to issue a one-time setup link.</p></div>
            <div className="space-y-2"><Label htmlFor="managed-role">Role</Label><select id="managed-role" value={role} onChange={(e) => setRole(e.target.value as ManagedUser["role"])} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="member">User</option><option value="instance_admin">Administrator</option></select></div>
            {create.error && <p role="alert" className="text-sm text-destructive">{create.error instanceof Error ? create.error.message : "Unable to create user."}</p>}
            <Button type="submit" disabled={create.isPending}><UserRoundPlus aria-hidden="true" className="mr-2 h-4 w-4" />Create user</Button>
          </form>
        </Card>
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">User directory</h2><p className="text-sm text-muted-foreground">{filtered.length} {filtered.length === 1 ? "user" : "users"}</p></div>
            <div className="relative w-full max-w-xs"><Search aria-hidden="true" className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search users" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or username" /></div></div>
          {users.isLoading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading users…</p> : filtered.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No users found.</p> :
            <ul className="divide-y divide-border">{filtered.map((user) => <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-1">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{user.name}</span><span className="text-xs text-muted-foreground">@{user.username}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${user.blocked ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>{user.blocked ? "Blocked" : user.role === "instance_admin" ? "Administrator" : "User"}</span></div><p className="truncate text-sm text-muted-foreground">{user.email}</p></div>
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => update.mutate({ userId: user.id, blocked: !user.blocked })} disabled={update.isPending}>{user.blocked ? "Unblock" : "Block"}</Button>
                <Button size="sm" variant="outline" onClick={() => reset.mutate(user.id)} disabled={reset.isPending}><KeyRound aria-hidden="true" className="mr-1 h-3.5 w-3.5" />Reset password</Button></div>
            </li>)}</ul>}
          {(update.error || reset.error) && <p role="alert" className="text-sm text-destructive">{update.error instanceof Error ? update.error.message : reset.error instanceof Error ? reset.error.message : "Unable to update user."}</p>}
        </Card>
      </div>
    </main>
  );
}