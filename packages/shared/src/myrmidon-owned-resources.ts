export type OwnedFleetResource =
  | { kind: "role_container"; containerId: string }
  | { kind: "ssh_key"; username: string; authorizedKey: string }
  | { kind: "firewall_rule"; backend: "ufw"; rule: string; marker: string };

export interface FleetOwnershipInventory {
  version: 1;
  companyId: string;
  serverId: string;
  resources: Array<{ jobId: string; resource: OwnedFleetResource }>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid ownership record");
  return Object.fromEntries(Object.entries(value));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error("Unexpected ownership record fields");
  }
}

export function parseOwnedFleetResource(value: unknown): OwnedFleetResource {
  const resource = object(value);
  switch (resource.kind) {
    case "role_container":
      exactKeys(resource, ["kind", "containerId"]);
      if (typeof resource.containerId !== "string" || !/^[0-9a-f]{64}$/.test(resource.containerId)) {
        throw new Error("Ownership requires a full immutable container ID");
      }
      return { kind: "role_container", containerId: resource.containerId };
    case "ssh_key":
      exactKeys(resource, ["kind", "username", "authorizedKey"]);
      if (typeof resource.username !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(resource.username) ||
          typeof resource.authorizedKey !== "string" || resource.authorizedKey.length > 16384 ||
          !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/.test(resource.authorizedKey)) {
        throw new Error("Ownership requires an exact authorized_keys line and account");
      }
      return { kind: "ssh_key", username: resource.username, authorizedKey: resource.authorizedKey };
    case "firewall_rule":
      exactKeys(resource, ["kind", "backend", "rule", "marker"]);
      if (resource.backend !== "ufw" || typeof resource.rule !== "string" ||
          !/^allow (?:[1-9][0-9]{0,4})\/(?:tcp|udp)$/.test(resource.rule) ||
          Number(resource.rule.split(" ")[1]?.split("/")[0]) > 65535 ||
          typeof resource.marker !== "string" || !/^myrmidon:[0-9a-f-]{36}:[0-9a-f-]{36}(?::[0-9a-f-]{36})?$/.test(resource.marker)) {
        throw new Error("Ownership requires a supported exact firewall rule and scoped marker");
      }
      return { kind: "firewall_rule", backend: "ufw", rule: resource.rule, marker: resource.marker };
    default:
      throw new Error("Unknown owned resource kind");
  }
}

export function parseFleetOwnershipInventory(value: unknown, companyId: string, serverId: string): FleetOwnershipInventory {
  const inventory = object(value);
  exactKeys(inventory, ["version", "companyId", "serverId", "resources"]);
  if (!uuid.test(companyId) || !uuid.test(serverId) || inventory.version !== 1 ||
      inventory.companyId !== companyId || inventory.serverId !== serverId || !Array.isArray(inventory.resources)) {
    throw new Error("Ownership inventory scope or version mismatch");
  }
  const resources = inventory.resources.map((value) => {
    const entry = object(value);
    exactKeys(entry, ["jobId", "resource"]);
    if (typeof entry.jobId !== "string" || !uuid.test(entry.jobId)) throw new Error("Invalid ownership job ID");
    const resource = parseOwnedFleetResource(entry.resource);
    const scope = `myrmidon:${companyId}:${serverId}`;
    if (resource.kind === "firewall_rule" && resource.marker !== scope &&
        !(resource.marker.startsWith(`${scope}:`) && uuid.test(resource.marker.slice(scope.length + 1)))) {
      throw new Error("Firewall ownership marker scope mismatch");
    }
    return { jobId: entry.jobId, resource };
  });
  return { version: 1, companyId, serverId, resources };
}

/** Append-only: retrying a report cannot erase resources recorded by an earlier job. */
export function appendOwnedFleetResource(
  current: unknown,
  companyId: string,
  serverId: string,
  jobId: string,
  value: unknown,
): FleetOwnershipInventory {
  const inventory = current === null
    ? { version: 1 as const, companyId, serverId, resources: [] }
    : parseFleetOwnershipInventory(current, companyId, serverId);
  const resource = parseOwnedFleetResource(value);
  const next = parseFleetOwnershipInventory({ ...inventory, resources: [...inventory.resources, { jobId, resource }] }, companyId, serverId);
  if (inventory.resources.some((entry) => JSON.stringify(entry.resource) === JSON.stringify(resource))) return inventory;
  return next;
}
