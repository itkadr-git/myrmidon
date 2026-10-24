import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";

export function AdminUsers() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(""),
    queryFn: () => accessApi.searchAdminUsers(""),
    retry: false,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Users" }]);
  }, [setBreadcrumbs]);

  if (usersQuery.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading users…</p>;
  if (usersQuery.isError) {
    const message = usersQuery.error instanceof ApiError && usersQuery.error.status === 403
      ? "Instance admin access is required to view users."
      : "Failed to load users.";
    return <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{message}</p><Button onClick={() => void usersQuery.refetch()}>Try again</Button></div>;
  }
  if (usersQuery.data.length === 0) return <p className="text-sm text-muted-foreground">No users found.</p>;

  return <section className="max-w-5xl space-y-4">
    <div><h1 className="text-lg font-semibold">Users</h1><p className="text-sm text-muted-foreground">People with access to this instance.</p></div>
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-4 py-3 font-medium">User</th><th className="px-4 py-3 font-medium">Email</th><th className="px-4 py-3 font-medium">Instance role</th><th className="px-4 py-3 font-medium">Organizations</th></tr></thead>
        <tbody>{usersQuery.data.map((user) => <tr key={user.id} className="border-t">
          <td className="px-4 py-3 font-medium">{user.name || user.email || "Unnamed user"}</td>
          <td className="px-4 py-3">{user.email || "—"}</td>
          <td className="px-4 py-3">{user.isInstanceAdmin ? "Instance admin" : "User"}</td>
          <td className="px-4 py-3">{user.activeCompanyMembershipCount}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}