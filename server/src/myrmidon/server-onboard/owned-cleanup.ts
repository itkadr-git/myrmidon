import type { FleetOwnershipInventory, OwnedFleetResource } from "@myrmidon/shared";
import type { SshExecutor } from "../../services/fleet/mock-ssh-executor.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const order: Record<OwnedFleetResource["kind"], number> = { role_container: 0, firewall_rule: 1, ssh_key: 2 };

export async function cleanupOwnedResources(ssh: SshExecutor, inventory: FleetOwnershipInventory, username: string): Promise<void> {
  const resources = inventory.resources.map(({ resource }) => resource).sort((a, b) => order[a.kind] - order[b.kind]);
  // Never resolve an inventory-supplied account to a path or edit another user's files.
  if (resources.some((resource) => resource.kind === "ssh_key" && resource.username !== username)) {
    throw new Error("Owned SSH key account differs from the claimed SSH account");
  }
  for (const resource of resources) {
    let command: string;
    switch (resource.kind) {
      case "role_container":
        command = `sudo -n sh -eu -c ${quote(`
id=$1
ids=$(docker container ls -aq --no-trunc)
if printf '%s\\n' "$ids" | grep -Fxq -- "$id"; then
  docker container rm -f -- "$id" >/dev/null
  ids=$(docker container ls -aq --no-trunc)
  if printf '%s\\n' "$ids" | grep -Fxq -- "$id"; then exit 1; fi
fi`)} sh ${quote(resource.containerId)}`;
        break;
      case "firewall_rule": {
        const target = resource.rule.slice("allow ".length);
        command = `sudo -n sh -eu -c ${quote(`
export LC_ALL=C
rule=$1 marker=$2
snapshot() {
  rules=$(ufw status numbered)
  test "$(printf '%s\\n' "$rules" | grep -E '^[[:space:]]*Status:' || true)" = 'Status: active'
}
snapshot
matches=$(printf '%s\\n' "$rules" | grep -E "# $marker[[:space:]]*$" || true)
[ -n "$matches" ] || exit 0
v4="^\\[[[:space:]]*[0-9]+\\][[:space:]]+$rule[[:space:]]+ALLOW IN[[:space:]]+Anywhere"
v6="^\\[[[:space:]]*[0-9]+\\][[:space:]]+$rule \\(v6\\)[[:space:]]+ALLOW IN[[:space:]]+Anywhere \\(v6\\)"
candidates=$(printf '%s\\n' "$rules" | grep -E "($v4|$v6)([[:space:]]+#.*)?[[:space:]]*$" || true)
owned=$(printf '%s\\n' "$rules" | grep -E "($v4|$v6)[[:space:]]+# $marker[[:space:]]*$" || true)
[ "$matches" = "$owned" ] && [ "$candidates" = "$owned" ] || exit 1
[ "$(printf '%s\\n' "$owned" | grep -cE "$v4[[:space:]]+#" || true)" -le 1 ]
[ "$(printf '%s\\n' "$owned" | grep -cE "$v6[[:space:]]+#" || true)" -le 1 ]
ufw --force delete allow "$rule" comment "$marker" >/dev/null
snapshot
if printf '%s\\n' "$rules" | grep -Eq "# $marker[[:space:]]*$"; then exit 1; fi`)} sh ${quote(target)} ${quote(resource.marker)}`;
        break;
      }
      case "ssh_key":
        command = `sh -eu -c ${quote(`
test "$(id -un)" = "$1"
key=$2
file=$HOME/.ssh/authorized_keys
[ ! -L "$HOME/.ssh" ] && [ ! -L "$file" ] || exit 1
[ -e "$file" ] || exit 0
[ -f "$file" ] || exit 1
if grep -Fxq -- "$key" "$file"; then
  tmp=$(mktemp "$file.myrmidon.XXXXXX")
  trap 'rm -f -- "$tmp"' EXIT
  cp -p -- "$file" "$tmp"
  status=0
  grep -Fxv -- "$key" "$file" > "$tmp" || status=$?
  [ "$status" -le 1 ]
  mv -f -- "$tmp" "$file"
else
  [ "$?" -eq 1 ]
fi`)} sh ${quote(username)} ${quote(resource.authorizedKey)}`;
        break;
    }
    const result = await ssh.execute(command);
    if (result.exitCode !== 0) throw new Error(`Owned resource cleanup failed (${resource.kind})`);
  }
}
